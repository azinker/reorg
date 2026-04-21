/**
 * GET /api/helpdesk/tickets/[id]/events
 *
 * Returns a unified, time-ordered timeline for the reader pane:
 *
 *   - "message"  — buyer or agent message (chat bubbles in ThreadView)
 *   - "note"     — internal amber note
 *   - "system"   — derived from AuditLog rows that pertain to this ticket
 *
 * The ThreadView interleaves these so an agent sees the full story:
 *   "Buyer: my item is broken"  →  "Adam opened the ticket"  →
 *   "System changed status to Waiting"  →  "Agent: shipping a replacement…"
 *
 * Why a separate endpoint (instead of stuffing system rows into the existing
 * /tickets/:id payload):
 *   1. Keeps the read-only summary endpoint cheap — system rows come from a
 *      different table (AuditLog), so combining them would slow down every
 *      list refresh.
 *   2. Lets us evolve the system-event vocabulary independently. New audit
 *      actions just need a `formatSystemEvent` clause; no schema change.
 *
 * SAFETY: read-only. No marketplace writes happen here. The endpoint
 * intentionally does NOT mark the ticket as read — that's the responsibility
 * of GET /tickets/:id.
 */

import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { buildEbayConfig } from "@/lib/services/auto-responder-ebay";
import { getOrderContextCached } from "@/lib/services/helpdesk-order-context-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Audit actions surfaced to the timeline, paired with a per-action formatter.
 *
 * The formatter receives the audit row + the actor's display name (or null if
 * we couldn't resolve a user) and must return:
 *   - `text`  short, plain-English description shown next to the actor
 *   - `kind`  semantic class for styling (status / open / filter / case / read)
 *
 * Returning `null` causes the row to be skipped (e.g. an audit row with
 * unrecognised details shape — defensive default).
 */
type SystemEventKind =
  | "open"
  | "status"
  // Type-change events are split out from "status" because the user wanted
  // them to render as a distinct line ("Cory set type to Return Request")
  // and styled with a neutral pill rather than a status pill.
  | "type"
  | "assign"
  | "mention"
  | "tag"
  | "spam"
  | "archive"
  | "filter"
  | "snooze"
  | "case"
  | "feedback"
  | "cancel"
  | "refund"
  | "read"
  // Synthesized from eBay order context (not from AuditLog).
  | "order_received"
  | "order_shipped";

interface FormattedEvent {
  kind: SystemEventKind;
  text: string;
}

type AuditDetails = Record<string, unknown> & {
  ticketIds?: unknown;
  status?: unknown;
  userId?: unknown;
  type?: unknown;
  isSpam?: unknown;
  isArchived?: unknown;
  isRead?: unknown;
  isFavorite?: unknown;
  isImportant?: unknown;
  tagIds?: unknown;
  count?: unknown;
  filterId?: unknown;
  filterName?: unknown;
  caseType?: unknown;
  snoozedUntil?: unknown;
};

function formatHumanStatus(status: unknown): string {
  if (typeof status !== "string") return "an unknown status";
  const map: Record<string, string> = {
    NEW: "New",
    TO_DO: "To Do",
    WAITING: "Waiting",
    RESOLVED: "Resolved",
    SPAM: "Spam",
    ARCHIVED: "Archived",
  };
  return map[status] ?? status;
}

/**
 * Convert a HelpdeskTicketType enum value to a human-readable label.
 * Returns null if the type is QUERY (the default placeholder) — we
 * deliberately suppress "set type to Query" / "set type to No Type" events
 * in the timeline because they're noise: every ticket starts as QUERY, so
 * an event for "the agent set it to the default" tells the agent nothing.
 */
