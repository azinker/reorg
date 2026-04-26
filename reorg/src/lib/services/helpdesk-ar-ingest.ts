/**
 * Helpdesk ingest for Auto-Responder sends.
 *
 * Background
 * ----------
 * The Auto-Responder calls eBay's `AddMemberMessageAAQToPartner` to send
 * the "Great News!" shipped notification. eBay's response payload for
 * that call does NOT echo back a MessageID we can pin to the send, so
 * the helpdesk-ebay-sync's "AR-tagging by externalMessageId lookup"
 * path is a no-op for these sends — every AR-sent envelope eventually
 * reaches the Sent-folder poll as an undifferentiated outbound EBAY
 * message and the AUTO_RESPONDER source label never sticks.
 *
 * Even worse, if the Sent-folder poll misses the message (cron outage,
 * eBay pagination boundary, etc.), the AR send is invisible to agents
 * forever — only the buyer's reply shows up later, with no record that
 * we already wrote to them.
 *
 * Fix
 * ---
 * After every successful AR send, write a HelpdeskMessage directly,
 * upserting the canonical `ord:<order>|buyer:<lower>` ticket if needed.
 * Then run the user's enabled Helpdesk filters against the new message
 * so the "Auto Responder Initial Message" rule archives it on the spot
 * — no waiting for a sync cycle.
 *
 * Why a separate file
 * -------------------
 * Both the live AR worker (`auto-responder.ts`) and the retro-backfill
 * script need this path. Keeping it in its own module avoids a circular
 * dependency between the AR service and the helpdesk filter engine, and
 * lets the script test the function in isolation.
 */
import {
  HelpdeskMessageDirection,
  HelpdeskMessageSource,
  HelpdeskTicketKind,
  HelpdeskTicketStatus,
  type Integration,
  type Platform,
  type Prisma,
} from "@prisma/client";

import { db } from "@/lib/db";
import { hashBodyForMatch } from "@/lib/helpdesk/ebay-digest-parser";
import { applyFilterAction, pickMatchingFilters } from "@/lib/helpdesk/filters";

export interface RecordArSendInput {
  integration: Pick<Integration, "id" | "platform" | "label">;
  orderNumber: string;
  /** eBay buyer user id (the recipientId of AddMemberMessageAAQToPartner). */
  buyerUserId: string;
  /** Optional buyer display name pulled from the order during render. */
  buyerName?: string | null;
  /** Optional buyer email if known (rarely available for AR). */
  buyerEmail?: string | null;
  /** eBay item id the AR was sent against. */
  itemId: string;
  /** Optional item title for the ticket subject fallback. */
  itemTitle?: string | null;
  /** Subject as rendered to eBay (ends up on HelpdeskMessage.subject). */
  subject: string;
  /** Plain-text body as rendered to eBay (also goes onto bodyText). */
  body: string;
  /** When the eBay send actually succeeded. */
  sentAt: Date;
  /**
   * Tracking back to the AR audit row so we can dedupe across re-runs of
   * the backfill script. Stored on `HelpdeskMessage.externalId`.
   */
  sendLogId: string;
}

export interface RecordArSendResult {
  ticketId: string;
  messageId: string;
  /** True when we synthesized a new HelpdeskTicket for this AR send. */
  ticketCreated: boolean;
  /** True when an existing message with the same `externalId` was found
   *  and reused (idempotent backfill behavior). */
  alreadyExisted: boolean;
  /** Filter ids that matched & were applied (e.g., the auto-archive rule). */
  appliedFilterIds: string[];
}

/**
 * Idempotent: callers (including a backfill script that may run twice)
 * can invoke this with the same `sendLogId` and the second call will
 * be a no-op except for re-checking filters.
 *
 * Threading is intentionally identical to the eBay-sync path:
 *   ord:<orderNumber>|buyer:<buyerUserId-lower>
 * so a ticket created here will merge cleanly with any inbound buyer
 * reply that lands in `helpdesk-ebay-sync.ts` later.
 */
