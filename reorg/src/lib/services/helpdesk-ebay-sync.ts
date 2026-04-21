/**
 * Help Desk eBay sync service.
 *
 * 2-stage polling strategy (cost-optimized for Neon public network transfer):
 *   1. Cheap probe: GetMyMessages summary ΓåÆ check NewMessageCount + LastModifiedTime.
 *      Returns ~1KB. Run every cron tick.
 *   2. Headers pull: only fired when summary indicates new activity. Returns
 *      ~5ΓÇô20KB depending on volume. Used to detect specific message IDs to
 *      hydrate.
 *   3. Body pull: chunked (10 IDs per call) for the IDs we don't already have.
 *
 * Backfill: 180-day initial history. Resumable across cron ticks via
 * HelpdeskSyncCheckpoint.backfillCursor ΓÇö each tick advances by ~7 days
 * (eBay's StartTime window cap) until backfillDone=true.
 *
 * Threading: messages are linked into HelpdeskTickets by a `threadKey`. The
 * key prefers ItemID + buyer pair for buyerΓåöseller threads on a single item;
 * falls back to Subject + buyer for general inquiries.
 */

import { db } from "@/lib/db";
import {
  Platform,
  HelpdeskMessageDirection,
  HelpdeskMessageSource,
  HelpdeskTicketStatus,
  HelpdeskTicketKind,
  type HelpdeskFilter,
  type Integration,
  type Prisma,
} from "@prisma/client";
import {
  buildEbayConfig,
  getMyMessagesSummary,
  getMyMessagesHeaders,
  getMyMessagesBodies,
  type EbayMessageBody,
  type EbayMessageHeader,
} from "@/lib/services/helpdesk-ebay";
import { applyFilterAction, pickMatchingFilters } from "@/lib/helpdesk/filters";
import { helpdeskFlags } from "@/lib/helpdesk/flags";
import { deriveStatusOnInbound } from "@/lib/helpdesk/status-routing";
import { detectTicketType } from "@/lib/helpdesk/type-detect";

// ΓöÇΓöÇΓöÇ Constants ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/** Folders we sync for each integration. 0 = Inbox, 1 = Sent. */
const FOLDERS = [
  { id: 0, key: "inbox" },
  { id: 1, key: "sent" },
] as const;

/** Maximum span (days) per GetMyMessages headers call ΓÇö eBay caps at 7. */
const HEADERS_WINDOW_DAYS = 7;

/** Initial backfill horizon in days. */
const BACKFILL_DAYS = 3;

/** Max body fetch chunks per tick (each chunk = 10 messages). */
const MAX_BODY_CHUNKS_PER_TICK = 8;

/** Wall-clock budget in ms ΓÇö used to bail out gracefully. */
const TICK_BUDGET_MS = 75_000;

// ΓöÇΓöÇΓöÇ Types ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface HelpdeskPollSummary {
  integrationId: string;
  platform: Platform;
  folder: string;
  probedNewCount: number;
  probedTotalCount: number;
  headersFetched: number;
  bodiesFetched: number;
  ticketsCreated: number;
  ticketsUpdated: number;
  messagesInserted: number;
  backfillAdvanced: boolean;
  backfillDone: boolean;
  error?: string;
}

export interface HelpdeskPollResult {
  durationMs: number;
  summaries: HelpdeskPollSummary[];
}