function formatHumanType(type: unknown): string | null {
  if (typeof type !== "string") return null;
  // QUERY is the default — suppress it from the timeline.
  if (type === "QUERY" || type === "" || type === "NO_TYPE") return null;
  const map: Record<string, string> = {
    PRE_SALES: "Pre-sales",
    RETURN_REQUEST: "Return Request",
    ITEM_NOT_RECEIVED: "Item Not Received",
    NEGATIVE_FEEDBACK: "Negative Feedback",
    BUYER_CANCELLATION: "Buyer Cancellation",
    SHIPPING_QUESTION: "Shipping Question",
    PRODUCT_QUESTION: "Product Question",
    REFUND_REQUEST: "Refund Request",
  };
  return (
    map[type] ??
    type
      .split("_")
      .map((w) => w[0] + w.slice(1).toLowerCase())
      .join(" ")
  );
}

function formatSystemEvent(
  action: string,
  details: AuditDetails,
  actorName: string | null,
  resolveAssigneeName: (userId: string) => string | null,
): FormattedEvent | null {
  const who = actorName ?? "System";

  // Per-ticket actions written by the batch endpoint.
  switch (action) {
    case "HELPDESK_TICKET_OPENED":
      return { kind: "open", text: `${who} opened the ticket` };

    case "HELPDESK_BATCH_SETSTATUS":
    case "HELPDESK_TICKET_STATUS_CHANGED":
    case "HELPDESK_TICKET_RESOLVED": {
      // RESOLVED gets its own audit action with no `details.status` — fold
      // it into the same path so the user sees consistent phrasing.
      const status =
        action === "HELPDESK_TICKET_RESOLVED"
          ? "Resolved"
          : formatHumanStatus(details.status);
      return { kind: "status", text: `${who} marked as ${status}` };
    }

    case "HELPDESK_TICKET_TYPE_CHANGED": {
      // Type and status are conceptually independent — split the rendering
      // so they don't collide visually. Suppress noise (QUERY / No Type)
      // because every ticket starts as QUERY, so logging the agent picking
      // the default value back tells the agent nothing useful.
      const type = formatHumanType(details.type);
      if (!type) return null;
      return { kind: "type", text: `${who} set type to ${type}` };
    }

    case "HELPDESK_BATCH_ASSIGNPRIMARY":
    case "HELPDESK_TICKET_ASSIGNED": {
      // Resolve the assignee's display name when we can — the audit row
      // only stores the user id but the timeline UI is much more useful
      // when it shows "Cory assigned to Adam" vs the bare "assigned".
      const rawId = details.userId;
      if (rawId === null) {
        return { kind: "assign", text: `${who} unassigned the ticket` };
      }
      if (typeof rawId !== "string") {
        return { kind: "assign", text: `${who} assigned the ticket` };
      }
      const assigneeName = resolveAssigneeName(rawId);
      if (assigneeName) {
        return {
          kind: "assign",
          text: `${who} assigned to ${assigneeName}`,
        };
      }
      return { kind: "assign", text: `${who} assigned the ticket` };
    }

    case "HELPDESK_TICKET_FAVORITE_TOGGLED":
      return {
        kind: "tag",
        text:
          details.isFavorite === true
            ? `${who} favorited the ticket`
            : `${who} removed from favorites`,
      };

    case "HELPDESK_TICKET_IMPORTANT_TOGGLED":
      return {
        kind: "tag",
        text:
          details.isImportant === true
            ? `${who} flagged as important`
            : `${who} cleared the important flag`,
      };

    case "HELPDESK_TICKET_SNOOZED": {
      const until = typeof details.snoozedUntil === "string" ? details.snoozedUntil : null;
      if (!until) {
        return { kind: "snooze", text: `${who} snoozed the ticket` };
      }
      return {
        kind: "snooze",
        text: `${who} snoozed until ${new Date(until).toLocaleString()}`,
      };
    }
    case "HELPDESK_TICKET_UNSNOOZED":
      return { kind: "snooze", text: `${who} woke the ticket from snooze` };

    case "HELPDESK_BATCH_ADDTAGS":
      return { kind: "tag", text: `${who} added a tag` };
    case "HELPDESK_BATCH_REMOVETAGS":
      return { kind: "tag", text: `${who} removed a tag` };
    case "HELPDESK_TICKET_TAGS_SET":
      return { kind: "tag", text: `${who} updated tags` };

    case "HELPDESK_BATCH_MARKSPAM":
      return {
        kind: "spam",
        text:
          details.isSpam === true
            ? `${who} marked the ticket as spam`
            : `${who} unmarked the ticket as spam`,
      };
    case "HELPDESK_TICKET_ARCHIVED":
    case "HELPDESK_BATCH_ARCHIVE":
      return {
        kind: "archive",
        text:
          details.isArchived === true || action === "HELPDESK_TICKET_ARCHIVED"
            ? `${who} archived the ticket`
            : `${who} restored the ticket`,
      };
    case "HELPDESK_BATCH_MARKREAD":
      return {
        kind: "read",
        text:
          details.isRead === true
            ? `${who} marked as read`
            : `${who} marked as unread`,
      };
    case "HELPDESK_FILTER_RUN":
      return {
        kind: "filter",
        text: `Filter "${typeof details.filterName === "string" ? details.filterName : "Inbox rule"}" routed this ticket`,
      };
    case "HELPDESK_EBAY_CASE_OPENED":
      return {
        kind: "case",
        text: `Buyer opened a${typeof details.caseType === "string" ? ` ${details.caseType}` : "n eBay"} case`,
      };
    case "HELPDESK_EBAY_RETURN_OPENED":
      return { kind: "case", text: "Buyer opened a return on eBay" };
    case "HELPDESK_TICKET_REOPENED":
      return { kind: "status", text: `${who} reopened the ticket` };
    default:
      return null;
  }
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Cheap existence check — also lets us early-out on 404 with the right code.
  // We also pull the order linkage + integration so we can synthesise the
  // "Order received" / "Order shipped" timeline events from the eBay order.
  const exists = await db.helpdeskTicket.findUnique({
    where: { id },
    select: {
      id: true,
      createdAt: true,
      channel: true,
      ebayOrderNumber: true,
      integration: {
        select: { id: true, platform: true, config: true },
      },
    },
  });
  if (!exists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Pull the candidate audit rows. The cheapest filter we can apply at the
  // DB layer is `entityType = 'HelpdeskTicket' AND entityId = id`, plus a
  // jsonb-contains for batch rows where this ticket is in `details.ticketIds`.
  // We OR them so single-ticket and batch actions both surface here.
  //
  // Using Prisma's typed `OR` keeps this safe; the `ticketIds` predicate uses
  // the `array_contains` jsonb operator to find batches that included us.
  const auditRows = await db.auditLog.findMany({
    where: {
      OR: [
        { entityType: "HelpdeskTicket", entityId: id },
        {
          // Batch-action rows store entityType="HelpdeskTicket" with details.ticketIds.
          // We match either by single-row entityId or by membership in the batch
          // array. The discriminated OR keeps both queries indexed.
          entityType: "HelpdeskTicket",
          details: { array_contains: [id] } as Prisma.JsonNullableFilter,
        },
        {
          // Some batches store the ticket id inside details.ticketIds, not at
          // the array root. Cover that shape too via a string-search on the
          // serialised payload — bounded by the entityType filter above so this
          // never scans the full audit_logs table.
          entityType: "HelpdeskTicket",
          details: {
            path: ["ticketIds"],
            array_contains: [id],
          } as Prisma.JsonNullableFilter,
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 500,
    include: {
      user: {
        select: { id: true, name: true, email: true, handle: true, avatarUrl: true },
      },
    },
  });

  // Resolve any assignee user ids referenced by ASSIGNED audit rows in one
  // round-trip so we can render "Cory assigned to Adam" instead of just
  // "Cory assigned the ticket". Pulled out of the per-row formatter so we
  // never issue N+1 queries in the timeline.
  const assigneeIds = new Set<string>();
  for (const row of auditRows) {
    if (
      row.action === "HELPDESK_TICKET_ASSIGNED" ||
      row.action === "HELPDESK_BATCH_ASSIGNPRIMARY"
    ) {
      const details = (row.details ?? {}) as AuditDetails;
      if (typeof details.userId === "string") {
        assigneeIds.add(details.userId);
      }
    }
  }
  const assigneeNameById = new Map<string, string>();
  if (assigneeIds.size > 0) {
    const users = await db.user.findMany({
      where: { id: { in: Array.from(assigneeIds) } },
      select: { id: true, name: true, handle: true, email: true },
    });
    for (const u of users) {
      const display = u.name ?? u.handle ?? u.email ?? null;
      if (display) assigneeNameById.set(u.id, display);
    }
  }

  const events = auditRows
    .map((row) => {
      const actor = row.user
        ? row.user.name ?? row.user.handle ?? row.user.email ?? null
        : null;
      const formatted = formatSystemEvent(
        row.action,
        (row.details ?? {}) as AuditDetails,
        actor,
        (id) => assigneeNameById.get(id) ?? null,
      );
      if (!formatted) return null;
      return {
        id: row.id,
        type: "system" as const,
        action: row.action,
        kind: formatted.kind,
        text: formatted.text,
        actor: row.user
          ? {
              id: row.user.id,
              name: row.user.name,
              email: row.user.email,
              handle: row.user.handle,
              avatarUrl: row.user.avatarUrl,
            }
          : null,
        at: row.createdAt as Date | string,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  // ─── Synthesised events from eBay order context ─────────────────────────────
  // These don't live in AuditLog because they're upstream eBay facts, not
  // actions taken inside reorG. We share the right-rail's order-context cache
  // and intentionally do NOT block on a fresh fetch when the entry is cold —
  // that lookup adds 1-3s per ticket open and the right-rail will populate
  // the cache for the next reload anyway. Failure is non-fatal — the audit-
  // derived rows still render and the timeline degrades to message-only.
  const platform = exists.integration?.platform;
  const isEbay = platform === "TPP_EBAY" || platform === "TT_EBAY";
  if (isEbay && exists.ebayOrderNumber && exists.integration) {
    try {
      const config = buildEbayConfig({ config: exists.integration.config });
      const ctx = await getOrderContextCached(
        exists.integration.id,
        config,
        exists.ebayOrderNumber,
        { awaitFresh: false },
      );
      if (ctx) {
        if (ctx.createdTime) {
          events.push({
            id: `order-received-${exists.ebayOrderNumber}`,
            type: "system" as const,
            action: "EBAY_ORDER_RECEIVED",
            kind: "order_received",
            text: "Order received",
            actor: null,
            at: ctx.createdTime,
          });
        }
        if (ctx.shippedTime) {
          events.push({
            id: `order-shipped-${exists.ebayOrderNumber}`,
            type: "system" as const,
            action: "EBAY_ORDER_SHIPPED",
            kind: "order_shipped",
            text:
              ctx.trackingCarrier && ctx.trackingNumber
                ? `Order shipped via ${ctx.trackingCarrier}`
                : "Order shipped",
            actor: null,
            at: ctx.shippedTime,
          });
        }
      }
    } catch (err) {
      console.warn("[helpdesk/events] order context fetch failed", err);
    }
  }

  // ─── Synthesised events from eBay action mirrors ────────────────────────────
  // HelpdeskCase / HelpdeskFeedback / HelpdeskCancellation are populated by
  // the eBay action workers (Returns, Feedback, Cancellation APIs). They're
  // NOT audit rows because the actor is the buyer/eBay, not a reorG user.
  // We render them inline so an agent reading the thread sees the buyer's
  // out-of-band escalations in the same scroll as the message exchange.
  //
  // Each query is bounded by ticketId — these tables are small per-ticket
  // (a buyer rarely opens >2 cases on one order) so the round-trip cost is
  // negligible. Failure of any one of these is non-fatal: the timeline
  // degrades to whatever rendered, never breaks the whole reader.
  try {
    const [cases, feedback, cancellations] = await Promise.all([
      db.helpdeskCase.findMany({
        where: { ticketId: id },
        orderBy: { openedAt: "asc" },
        take: 50,
      }),
      db.helpdeskFeedback.findMany({
        where: { ticketId: id },
        orderBy: { leftAt: "asc" },
        take: 50,
      }),
      db.helpdeskCancellation.findMany({
        where: { ticketId: id },
        orderBy: { requestedAt: "asc" },
        take: 50,
      }),
    ]);

    for (const c of cases) {
      // HelpdeskCaseKind values map back to eBay's user-facing category
      // names. We surface the friendly labels in the timeline pill so the
      // agent doesn't have to translate eBay's acronyms in their head.
      const kindLabel =
        c.kind === "RETURN"
          ? "return"
          : c.kind === "NOT_AS_DESCRIBED"
            ? "INAD claim"
            : c.kind === "ITEM_NOT_RECEIVED"
              ? "item-not-received case"
              : c.kind === "CHARGEBACK"
                ? "chargeback"
                : "case";
      events.push({
        id: `case-opened-${c.id}`,
        type: "system" as const,
        action: "EBAY_CASE_OPENED",
        kind: "case" as const,
        text: `Buyer opened a ${kindLabel} on eBay`,
        actor: null,
        at: c.openedAt,
      });
      if (c.closedAt) {
        // We don't track a separate "outcome" column — the case's final
        // status (CLOSED/REFUNDED/CANCELLED) is itself the outcome we
        // surface. CLOSED is the generic "no further action" terminal
        // state, so we drop it from the label to keep the pill compact.
        const closeQualifier =
          c.status === "REFUNDED"
            ? " — refunded"
            : c.status === "CANCELLED"
              ? " — cancelled"
              : "";
        events.push({
          id: `case-closed-${c.id}`,
          type: "system" as const,
          action: "EBAY_CASE_CLOSED",
          kind: "case" as const,
          text: `eBay closed the ${kindLabel}${closeQualifier}`,
          actor: null,
          at: c.closedAt,
        });
      }
    }

    for (const f of feedback) {
      const ratingLabel =
        f.kind === "POSITIVE"
          ? "positive feedback"
          : f.kind === "NEGATIVE"
            ? "negative feedback"
            : "neutral feedback";
      const stars =
        typeof f.starRating === "number" && f.starRating > 0
          ? ` (${f.starRating}★)`
          : "";
      events.push({
        id: `feedback-${f.id}`,
        type: "system" as const,
        action: "EBAY_FEEDBACK_LEFT",
        kind: "feedback" as const,
        text: `Buyer left ${ratingLabel}${stars}${f.comment ? `: "${f.comment.slice(0, 120)}"` : ""}`,
        actor: null,
        at: f.leftAt,
      });
    }

    for (const cn of cancellations) {
      events.push({
        id: `cancel-req-${cn.id}`,
        type: "system" as const,
        action: "EBAY_CANCEL_REQUESTED",
        kind: "cancel" as const,
        text: `Buyer requested cancellation${cn.reason ? ` — ${cn.reason.toLowerCase()}` : ""}`,
        actor: null,
        at: cn.requestedAt,
      });
      if (cn.resolvedAt) {
        // HelpdeskCancellationStatus terminal values:
        //   APPROVED            — seller approved the request
        //   REJECTED            — seller declined
        //   COMPLETED           — cancellation completed (refund issued)
        //   CANCELLED_BY_BUYER  — buyer revoked their own request
        const decided =
          cn.status === "APPROVED"
            ? "approved"
            : cn.status === "REJECTED"
              ? "denied"
              : cn.status === "COMPLETED"
                ? "completed"
                : cn.status === "CANCELLED_BY_BUYER"
                  ? "withdrawn by buyer"
                  : "closed";
        events.push({
          id: `cancel-res-${cn.id}`,
          type: "system" as const,
          action: "EBAY_CANCEL_RESOLVED",
          kind: "cancel" as const,
          text: `Cancellation ${decided}`,
          actor: null,
          at: cn.resolvedAt,
        });
      }
    }
  } catch (err) {
    // The mirror tables may not exist yet on a freshly migrated DB; log and
    // continue rather than 500-ing the timeline.
    console.warn("[helpdesk/events] eBay mirror tables fetch failed", err);
  }

  // Re-sort with all synthesised events folded in.
  events.sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );

  return NextResponse.json({ data: events });
}
