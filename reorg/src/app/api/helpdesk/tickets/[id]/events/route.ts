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
  | "assign"
  | "tag"
  | "spam"
  | "archive"
  | "filter"
  | "case"
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
  isSpam?: unknown;
  isArchived?: unknown;
  isRead?: unknown;
  tagIds?: unknown;
  count?: unknown;
  filterId?: unknown;
  filterName?: unknown;
  caseType?: unknown;
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

function formatSystemEvent(
  action: string,
  details: AuditDetails,
  actorName: string | null,
): FormattedEvent | null {
  const who = actorName ?? "System";

  // Per-ticket actions written by the batch endpoint.
  switch (action) {
    case "HELPDESK_TICKET_OPENED":
      return { kind: "open", text: `${who} opened the ticket` };

    case "HELPDESK_BATCH_SETSTATUS":
    case "HELPDESK_TICKET_STATUS_CHANGED": {
      const status = formatHumanStatus(details.status);
      return { kind: "status", text: `${who} marked the ticket as ${status}` };
    }
    case "HELPDESK_BATCH_ASSIGNPRIMARY":
    case "HELPDESK_TICKET_ASSIGNED": {
      // We don't resolve the assignee's display name here — the audit log
      // stores the user id. Surfacing "assigned" is the important signal.
      const assigneeId = details.userId;
      if (assigneeId === null) {
        return { kind: "assign", text: `${who} unassigned the ticket` };
      }
      return { kind: "assign", text: `${who} assigned the ticket` };
    }
    case "HELPDESK_BATCH_ADDTAGS":
      return { kind: "tag", text: `${who} added a tag` };
    case "HELPDESK_BATCH_REMOVETAGS":
      return { kind: "tag", text: `${who} removed a tag` };
    case "HELPDESK_BATCH_MARKSPAM":
      return {
        kind: "spam",
        text:
          details.isSpam === true
            ? `${who} marked the ticket as spam`
            : `${who} unmarked the ticket as spam`,
      };
    case "HELPDESK_BATCH_ARCHIVE":
      return {
        kind: "archive",
        text:
          details.isArchived === true
            ? `${who} archived the ticket`
            : `${who} restored the ticket`,
      };
    case "HELPDESK_BATCH_MARKREAD":
      return {
        kind: "read",
        text:
          details.isRead === true
            ? `${who} marked the ticket as read`
            : `${who} marked the ticket as unread`,
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
    case "HELPDESK_TICKET_RESOLVED":
      return { kind: "status", text: `${who} marked the ticket as Resolved` };
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

  const events = auditRows
    .map((row) => {
      const actor = row.user
        ? row.user.name ?? row.user.handle ?? row.user.email ?? null
        : null;
      const formatted = formatSystemEvent(
        row.action,
        (row.details ?? {}) as AuditDetails,
        actor,
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

  // Re-sort with the synthesised events folded in.
  events.sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );

  return NextResponse.json({ data: events });
}