export async function recordAutoResponderHelpdeskMessage(
  input: RecordArSendInput,
): Promise<RecordArSendResult> {
  const buyerLower = input.buyerUserId.trim().toLowerCase();
  if (!buyerLower) {
    throw new Error("recordAutoResponderHelpdeskMessage: buyerUserId required");
  }
  const threadKey = `ord:${input.orderNumber}|buyer:${buyerLower}`;
  const externalId = `ar-send:${input.sendLogId}`;

  // 1. Idempotency: did we already record this exact AR send?
  const existing = await db.helpdeskMessage.findFirst({
    where: { externalId },
    select: { id: true, ticketId: true },
  });
  if (existing) {
    return {
      ticketId: existing.ticketId,
      messageId: existing.id,
      ticketCreated: false,
      alreadyExisted: true,
      appliedFilterIds: [],
    };
  }

  // 2. Resolve / create the canonical ticket. Mirror the
  //    eBay-sync semantics so the row looks identical to a
  //    sync-ingested ticket — except the very first message lives in
  //    WAITING (we just wrote to the buyer; ball is in their court).
  let ticket = await db.helpdeskTicket.findUnique({
    where: {
      integrationId_threadKey: {
        integrationId: input.integration.id,
        threadKey,
      },
    },
  });
  let ticketCreated = false;
  if (!ticket) {
    ticket = await db.helpdeskTicket.create({
      data: {
        integrationId: input.integration.id,
        channel: input.integration.platform as Platform,
        threadKey,
        buyerUserId: input.buyerUserId,
        buyerName: input.buyerName ?? null,
        buyerEmail: input.buyerEmail ?? null,
        ebayItemId: input.itemId,
        ebayItemTitle: input.itemTitle ?? null,
        ebayOrderNumber: input.orderNumber,
        subject: input.subject,
        kind: HelpdeskTicketKind.POST_SALES,
        status: HelpdeskTicketStatus.WAITING,
        lastAgentMessageAt: input.sentAt,
        firstResponseAt: input.sentAt,
        unreadCount: 0,
      },
    });
    ticketCreated = true;
  } else {
    // Update bookkeeping on existing ticket. We DON'T touch status
    // here when the buyer has subsequent inbound activity — let the
    // existing reverse-adoption + status-routing logic handle that
    // when their reply arrives. This keeps backfill safe to re-run
    // on tickets that already merged correctly.
    const update: Prisma.HelpdeskTicketUpdateInput = {
      lastAgentMessageAt:
        ticket.lastAgentMessageAt && ticket.lastAgentMessageAt > input.sentAt
          ? ticket.lastAgentMessageAt
          : input.sentAt,
    };
    if (!ticket.firstResponseAt || ticket.firstResponseAt > input.sentAt) {
      update.firstResponseAt = input.sentAt;
    }
    if (!ticket.ebayItemId) update.ebayItemId = input.itemId;
    if (!ticket.ebayItemTitle && input.itemTitle) update.ebayItemTitle = input.itemTitle;
    if (!ticket.buyerName && input.buyerName) update.buyerName = input.buyerName;
    ticket = await db.helpdeskTicket.update({
      where: { id: ticket.id },
      data: update,
    });
  }

  // 3. Insert or adopt the AR HelpdeskMessage. eBay didn't give us a
  //    MessageID, so live sends usually synthesize a stable externalId from
  //    the send log row id. Historical backfills may find the same outbound
  //    already synced from eBay; when that happens, promote it instead of
  //    creating a duplicate visible bubble.
  const reusable = await findReusableAutoResponderMessage({
    ticketId: ticket.id,
    body: input.body,
    sentAt: input.sentAt,
  });
  const message = reusable
    ? await db.helpdeskMessage.update({
        where: { id: reusable.id },
        data: {
          source: HelpdeskMessageSource.AUTO_RESPONDER,
          subject: reusable.subject || input.subject,
          fromName:
            reusable.fromName ??
            (input.integration.label
              ? `${input.integration.label} Auto Responder`
              : "Auto Responder"),
          rawData: mergeMessageRawData(reusable.rawData, {
            source: "auto_responder",
            sendLogId: input.sendLogId,
            syntheticExternalId: externalId,
            orderNumber: input.orderNumber,
            itemId: input.itemId,
          }),
        },
        select: {
          id: true,
          subject: true,
          bodyText: true,
          fromName: true,
          fromIdentifier: true,
        },
      })
    : await db.helpdeskMessage.create({
        data: {
          ticketId: ticket.id,
          direction: HelpdeskMessageDirection.OUTBOUND,
          source: HelpdeskMessageSource.AUTO_RESPONDER,
          externalId,
          ebayMessageId: null, // eBay doesn't return one for AAQToPartner
          authorUserId: null,
          fromName: input.integration.label
            ? `${input.integration.label} Auto Responder`
            : "Auto Responder",
          fromIdentifier: null,
          subject: input.subject,
          bodyText: input.body,
          isHtml: false,
          sentAt: input.sentAt,
          rawData: {
            source: "auto_responder",
            sendLogId: input.sendLogId,
            orderNumber: input.orderNumber,
            itemId: input.itemId,
          } satisfies Prisma.InputJsonValue,
        },
        select: {
          id: true,
          subject: true,
          bodyText: true,
          fromName: true,
          fromIdentifier: true,
        },
      });

  // 4. Run enabled Helpdesk filters against the new message — that's
  //    what archives the AR per the user's "Auto Responder Initial
  //    Message" rule. We deliberately re-fetch filters per call (low
  //    volume; AR sends are seconds-apart at peak) rather than caching.
  //
  // Guard: if the ticket already has a buyer reply NEWER than this AR
  // (which is the normal case for backfill and edge case for live AR
  // when a sync race lands a buyer reply between our send and our
  // ingest), DO NOT apply archive/spam filters. The buyer's reply has
  // already moved the ticket to TO_DO and archiving it now would hide
  // active work. Filters that don't change folder (assign / tag) are
  // still safe; they're not gated.
  const hasNewerBuyerReply =
    ticket.lastBuyerMessageAt !== null &&
    ticket.lastBuyerMessageAt > input.sentAt;

  const filters = await db.helpdeskFilter.findMany({
    where: { enabled: true },
    orderBy: { sortOrder: "asc" },
  });
  const matched = pickMatchingFilters(
    filters,
    {
      subject: message.subject,
      bodyText: message.bodyText,
      fromName: message.fromName,
      fromIdentifier: message.fromIdentifier,
    },
    { buyerUserId: ticket.buyerUserId, buyerName: ticket.buyerName },
  );
  const appliedFilterIds: string[] = [];
  for (const f of matched) {
    if (hasNewerBuyerReply) {
      // Inspect the action so we can selectively skip "hide the ticket"
      // folders. Tag / assignment side-effects are still fine because
      // they don't move the ticket out of the agent's view.
      try {
        const parsed = JSON.parse(JSON.stringify(f.action)) as {
          folder?: string;
        };
        if (parsed.folder === "archived" || parsed.folder === "spam") {
          continue;
        }
      } catch {
        // If we can't parse, err on the safe side and skip.
        continue;
      }
    }
    await applyFilterAction(f, ticket.id, null);
    appliedFilterIds.push(f.id);
  }

  // 5. Hardcoded AR-only archive rule.
  //
  // Mirrors the rule in helpdesk-ebay-sync.ts reconcileMessages (Rule 2).
  // We run it here unconditionally because the sync-side rule only fires
  // for tickets that have a new message processed in that tick — and AR
  // direct-sends don't flow through the sync path. Without this, every AR
  // fire creates a fresh ticket in WAITING with a single AR message and
  // stays there until a buyer reply bounces it out.
  //
  // Guarded by `hasNewerBuyerReply` so we never archive over active work:
  // if a buyer reply landed between AR send and AR ingest (rare race),
  // leave the ticket in its routed folder.
  //
  // Re-check inbound count against the DB, not just `hasNewerBuyerReply`,
  // because we may be running as a backfill against a ticket that already
  // had buyer messages before we wrote this AR (in which case archiving
  // would be wrong even if `lastBuyerMessageAt` happens to be stale).
  if (!hasNewerBuyerReply) {
    const inboundCount = await db.helpdeskMessage.count({
      where: {
        ticketId: ticket.id,
        direction: HelpdeskMessageDirection.INBOUND,
      },
    });
    if (inboundCount === 0) {
      try {
        await db.helpdeskTicket.update({
          where: { id: ticket.id },
          data: {
            isArchived: true,
            archivedAt: new Date(),
            status: HelpdeskTicketStatus.RESOLVED,
          },
        });
      } catch (err) {
        console.error(
          "[helpdesk-ar-ingest] AR-only archive update failed",
          { ticketId: ticket.id, sendLogId: input.sendLogId },
          err,
        );
      }
    }
  }

  return {
    ticketId: ticket.id,
    messageId: message.id,
    ticketCreated,
    alreadyExisted: !!reusable,
    appliedFilterIds,
  };
}