// ΓöÇΓöÇΓöÇ Public entrypoint ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export async function runHelpdeskPoll(): Promise<HelpdeskPollResult> {
  const startedAt = Date.now();
  const summaries: HelpdeskPollSummary[] = [];

  const integrations = await db.integration.findMany({
    where: {
      enabled: true,
      platform: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] },
    },
  });

  for (const integration of integrations) {
    if (Date.now() - startedAt > TICK_BUDGET_MS) break;
    for (const folder of FOLDERS) {
      if (Date.now() - startedAt > TICK_BUDGET_MS) break;
      try {
        const summary = await pollIntegrationFolder(integration, folder.id, folder.key);
        summaries.push(summary);
      } catch (err) {
        summaries.push({
          integrationId: integration.id,
          platform: integration.platform,
          folder: folder.key,
          probedNewCount: 0,
          probedTotalCount: 0,
          headersFetched: 0,
          bodiesFetched: 0,
          ticketsCreated: 0,
          ticketsUpdated: 0,
          messagesInserted: 0,
          backfillAdvanced: false,
          backfillDone: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { durationMs: Date.now() - startedAt, summaries };
}

// ΓöÇΓöÇΓöÇ Per-integration / per-folder logic ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

async function pollIntegrationFolder(
  integration: Integration,
  folderID: number,
  folderKey: string,
): Promise<HelpdeskPollSummary> {
  const summary: HelpdeskPollSummary = {
    integrationId: integration.id,
    platform: integration.platform,
    folder: folderKey,
    probedNewCount: 0,
    probedTotalCount: 0,
    headersFetched: 0,
    bodiesFetched: 0,
    ticketsCreated: 0,
    ticketsUpdated: 0,
    messagesInserted: 0,
    backfillAdvanced: false,
    backfillDone: false,
  };

  const config = buildEbayConfig(integration);
  if (!config.appId || !config.refreshToken) {
    summary.error = "missing eBay credentials";
    return summary;
  }

  const checkpoint = await db.helpdeskSyncCheckpoint.upsert({
    where: { integrationId_folder: { integrationId: integration.id, folder: folderKey } },
    create: { integrationId: integration.id, folder: folderKey },
    update: {},
  });

  // ΓöÇΓöÇ Stage 1: cheap probe ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  const probe = await getMyMessagesSummary(integration.id, config, folderID);
  summary.probedNewCount = probe.newMessageCount;
  summary.probedTotalCount = probe.totalMessageCount;

  const probeMod = probe.lastModifiedTime ? new Date(probe.lastModifiedTime) : null;
  const wmTime = checkpoint.lastWatermark ? checkpoint.lastWatermark.getTime() : 0;
  const probeNewer = probeMod ? probeMod.getTime() > wmTime : false;
  const hasNew = probe.newMessageCount > 0 || probeNewer;
  const needsBackfill = !checkpoint.backfillDone;

  // No new messages and backfill is done? Bail with just the probe cost.
  if (!hasNew && !needsBackfill) {
    return summary;
  }

  // ΓöÇΓöÇ Stage 2: pull headers for the appropriate window ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  const now = new Date();
  let windowStart: Date;
  let windowEnd: Date;

  if (needsBackfill) {
    // Walk backwards from (lastFullSyncAt or now) toward (now - BACKFILL_DAYS)
    // in HEADERS_WINDOW_DAYS steps. Cursor stores the next window's END.
    const horizonStart = new Date(now.getTime() - BACKFILL_DAYS * 86_400_000);
    windowEnd = checkpoint.backfillCursor ?? now;
    if (windowEnd.getTime() <= horizonStart.getTime()) {
      // Already past the horizon ΓÇö backfill is done.
      await db.helpdeskSyncCheckpoint.update({
        where: { id: checkpoint.id },
        data: { backfillDone: true, lastFullSyncAt: now },
      });
      summary.backfillDone = true;
      return summary;
    }
    windowStart = new Date(
      Math.max(
        horizonStart.getTime(),
        windowEnd.getTime() - HEADERS_WINDOW_DAYS * 86_400_000,
      ),
    );
  } else {
    // Incremental: pull last 7 days from the watermark, padded by 1 hour.
    const watermark = checkpoint.lastWatermark
      ? new Date(checkpoint.lastWatermark.getTime() - 60 * 60 * 1000)
      : new Date(now.getTime() - HEADERS_WINDOW_DAYS * 86_400_000);
    windowStart = watermark;
    windowEnd = now;
  }

  const headers = await getMyMessagesHeaders(integration.id, config, {
    startTime: windowStart,
    endTime: windowEnd,
    folderID,
  });
  summary.headersFetched = headers.length;

  // Filter out headers we already have a message for.
  const externalIds = headers.map((h) => h.messageID).filter(Boolean);
  let existingExternalIds = new Set<string>();
  if (externalIds.length > 0) {
    const existing = await db.helpdeskMessage.findMany({
      where: {
        ebayMessageId: { in: externalIds },
        ticket: { integrationId: integration.id },
      },
      select: { ebayMessageId: true },
    });
    existingExternalIds = new Set(
      existing.map((e) => e.ebayMessageId).filter(Boolean) as string[],
    );
  }
  const missing = headers.filter(
    (h) => h.messageID && !existingExternalIds.has(h.messageID),
  );

  // ΓöÇΓöÇ Read-state reconciliation (inbound, opt-in) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  // If the eBay UI was used to mark messages read, mirror that into reorG so
  // the agent doesn't see the same red-dot twice. We only flow eBayΓåÆreorG when
  // a message is now read on eBay (one-directional). Going the other way
  // (eBay says unread ΓåÆ reorG marks unread) would constantly fight an agent
  // who already triaged a thread in reorG.
  if (
    helpdeskFlags.enableEbayReadSync &&
    folderKey === "inbox" &&
    existingExternalIds.size > 0
  ) {
    try {
      await reconcileEbayReadState(integration.id, headers);
    } catch (err) {
      console.error(
        "[helpdesk-sync] eBay read-state reconcile failed",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Pre-load enabled filters once per folder pull so the per-message engine
  // doesn't hit the DB for each new inbound message.
  const filters = await db.helpdeskFilter.findMany({
    where: { enabled: true },
    orderBy: { sortOrder: "asc" },
  });

  // ΓöÇΓöÇ Stage 3: hydrate bodies in chunks ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  const startedAt = Date.now();
  let chunksFetched = 0;
  for (let i = 0; i < missing.length; i += 10) {
    if (chunksFetched >= MAX_BODY_CHUNKS_PER_TICK) break;
    if (Date.now() - startedAt > 30_000) break;
    const chunk = missing.slice(i, i + 10);
    const ids = chunk.map((c) => c.messageID).filter(Boolean);
    if (ids.length === 0) continue;
    const bodies = await getMyMessagesBodies(integration.id, config, ids);
    summary.bodiesFetched += bodies.length;
    chunksFetched++;
    const reconciled = await reconcileMessages({
      integration,
      folderKey,
      bodies,
      filters,
    });
    summary.ticketsCreated += reconciled.ticketsCreated;
    summary.ticketsUpdated += reconciled.ticketsUpdated;
    summary.messagesInserted += reconciled.messagesInserted;
  }

  // ΓöÇΓöÇ Update checkpoint ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  if (needsBackfill) {
    const advancedCursor = windowStart;
    const backfillNowDone =
      advancedCursor.getTime() <= now.getTime() - BACKFILL_DAYS * 86_400_000;
    await db.helpdeskSyncCheckpoint.update({
      where: { id: checkpoint.id },
      data: {
        backfillCursor: advancedCursor,
        backfillDone: backfillNowDone,
        lastFullSyncAt: backfillNowDone ? now : checkpoint.lastFullSyncAt,
      },
    });
    summary.backfillAdvanced = true;
    summary.backfillDone = backfillNowDone;
  } else {
    // Set watermark to the latest message receive time we processed (or now).
    const latest = missing
      .map((m) => (m.receiveDate ? new Date(m.receiveDate).getTime() : 0))
      .reduce((max, t) => (t > max ? t : max), wmTime);
    await db.helpdeskSyncCheckpoint.update({
      where: { id: checkpoint.id },
      data: {
        lastWatermark: latest > 0 ? new Date(latest) : now,
        lastFullSyncAt: now,
      },
    });
  }

  return summary;
}

// ΓöÇΓöÇΓöÇ Reconciliation: header ΓåÆ ticket + message ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

interface ReconcileArgs {
  integration: Integration;
  folderKey: string;
  bodies: EbayMessageBody[];
  /** Enabled HelpdeskFilters loaded once per sync pass. */
  filters: HelpdeskFilter[];
}

interface ReconcileResult {
  ticketsCreated: number;
  ticketsUpdated: number;
  messagesInserted: number;
}

async function reconcileMessages(args: ReconcileArgs): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    ticketsCreated: 0,
    ticketsUpdated: 0,
    messagesInserted: 0,
  };

  for (const body of args.bodies) {
    if (!body.messageID) continue;
    const direction = inferDirection(body, args.folderKey);
    const threadKey = computeThreadKey(body, direction);
    if (!threadKey) continue;

    const buyerUserId = inferBuyerUserId(body, direction);
    const sentAt = body.receiveDate ? new Date(body.receiveDate) : new Date();
    const subject = body.subject?.trim() || null;
    const itemId = body.itemID?.trim() || null;

    // Extract an eBay order number from the message itself (subject or body).
    // Auto-responder messages always include "Your order (#NN-NNNNN-NNNNN)";
    // many buyer replies also quote the order number. We capture it here so
    // the ticket can show it without an extra API round-trip.
    const extractedOrderNumber = extractEbayOrderNumber(body);

    const isPreSales =
      !!itemId &&
      !buyerOrderHint(body) &&
      body.questionType !== "Shipping" &&
      !extractedOrderNumber;

    let ticket = await db.helpdeskTicket.findUnique({
      where: {
        integrationId_threadKey: {
          integrationId: args.integration.id,
          threadKey,
        },
      },
    });

    const ticketUpdate: Prisma.HelpdeskTicketUpdateInput = {};
    if (direction === HelpdeskMessageDirection.INBOUND) {
      ticketUpdate.lastBuyerMessageAt = sentAt;
      ticketUpdate.unreadCount = { increment: 1 };
      if (ticket) {
        // Route the ticket through the pure status helper. The helper knows
        // the eDesk semantics (NEW vs TO_DO depending on whether we've ever
        // replied, RESOLVED reopens to TO_DO, SPAM/ARCHIVED stay put).
        const next = deriveStatusOnInbound({
          status: ticket.status,
          hasAgentReplied: ticket.lastAgentMessageAt !== null,
          isArchived: ticket.isArchived,
          isSpam: ticket.isSpam,
        });
        if (next !== ticket.status) {
          ticketUpdate.status = next;
        }
        // Reopen bookkeeping is only relevant when we resurrect a RESOLVED
        // ticket — otherwise we'd inflate reopenCount on every buyer message
        // in a normal back-and-forth.
        if (ticket.status === HelpdeskTicketStatus.RESOLVED) {
          ticketUpdate.reopenCount = { increment: 1 };
          ticketUpdate.lastReopenedAt = new Date();
        }
        // Wake any active snooze: a new buyer message means the agent's
        // "remind me later" is now moot.
        if (ticket.snoozedUntil) {
          ticketUpdate.snoozedUntil = null;
          if (ticket.snoozedById) {
            ticketUpdate.snoozedBy = { disconnect: true };
          }
        }
      }
    } else {
      ticketUpdate.lastAgentMessageAt = sentAt;
      // Mark first response if not yet set.
      if (ticket && !ticket.firstResponseAt) {
        ticketUpdate.firstResponseAt = sentAt;
      }
    }

    // Auto-detect ticket type from this message (subject + body + eBay
    // questionType). Only used on create OR when the existing row hasn't
    // been overridden by an agent and is still on the default QUERY value.
    const detectedType =
      direction === HelpdeskMessageDirection.INBOUND
        ? detectTicketType({
            ebayQuestionType: body.questionType ?? null,
            subject,
            bodyText: body.text ?? null,
          })
        : null;

    if (!ticket) {
      ticket = await db.helpdeskTicket.create({
        data: {
          integrationId: args.integration.id,
          channel: args.integration.platform,
          threadKey,
          buyerUserId,
          ebayItemId: itemId,
          ebayOrderNumber: extractedOrderNumber,
          subject,
          kind: isPreSales ? HelpdeskTicketKind.PRE_SALES : HelpdeskTicketKind.POST_SALES,
          ...(detectedType ? { type: detectedType } : {}),
          status:
            direction === HelpdeskMessageDirection.INBOUND
              ? HelpdeskTicketStatus.NEW
              : HelpdeskTicketStatus.WAITING,
          lastBuyerMessageAt:
            direction === HelpdeskMessageDirection.INBOUND ? sentAt : null,
          lastAgentMessageAt:
            direction === HelpdeskMessageDirection.OUTBOUND ? sentAt : null,
          unreadCount: direction === HelpdeskMessageDirection.INBOUND ? 1 : 0,
        },
      });
      result.ticketsCreated++;
    } else {
      // Backfill an existing post-sales ticket with the order number when we
      // see one on a later message in the thread.
      if (extractedOrderNumber && !ticket.ebayOrderNumber) {
        ticketUpdate.ebayOrderNumber = extractedOrderNumber;
      }
      // If a ticket was originally classified as pre-sales but a later
      // message reveals an order number, re-classify it as post-sales so it
      // moves into the right folder.
      if (
        extractedOrderNumber &&
        ticket.kind === HelpdeskTicketKind.PRE_SALES
      ) {
        ticketUpdate.kind = HelpdeskTicketKind.POST_SALES;
      }
      // Type upgrade: if an agent hasn't manually picked a type yet AND the
      // current type is still the default QUERY, let a stronger signal in a
      // later message reclassify the ticket (e.g. buyer's first message was
      // generic, second message says "I want to return this"). We never
      // overwrite a non-default type or an explicit override.
      if (
        detectedType &&
        !ticket.typeOverridden &&
        ticket.type === "QUERY" &&
        detectedType !== "QUERY"
      ) {
        ticketUpdate.type = detectedType;
      }
    }

    if (Object.keys(ticketUpdate).length > 0 && ticket.id) {
      ticket = await db.helpdeskTicket.update({
        where: { id: ticket.id },
        data: ticketUpdate,
      });
      result.ticketsUpdated++;
    }

    // Insert message (idempotent on (ticketId, externalId))
    let inserted = false;
    const messageBodyText = body.text ?? "";
    const messageFromName = body.sender ?? null;
    try {
      await db.helpdeskMessage.create({
        data: {
          ticketId: ticket.id,
          direction,
          source:
            direction === HelpdeskMessageDirection.OUTBOUND &&
            !body.externalMessageID?.startsWith("reorg:")
              ? HelpdeskMessageSource.EBAY_UI
              : HelpdeskMessageSource.EBAY,
          externalId: body.messageID,
          ebayMessageId: body.messageID,
          fromName: messageFromName,
          fromIdentifier: messageFromName,
          subject,
          bodyText: messageBodyText,
          // eBay's GetMyMessages only sets ContentType reliably when the
          // sender uploaded as text/html ΓÇö a huge swath of buyer-facing
          // notifications come back without it even though the body itself
          // is full HTML markup. Sniff the actual body so SafeHtml renders
          // correctly downstream.
          isHtml:
            (body.contentType ?? "").toLowerCase().includes("html") ||
            looksLikeHtmlBody(messageBodyText),
          rawMedia: (body.mediaUrls ?? []) as Prisma.InputJsonValue,
          rawData: {
            questionType: body.questionType ?? null,
            parentMessageID: body.parentMessageID ?? null,
            recipientUserID: body.recipientUserID ?? null,
            itemID: body.itemID ?? null,
            responseDetails: body.responseDetails ?? null,
            folder: args.folderKey,
          } as Prisma.InputJsonValue,
          sentAt,
        },
      });
      result.messagesInserted++;
      inserted = true;
    } catch (err) {
      // Ignore unique-constraint duplicates; surface other errors.
      if (
        !(err instanceof Error) ||
        !err.message.includes("Unique constraint failed")
      ) {
        console.error("[helpdesk-sync] message insert failed", err);
      }
    }

    if (!inserted) continue;

    // ── eDesk WAITING transition: when an OUTBOUND message lands and is
    // newer than every inbound on the ticket, the ball is now in the
    // buyer's court → WAITING. This covers two real flows:
    //   1. The agent replied on eBay.com directly (we see it via sync).
    //   2. Our own outbound worker delivered a reply.
    // We do NOT auto-resolve here — the user's spec is "RESOLVED is
    // explicit only" (Send + mark Resolved button or batch action). The
    // outbound messages route already passes the agent's chosen
    // `setStatus` (WAITING or RESOLVED) through `deriveStatusOnOutbound`,
    // so this block only nudges WAITING for unsolicited eBay-side replies.
    if (
      direction === HelpdeskMessageDirection.OUTBOUND &&
      ticket.status !== HelpdeskTicketStatus.RESOLVED &&
      ticket.status !== HelpdeskTicketStatus.SPAM &&
      !ticket.isArchived
    ) {
      const newerInbound = await db.helpdeskMessage.findFirst({
        where: {
          ticketId: ticket.id,
          direction: HelpdeskMessageDirection.INBOUND,
          sentAt: { gt: sentAt },
        },
        select: { id: true },
      });
      if (!newerInbound && ticket.status !== HelpdeskTicketStatus.WAITING) {
        await db.helpdeskTicket.update({
          where: { id: ticket.id },
          data: {
            status: HelpdeskTicketStatus.WAITING,
            unreadCount: 0,
          },
        });
      }
    }

    // ΓöÇΓöÇ Filters: only evaluate against fresh INBOUND mail. Outbound replies
    // shouldn't trigger filters that would archive the agent's own message.
    if (
      direction === HelpdeskMessageDirection.INBOUND &&
      args.filters.length > 0
    ) {
      const matching = pickMatchingFilters(
        args.filters,
        {
          subject,
          bodyText: messageBodyText,
          fromName: messageFromName,
          fromIdentifier: messageFromName,
        },
        {
          buyerUserId: ticket.buyerUserId,
          buyerName: ticket.buyerName,
        },
      );
      // Apply each matching filter in `sortOrder`. Later actions can override
      // earlier ones (e.g. a "spam" filter after an "archive" filter), which
      // is the conventional Gmail-style behaviour.
      for (const f of matching) {
        try {
          await applyFilterAction(f, ticket.id, null);
        } catch (err) {
          console.error(
            `[helpdesk-sync] filter "${f.name}" apply failed for ticket ${ticket.id}`,
            err,
          );
        }
      }
      if (matching.length > 0) {
        // Bump aggregate hit counters so the UI can show "applied N times".
        await db.helpdeskFilter.updateMany({
          where: { id: { in: matching.map((f) => f.id) } },
          data: { totalHits: { increment: 1 } },
        });
      }
    }
  }

  return result;
}

// ΓöÇΓöÇΓöÇ Helpers ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function inferDirection(
  body: EbayMessageBody,
  folderKey: string,
): HelpdeskMessageDirection {
  // Sent folder = always outbound. Inbox = inbound from buyer to us.
  if (folderKey === "sent") return HelpdeskMessageDirection.OUTBOUND;
  return HelpdeskMessageDirection.INBOUND;
}

function inferBuyerUserId(
  body: EbayMessageBody,
  direction: HelpdeskMessageDirection,
): string | null {
  if (direction === HelpdeskMessageDirection.INBOUND) {
    return body.sender?.trim() || null;
  }
  return body.recipientUserID?.trim() || null;
}

function buyerOrderHint(body: EbayMessageBody): boolean {
  // Best-effort signal that the message references a real order (post-sale).
  // eBay GetMyMessages does not always return order details; the subject
  // commonly contains "Order #" or "OrderID" for post-sale threads.
  const subject = (body.subject ?? "").toLowerCase();
  return /order\s*[#:]/i.test(subject) || /shipped/i.test(subject);
}

/**
 * Stable thread key. Buyer + Item is the strongest signal for a single
 * conversation; multiple independent threads on the same item from the same
 * buyer are rare and acceptable to merge for v1.
 *
 * Format examples:
 *   - itm:123456789|buyer:johndoe
 *   - sub:question-about-shipping|buyer:johndoe
 *   - msg:abcdef (last-resort fallback when neither exists)
 */
function computeThreadKey(
  body: EbayMessageBody,
  direction: HelpdeskMessageDirection,
): string | null {
  const buyer =
    direction === HelpdeskMessageDirection.INBOUND
      ? body.sender
      : body.recipientUserID;
  const itemId = body.itemID?.trim();
  const subject = body.subject?.trim();

  if (itemId && buyer) {
    return `itm:${itemId}|buyer:${buyer.toLowerCase()}`;
  }
  if (subject && buyer) {
    return `sub:${subject.slice(0, 80).toLowerCase()}|buyer:${buyer.toLowerCase()}`;
  }
  if (body.messageID) {
    return `msg:${body.messageID}`;
  }
  return null;
}

// ΓöÇΓöÇΓöÇ Body sniffing & order-number extraction ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * Heuristic: does the message body actually contain HTML markup? eBay's
 * GetMyMessages frequently returns HTML inside the <Text> element without
 * setting ContentType=text/html (especially for buyer-side and notification
 * messages), so we sniff the content directly. This mirrors the detection
 * logic in SafeHtml so the data we store and what we render stay in sync.
 */
const HTML_BODY_TAG_RE =
  /<\/?(?:html|body|head|table|tr|td|th|div|p|br|hr|span|img|a|h[1-6]|ul|ol|li|strong|em|b|i|font|center|blockquote|pre)\b/i;
const HTML_ENTITY_TAG_RE =
  /&lt;\/?(?:html|body|table|tr|td|div|p|br|span|img|a|h[1-6]|ul|ol|li|strong|em|font)\b/i;

function looksLikeHtmlBody(text: string): boolean {
  if (!text) return false;
  return HTML_BODY_TAG_RE.test(text) || HTML_ENTITY_TAG_RE.test(text);
}

/**
 * eBay order numbers in messages appear in several shapes:
 *   - Auto-responder bodies: "Your order (#24-14519-40737)"
 *   - eBay shipping notifications: "Order number: 24-14519-40737"
 *   - Bulk-style: "Order ID: 12-12345-12345" or "OrderID: 110123456789-987654321"
 *   - Buyer replies that quote: "Order #24-14519-40737"
 *
 * We accept either the buyer/seller-facing "##-#####-#####" format OR the
 * legacy "<itemId>-<txnId>" numeric format eBay still emits in some
 * notifications.
 *
 * The regex matches:
 *   `\d{2}-\d{5}-\d{5}` ΓÇö the 5-3-5 segmented order number, or
 *   `\d{10,16}-\d{5,15}` ΓÇö the legacy numeric ItemID-TxnID pairing.
 */
const ORDER_NUMBER_RE = /(\d{2}-\d{5}-\d{5})|(\d{10,16}-\d{5,15})/;
const ORDER_NUMBER_LABEL_RE =
  /(?:order\s*(?:number|no\.?|#|id)\s*[:#]?\s*)([A-Z0-9-]+)/i;

/**
 * One-way mirror of eBay's read-state into reorG.
 *
 * If a header we already have locally is now `read=true` on eBay, and the
 * owning ticket's only unread inbound message is this one (or older), zero
 * out the ticket's `unreadCount`. We never raise unread back up from this
 * path ΓÇö that would constantly fight an agent who already triaged in reorG.
 *
 * Cheap: one ticket-grouping query, one updateMany. No per-message writes.
 */
async function reconcileEbayReadState(
  integrationId: string,
  headers: EbayMessageHeader[],
): Promise<void> {
  const readHeaderIds = headers
    .filter((h) => h.read === true && h.messageID)
    .map((h) => h.messageID as string);
  if (readHeaderIds.length === 0) return;

  // Find the local messages for these eBay IDs along with their ticket id.
  const localMessages = await db.helpdeskMessage.findMany({
    where: {
      ebayMessageId: { in: readHeaderIds },
      direction: HelpdeskMessageDirection.INBOUND,
      ticket: { integrationId },
    },
    select: {
      ticketId: true,
      sentAt: true,
      ticket: { select: { unreadCount: true, lastBuyerMessageAt: true } },
    },
  });
  if (localMessages.length === 0) return;

  // Group by ticket and pick the most recent inbound `sentAt` we've seen
  // marked-read on eBay. If that timestamp is >= the ticket's
  // lastBuyerMessageAt, the ticket has truly been caught up on eBay.
  const ticketLatestRead = new Map<string, number>();
  for (const m of localMessages) {
    const t = m.sentAt?.getTime() ?? 0;
    const prev = ticketLatestRead.get(m.ticketId) ?? 0;
    if (t > prev) ticketLatestRead.set(m.ticketId, t);
  }

  const ticketsToClear: string[] = [];
  for (const m of localMessages) {
    if (m.ticket.unreadCount <= 0) continue;
    const lastBuyer = m.ticket.lastBuyerMessageAt?.getTime() ?? 0;
    const latestRead = ticketLatestRead.get(m.ticketId) ?? 0;
    if (latestRead >= lastBuyer && !ticketsToClear.includes(m.ticketId)) {
      ticketsToClear.push(m.ticketId);
    }
  }
  if (ticketsToClear.length === 0) return;

  await db.helpdeskTicket.updateMany({
    where: { id: { in: ticketsToClear } },
    data: { unreadCount: 0 },
  });
}

function extractEbayOrderNumber(body: EbayMessageBody): string | null {
  const haystacks: string[] = [];
  if (body.subject) haystacks.push(body.subject);
  if (body.text) haystacks.push(body.text);

  for (const text of haystacks) {
    // Prefer label-anchored matches first ("Order #..." / "Order number: ...")
    const labelMatch = ORDER_NUMBER_LABEL_RE.exec(text);
    if (labelMatch) {
      const candidate = labelMatch[1]?.trim();
      if (candidate && /^\d{2}-\d{5}-\d{5}$/.test(candidate)) return candidate;
      if (candidate && /^\d{10,16}-\d{5,15}$/.test(candidate)) return candidate;
    }
    // Fallback: any unmistakable order-number shape anywhere in the text.
    const shapeMatch = ORDER_NUMBER_RE.exec(text);
    if (shapeMatch) {
      return (shapeMatch[1] ?? shapeMatch[2] ?? "").trim() || null;
    }
  }
  return null;
}

// ΓöÇΓöÇΓöÇ Backfill: ebayOrderNumber for tickets missing it ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

interface BackfillOrderNumbersOptions {
  /** Only act on tickets created within the last N days (default: 180). */
  withinDays?: number;
  /** Cap how many tickets to process this pass. */
  maxTickets?: number;
}

interface BackfillOrderNumbersResult {
  scanned: number;
  matchedFromMessages: number;
  matchedFromAutoResponder: number;
  matchedFromEbay: number;
  remaining: number;
}

/**
 * Find post-sales tickets that are missing `ebayOrderNumber` and try to
 * populate it. Strategy, in order of cost:
 *   1. Re-scan stored messages (free, just text).
 *   2. Match against AutoResponderSendLog (free, our own data ΓÇö every
 *      auto-responder send has an order number).
 *   3. Call eBay GetOrders by item+buyer (last resort, costs API quota).
 *
 * Designed to run from a cron tick or on-demand. Returns counts so the
 * caller can log progress.
 */
export async function backfillTicketOrderNumbers(
  opts: BackfillOrderNumbersOptions = {},
): Promise<BackfillOrderNumbersResult> {
  const result: BackfillOrderNumbersResult = {
    scanned: 0,
    matchedFromMessages: 0,
    matchedFromAutoResponder: 0,
    matchedFromEbay: 0,
    remaining: 0,
  };
  const since = new Date(Date.now() - (opts.withinDays ?? 180) * 86_400_000);
  const limit = opts.maxTickets ?? 200;

  const tickets = await db.helpdeskTicket.findMany({
    where: {
      ebayOrderNumber: null,
      kind: HelpdeskTicketKind.POST_SALES,
      createdAt: { gte: since },
    },
    include: {
      integration: true,
      messages: {
        select: { subject: true, bodyText: true },
        orderBy: { sentAt: "asc" },
      },
    },
    take: limit,
    orderBy: { createdAt: "desc" },
  });
  result.scanned = tickets.length;

  for (const ticket of tickets) {
    let matched: string | null = null;

    // 1. Stored messages ΓÇö re-run extraction in case the original sync
    //    happened before this code shipped.
    for (const m of ticket.messages) {
      const candidate = extractFromText(m.subject ?? "") ?? extractFromText(m.bodyText);
      if (candidate) {
        matched = candidate;
        result.matchedFromMessages++;
        break;
      }
    }

    // 2. Auto-responder log ΓÇö when reorG sent the first message on this
    //    thread, it logged the orderNumber. Match by buyer + item.
    if (!matched && ticket.buyerUserId && ticket.ebayItemId) {
      const log = await db.autoResponderSendLog.findFirst({
        where: {
          integrationId: ticket.integrationId,
          ebayItemId: ticket.ebayItemId,
          ebayBuyerUserId: ticket.buyerUserId,
          status: "sent",
        },
        select: { orderNumber: true },
        orderBy: { sentAt: "desc" },
      });
      if (log?.orderNumber) {
        matched = log.orderNumber;
        result.matchedFromAutoResponder++;
      }
    }

    // 3. eBay GetOrders by ItemID + buyer is not directly supported, so
    //    we fall back to looking up by any order numbers we *do* know about
    //    on the same buyer recently. Skipped here; the backfill cron can
    //    expand on this later.

    if (matched) {
      await db.helpdeskTicket.update({
        where: { id: ticket.id },
        data: { ebayOrderNumber: matched },
      });
    } else {
      result.remaining++;
    }
  }

  return result;
}

function extractFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const labelMatch = ORDER_NUMBER_LABEL_RE.exec(text);
  if (labelMatch) {
    const candidate = labelMatch[1]?.trim();
    if (candidate && /^\d{2}-\d{5}-\d{5}$/.test(candidate)) return candidate;
    if (candidate && /^\d{10,16}-\d{5,15}$/.test(candidate)) return candidate;
  }
  const shapeMatch = ORDER_NUMBER_RE.exec(text);
  if (shapeMatch) {
    return (shapeMatch[1] ?? shapeMatch[2] ?? "").trim() || null;
  }
  return null;
}

// Re-export for tests / cron integration.
export { extractEbayOrderNumber, looksLikeHtmlBody };