async function findReusableAutoResponderMessage(input: {
  ticketId: string;
  body: string;
  sentAt: Date;
}) {
  const targetHash = hashBodyForMatch(input.body);
  if (!targetHash) return null;

  const windowMs = 10 * 60 * 1000;
  const candidates = await db.helpdeskMessage.findMany({
    where: {
      ticketId: input.ticketId,
      direction: HelpdeskMessageDirection.OUTBOUND,
      deletedAt: null,
      sentAt: {
        gte: new Date(input.sentAt.getTime() - windowMs),
        lte: new Date(input.sentAt.getTime() + windowMs),
      },
    },
    select: {
      id: true,
      subject: true,
      bodyText: true,
      fromName: true,
      rawData: true,
      sentAt: true,
    },
  });

  return (
    candidates
      .filter((m) => hashBodyForMatch(m.bodyText) === targetHash)
      .sort(
        (a, b) =>
          Math.abs(a.sentAt.getTime() - input.sentAt.getTime()) -
          Math.abs(b.sentAt.getTime() - input.sentAt.getTime()),
      )[0] ?? null
  );
}

function mergeMessageRawData(
  existing: Prisma.JsonValue,
  patch: Record<string, Prisma.JsonValue>,
): Prisma.InputJsonValue {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, Prisma.JsonValue>)
      : {};
  return {
    ...base,
    ...patch,
  } satisfies Prisma.InputJsonValue;
}
