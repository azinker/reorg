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
import { HelpdeskTicketType, Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  detectFromEbay,
  SYSTEM_MESSAGE_TYPE_LABELS,
  SYSTEM_MESSAGE_TYPES,
  type SystemMessageType,
} from "@/lib/helpdesk/from-ebay-detect";
import {
  buildEbayConfig,
  type EbayOrderContext,
} from "@/lib/services/auto-responder-ebay";
import { getOrderContextCached } from "@/lib/services/helpdesk-order-context-cache";
import {
  feedbackMirrorToSnapshot,
  fetchEbayFeedbackForOrderContext,
  isEbayAutomatedFeedbackSnapshot,
  type HelpdeskFeedbackSnapshot,
} from "@/lib/services/helpdesk-feedback";

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
  | "cross_listing"
  // Agent-folder moves — distinct from assign so the pill styling
  // can read as a routing action rather than a person-assignment.
  | "folder"
  // Synthesized from eBay order context (not from AuditLog).
  | "order_received"
  | "order_shipped";

interface FormattedEvent {
  kind: SystemEventKind;
  text: string;
  shortText?: string | null;
}

interface TimelineEvent {
  id: string;
  type: "system";
  action: string;
  kind: SystemEventKind;
  text: string;
  shortText?: string | null;
  href?: string | null;
  externalId?: string | null;
  actor: {
    id: string;
    name: string | null;
    email: string | null;
    handle: string | null;
    avatarUrl: string | null;
  } | null;
  at: Date | string;
}

type AuditDetails = Record<string, unknown> & {
  ticketIds?: unknown;
  status?: unknown;
  userId?: unknown;
  userIds?: unknown;
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
  agentFolderId?: unknown;
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

function formatNameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function formatSystemEvent(
  action: string,
  details: AuditDetails,
  actorName: string | null,
  resolveAssigneeName: (userId: string) => string | null,
  resolveFolderName: (folderId: string) => string | null,
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
      const rawIds = Array.isArray(details.userIds)
        ? details.userIds.filter((id): id is string => typeof id === "string")
        : null;
      if (rawIds) {
        if (rawIds.length === 0) {
          return { kind: "assign", text: `${who} cleared assignees` };
        }
        const names = rawIds.map((id) => resolveAssigneeName(id) ?? id);
        return {
          kind: "assign",
          text: `${who} assigned to ${formatNameList(names)}`,
        };
      }
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
    case "HELPDESK_TICKET_FOLDER_CHANGED": {
      const rawId = details.agentFolderId;
      if (rawId === null) {
        return { kind: "folder", text: `${who} removed from folder` };
      }
      if (typeof rawId !== "string") {
        return { kind: "folder", text: `${who} moved the ticket to a folder` };
      }
      const folderName = resolveFolderName(rawId);
      if (folderName) {
        return {
          kind: "folder",
          text: `${who} moved to ${folderName}`,
        };
      }
      return { kind: "folder", text: `${who} moved the ticket to a folder` };
    }
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

function isKnownSystemMessageType(value: string | null): value is SystemMessageType {
  return value != null && value in SYSTEM_MESSAGE_TYPE_LABELS;
}

function systemTicketTimelineText(args: {
  systemMessageType: string | null;
  subject: string | null;
  bodyText: string | null;
}): { text: string; action: string; shortText?: string | null } {
  const subject = args.subject?.trim() || null;
  const body = args.bodyText?.trim() || "";
  const detected =
    !args.systemMessageType ||
    args.systemMessageType === SYSTEM_MESSAGE_TYPES.OTHER_EBAY_NOTIFICATION
      ? detectFromEbay({ sender: "eBay", subject, bodyText: body })
      : null;
  const type = detected?.isFromEbay
    ? detected.systemMessageType
    : args.systemMessageType;
  const haystack = `${subject ?? ""} ${body}`.toLowerCase();
  const label = isKnownSystemMessageType(type)
    ? SYSTEM_MESSAGE_TYPE_LABELS[type]
    : subject ?? "eBay notification";

  switch (type) {
    case SYSTEM_MESSAGE_TYPES.ITEM_NOT_RECEIVED:
      return {
        action: "EBAY_ITEM_NOT_RECEIVED_CASE",
        text: "Buyer Opened Item Not Received Claim on eBay",
        shortText: "Buyer Opened INR Case",
      };
    case SYSTEM_MESSAGE_TYPES.CASE_OPENED:
      return {
        action: "EBAY_CASE_OPENED",
        text: "Buyer Opened Case on eBay",
        shortText: "Buyer Opened Case",
      };
    case SYSTEM_MESSAGE_TYPES.CASE_ON_HOLD:
      return {
        action: "EBAY_CASE_ON_HOLD",
        text: "eBay Placed Case On Hold",
        shortText: "Case On Hold",
      };
    case SYSTEM_MESSAGE_TYPES.CASE_CLOSED:
      return {
        action: "EBAY_CASE_CLOSED",
        text:
          haystack.includes("buyer") && haystack.includes("closed")
            ? "Buyer Closed Case on eBay"
            : "eBay Closed Case",
        shortText:
          haystack.includes("buyer") && haystack.includes("closed")
            ? "Buyer Closed Case"
            : "Case Closed",
      };
    case SYSTEM_MESSAGE_TYPES.RETURN_REQUEST:
      return {
        action: "EBAY_RETURN_OPENED",
        text: "Buyer Opened Return Case on eBay",
        shortText: "Buyer Opened Return",
      };
    case SYSTEM_MESSAGE_TYPES.RETURN_APPROVED:
      return {
        action: "EBAY_RETURN_APPROVED",
        text: "Return Approved on eBay",
        shortText: "Return Approved",
      };
    case SYSTEM_MESSAGE_TYPES.RETURN_CLOSED:
      return {
        action: "EBAY_RETURN_CLOSED",
        text: "Return Closed on eBay",
        shortText: "Return Closed",
      };
    case SYSTEM_MESSAGE_TYPES.CANCELLATION_REQUEST:
      return {
        action: "EBAY_CANCEL_REQUESTED",
        text: "Buyer Requested Cancellation on eBay",
        shortText: "Cancel Requested",
      };
    case SYSTEM_MESSAGE_TYPES.CANCELLATION_CONFIRMED:
      return {
        action: "EBAY_CANCEL_CONFIRMED",
        text: "Order Cancellation Confirmed on eBay",
        shortText: "Cancel Confirmed",
      };
    case SYSTEM_MESSAGE_TYPES.REFUND_ISSUED:
      return {
        action: "EBAY_REFUND_ISSUED",
        text: "Refund Issued on eBay",
        shortText: "Refund Issued",
      };
    case SYSTEM_MESSAGE_TYPES.REFUND_REQUESTED:
      return {
        action: "EBAY_REFUND_REQUESTED",
        text: "Refund Requested on eBay",
        shortText: "Refund Requested",
      };
    case SYSTEM_MESSAGE_TYPES.ITEM_DELIVERED:
      return {
        action: "EBAY_ITEM_DELIVERED",
        text: "eBay Marked Item Delivered",
        shortText: "Item Delivered",
      };
    case SYSTEM_MESSAGE_TYPES.BUYER_SHIPPED:
      return {
        action: "EBAY_BUYER_SHIPPED",
        text: "Buyer Shipped Item Back",
        shortText: "Buyer Shipped Item",
      };
    default:
      return {
        action: "EBAY_SYSTEM_NOTIFICATION",
        text: `eBay notification: ${label}`,
      };
  }
}

function compactTimelineLabel(action: string, text: string): string {
  switch (action) {
    case "EBAY_ITEM_NOT_RECEIVED_CASE":
      return "Buyer Opened INR Case";
    case "EBAY_CASE_OPENED":
      return /return/i.test(text) ? "Buyer Opened Return" : "Buyer Opened Case";
    case "EBAY_CASE_ON_HOLD":
      return "Case On Hold";
    case "EBAY_CASE_CLOSED":
      return /buyer/i.test(text) ? "Buyer Closed Case" : "Case Closed";
    case "EBAY_RETURN_OPENED":
      return "Buyer Opened Return";
    case "EBAY_RETURN_APPROVED":
      return "Return Approved";
    case "EBAY_RETURN_CLOSED":
      return "Return Closed";
    case "EBAY_CANCEL_REQUESTED":
      return "Cancel Requested";
    case "EBAY_CANCEL_CONFIRMED":
      return "Cancel Confirmed";
    case "EBAY_REFUND_ISSUED":
      return "Refund Issued";
    case "EBAY_REFUND_REQUESTED":
      return "Refund Requested";
    case "EBAY_ITEM_DELIVERED":
      return "Item Delivered";
    case "EBAY_BUYER_SHIPPED":
      return "Buyer Shipped Item";
    default:
      return text;
  }
}

function stripHtmlToPlainText(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#8202;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&copy;/gi, "(c)")
    .replace(/&zwnj;/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

const EBAY_DATE_MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function parseEbayDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const month = EBAY_DATE_MONTHS[match[1]!.toLowerCase()];
  if (month == null) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!Number.isFinite(day) || !Number.isFinite(year)) return null;
  // eBay system emails often only include a date ("Case opened Apr 15,
  // 2026"). Noon Eastern-ish in UTC preserves the calendar day in the UI
  // while keeping the synthesized event clearly approximate.
  return new Date(Date.UTC(year, month, day, 16, 0, 0)).toISOString();
}

function extractEbayCaseUrl(bodyText: string | null | undefined): string | null {
  const raw = (bodyText ?? "").replace(/&amp;/gi, "&");
  const direct =
    /https?:\/\/www\.ebay\.com\/res\/ItemNotReceived\/ViewRequest\?id=\d+[^"'<>\s]*/i.exec(
      raw,
    )?.[0] ??
    /https?:\/\/www\.ebay\.com\/ItemNotReceived\/\?[^"'<>\s]*/i.exec(raw)?.[0] ??
    null;
  if (!direct) return null;
  try {
    const url = new URL(direct);
    if (!url.hostname.endsWith("ebay.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function extractEbayRequestContext(args: {
  subject: string | null;
  bodyText: string | null;
}): {
  caseId: string | null;
  href: string | null;
  longCaseLabel: string;
  shortCaseLabel: string;
  openedAt: string | null;
  isDeliveredUpdate: boolean;
  isClosed: boolean;
  closedByBuyer: boolean;
} {
  const plain = stripHtmlToPlainText(args.bodyText);
  const subject = args.subject ?? "";
  const haystack = `${subject} ${plain}`;
  const caseId =
    /ViewRequest\?id=(\d{6,})/i.exec(args.bodyText ?? "")?.[1] ??
    /\/mesh\/returns\/(\d{6,})/i.exec(args.bodyText ?? "")?.[1] ??
    /Return\s+(\d{6,})/i.exec(subject)?.[1] ??
    /Request\s+#\s*:?\s*(\d{6,})/i.exec(haystack)?.[1] ??
    /Request\s+#(\d{6,})/i.exec(haystack)?.[1] ??
    /Case\s+ID\s*:?\s*(\d{6,})/i.exec(haystack)?.[1] ??
    null;
  const openedDate =
    /(?:Request|Case)\s+opened:?\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/i.exec(
      haystack,
    )?.[1] ?? null;
  const href =
    extractEbayCaseUrl(args.bodyText) ??
    (caseId ? `https://www.ebay.com/res/ItemNotReceived/ViewRequest?id=${caseId}` : null);
  const isInr =
    /ItemNotReceived/i.test(args.bodyText ?? "") ||
    /item\s+not\s+received|not\s+received\s+request|hasn'?t\s+arrived/i.test(haystack) ||
    /buyer'?s\s+item\s+arrived|shipping\s+status\s+shows.*delivered/i.test(haystack);
  const isReturn =
    !isInr &&
    (/\/mesh\/returns\//i.test(args.bodyText ?? "") ||
      /return\s+(case|request)|buyer\s+opened\s+a\s+return|new\s+return\s+request/i.test(
        haystack,
      ));
  const isDeliveredUpdate =
    /buyer'?s\s+item\s+arrived|shipping\s+status\s+shows.*delivered|item\s+has\s+arrived/i.test(
      haystack,
    );
  const closedByBuyer =
    /closed\s+by\s+the\s+buyer|buyer\s+has\s+closed\s+this\s+request|the\s+buyer\s+closed\s+this\s+request/i.test(
      haystack,
    );
  const isClosed =
    closedByBuyer ||
    /case\s+closed|case\s+is\s+now\s+closed|request\s+was\s+closed/i.test(haystack);

  return {
    caseId,
    href,
    longCaseLabel: isInr
      ? "Item Not Received Claim"
      : isReturn
        ? "Return Case"
        : "Case",
    shortCaseLabel: isInr ? "INR Case" : isReturn ? "Return Case" : "Case",
    openedAt: parseEbayDateOnly(openedDate),
    isDeliveredUpdate,
    isClosed,
    closedByBuyer,
  };
}

function systemTicketTimelineEvents(args: {
  ticketId: string;
  messageId: string | null;
  systemMessageType: string | null;
  subject: string | null;
  bodyText: string | null;
  at: Date | string;
}): TimelineEvent[] {
  const ctx = extractEbayRequestContext({
    subject: args.subject,
    bodyText: args.bodyText,
  });
  const events: TimelineEvent[] = [];
  const baseId = args.messageId ?? args.ticketId;

  if (ctx.caseId && ctx.openedAt) {
    events.push({
      id: `related-case-opened-${baseId}-${ctx.caseId}`,
      type: "system",
      action: "EBAY_CASE_OPENED",
      kind: "case",
      text: `Buyer Opened ${ctx.longCaseLabel} #${ctx.caseId} on eBay`,
      shortText: `Buyer Opened ${ctx.shortCaseLabel}`,
      href: ctx.href,
      externalId: ctx.caseId,
      actor: null,
      at: ctx.openedAt,
    });
  }

  if (ctx.caseId && ctx.isDeliveredUpdate) {
    events.push({
      id: `related-case-delivered-${baseId}-${ctx.caseId}`,
      type: "system",
      action: "EBAY_ITEM_DELIVERED",
      kind: "case",
      text: `eBay Marked Item Delivered For ${ctx.longCaseLabel} #${ctx.caseId} on eBay`,
      shortText: `${ctx.shortCaseLabel} Shows Delivered`,
      href: ctx.href,
      externalId: ctx.caseId,
      actor: null,
      at: args.at,
    });
  }

  if (ctx.caseId && ctx.isClosed) {
    events.push({
      id: `related-case-closed-${baseId}-${ctx.caseId}`,
      type: "system",
      action: "EBAY_CASE_CLOSED",
      kind: "case",
      text: `${
        ctx.closedByBuyer ? "Buyer Closed" : "eBay Closed"
      } ${ctx.longCaseLabel} #${ctx.caseId} on eBay`,
      shortText: `${ctx.closedByBuyer ? "Buyer Closed" : "eBay Closed"} ${
        ctx.shortCaseLabel
      }`,
      href: ctx.href,
      externalId: ctx.caseId,
      actor: null,
      at: args.at,
    });
  }

  if (events.length > 0) return events;

  const formatted = systemTicketTimelineText({
    systemMessageType: args.systemMessageType,
    subject: args.subject,
    bodyText: args.bodyText,
  });
  return [
    {
      id: `related-system-${baseId}`,
      type: "system",
      action: formatted.action,
      kind: "case",
      text: formatted.text,
      shortText: formatted.shortText ?? compactTimelineLabel(formatted.action, formatted.text),
      actor: null,
      at: args.at,
    },
  ];
}

function dedupeTimelineEvents(events: TimelineEvent[]): TimelineEvent[] {
  const seen = new Set<string>();
  const out: TimelineEvent[] = [];
  for (const event of events) {
    const atMs = new Date(event.at).getTime();
    const minute = Number.isFinite(atMs) ? Math.floor(atMs / 60_000) : 0;
    const day = Number.isFinite(atMs)
      ? new Date(atMs).toISOString().slice(0, 10)
      : "unknown-day";
    const key = event.externalId
      ? `${event.kind}|${event.action}|${event.externalId}|${day}`
      : `${event.kind}|${event.action}|${event.text}|${minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function crossListingTimelineEvent(message: {
  id: string;
  sentAt: Date;
  rawData: Prisma.JsonValue;
}): TimelineEvent | null {
  const raw = asRecord(message.rawData);
  const ctx = asRecord(raw?.crossListingInquiry);
  if (!ctx) return null;
  const itemId = nonEmptyString(ctx.sourceItemId);
  const itemTitle = nonEmptyString(ctx.sourceItemTitle);
  const href =
    nonEmptyString(ctx.sourceItemUrl) ??
    (itemId ? `https://www.ebay.com/itm/${itemId}` : null);
  const subject = nonEmptyString(ctx.sourceSubject);
  const label = itemTitle ?? subject ?? (itemId ? `item #${itemId}` : "another item");
  return {
    id: `cross-listing-${message.id}`,
    type: "system",
    action: "HELPDESK_CROSS_LISTING_INQUIRY",
    kind: "cross_listing",
    text: `Buyer Messaged From Another Listing: ${label}${itemId ? ` #${itemId}` : ""}`,
    shortText: itemId ? `From Another Item #${itemId}` : "From Another Item",
    href,
    externalId: itemId,
    actor: null,
    at: message.sentAt,
  };
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
      ebayItemId: true,
      buyerUserId: true,
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
      if (Array.isArray(details.userIds)) {
        for (const id of details.userIds) {
          if (typeof id === "string") assigneeIds.add(id);
        }
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

  // Resolve any agent-folder ids referenced by FOLDER_CHANGED rows so the
  // timeline can render "Adam moved to Follow-up" instead of a raw id.
  // Same one-shot pattern as the assignee lookup above — never N+1.
  const folderIds = new Set<string>();
  for (const row of auditRows) {
    if (row.action !== "HELPDESK_TICKET_FOLDER_CHANGED") continue;
    const details = (row.details ?? {}) as AuditDetails;
    if (typeof details.agentFolderId === "string") {
      folderIds.add(details.agentFolderId);
    }
  }
  const folderNameById = new Map<string, string>();
  if (folderIds.size > 0) {
    const folders = await db.helpdeskAgentFolder.findMany({
      where: { id: { in: Array.from(folderIds) } },
      select: { id: true, name: true },
    });
    for (const f of folders) {
      if (f.name) folderNameById.set(f.id, f.name);
    }
  }

  const events: TimelineEvent[] = auditRows
    .map((row) => {
      const actor = row.user
        ? row.user.name ?? row.user.handle ?? row.user.email ?? null
        : null;
      const formatted = formatSystemEvent(
        row.action,
        (row.details ?? {}) as AuditDetails,
        actor,
        (id) => assigneeNameById.get(id) ?? null,
        (id) => folderNameById.get(id) ?? null,
      );
      if (!formatted) return null;
      return {
        id: row.id,
        type: "system" as const,
        action: row.action,
        kind: formatted.kind,
        text: formatted.text,
        shortText: formatted.shortText ?? null,
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
  let orderCtxForEvents: EbayOrderContext | null | undefined = undefined;
  if (isEbay && exists.ebayOrderNumber && exists.integration) {
    try {
      const config = buildEbayConfig({ config: exists.integration.config });
      const ctx = await getOrderContextCached(
        exists.integration.id,
        config,
        exists.ebayOrderNumber,
        { awaitFresh: false },
      );
      orderCtxForEvents = ctx;
      if (ctx) {
        if (ctx.createdTime) {
          events.push({
            id: `order-received-${exists.ebayOrderNumber}`,
            type: "system" as const,
            action: "EBAY_ORDER_RECEIVED",
            kind: "order_received",
            text: "Order received",
            shortText: "Order Received",
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
            shortText: "Order Shipped",
            actor: null,
            at: ctx.shippedTime,
          });
        }
      }
    } catch (err) {
      console.warn("[helpdesk/events] order context fetch failed", err);
      orderCtxForEvents = null;
    }
  }

  // ─── Synthesised events from eBay action mirrors ────────────────────────────
  // Cross-listing buyer questions. These are normal buyer messages that came
  // from a different item after the buyer already had an order. The message is
  // stored on the order ticket, and this pill gives the agent the missing
  // context with a direct link to the listing the buyer used.
  const crossListingMessages = await db.helpdeskMessage.findMany({
    where: { ticketId: id, deletedAt: null },
    orderBy: [{ sentAt: "asc" }, { createdAt: "asc" }],
    take: 500,
    select: {
      id: true,
      sentAt: true,
      rawData: true,
    },
  });
  for (const message of crossListingMessages) {
    const event = crossListingTimelineEvent(message);
    if (event) events.push(event);
  }

  const relatedTicketPredicates: Prisma.HelpdeskTicketWhereInput[] = [];
  if (exists.ebayOrderNumber) {
    relatedTicketPredicates.push({ ebayOrderNumber: exists.ebayOrderNumber });
  } else if (exists.buyerUserId && exists.ebayItemId) {
    relatedTicketPredicates.push({
      buyerUserId: {
        equals: exists.buyerUserId,
        mode: Prisma.QueryMode.insensitive,
      },
      ebayItemId: exists.ebayItemId,
    });
  }

  const relatedSystemTickets =
    relatedTicketPredicates.length > 0 && exists.integration
      ? await db.helpdeskTicket.findMany({
          where: {
            id: { not: id },
            integrationId: exists.integration.id,
            AND: [
              { OR: relatedTicketPredicates },
              {
                OR: [
                  { type: HelpdeskTicketType.SYSTEM },
                  { threadKey: { startsWith: "sys:" } },
                  { systemMessageType: { not: null } },
                ],
              },
            ],
          },
          select: {
            id: true,
            subject: true,
            systemMessageType: true,
            createdAt: true,
            lastBuyerMessageAt: true,
            lastAgentMessageAt: true,
            messages: {
              where: { deletedAt: null },
              orderBy: { sentAt: "asc" },
              take: 25,
              select: {
                id: true,
                subject: true,
                bodyText: true,
                sentAt: true,
              },
            },
          },
          orderBy: [{ createdAt: "asc" }],
          take: 25,
        })
      : [];

  const relatedTicketIds = [id, ...relatedSystemTickets.map((t) => t.id)];

  for (const ticket of relatedSystemTickets) {
    const systemMessages =
      ticket.messages.length > 0
        ? ticket.messages
        : [
            {
              id: null,
              subject: ticket.subject,
              bodyText: null,
              sentAt:
                ticket.lastBuyerMessageAt ??
                ticket.lastAgentMessageAt ??
                ticket.createdAt,
            },
          ];
    for (const message of systemMessages) {
      events.push(
        ...systemTicketTimelineEvents({
          ticketId: ticket.id,
          messageId: message.id,
          systemMessageType: ticket.systemMessageType,
          subject: message.subject ?? ticket.subject,
          bodyText: message.bodyText ?? null,
          at:
            message.sentAt ??
            ticket.lastBuyerMessageAt ??
            ticket.lastAgentMessageAt ??
            ticket.createdAt,
        }),
      );
    }
  }

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
    const orderMirrorFilter =
      exists.integration && exists.ebayOrderNumber
        ? {
            integrationId: exists.integration.id,
            ebayOrderNumber: exists.ebayOrderNumber,
          }
        : null;
    const buyerMirrorFilter =
      exists.integration && !exists.ebayOrderNumber && exists.buyerUserId
        ? {
            integrationId: exists.integration.id,
            buyerUserId: {
              equals: exists.buyerUserId,
              mode: Prisma.QueryMode.insensitive,
            },
          }
        : null;
    const caseMirrorOr: Prisma.HelpdeskCaseWhereInput[] = [
      { ticketId: { in: relatedTicketIds } },
    ];
    const feedbackMirrorOr: Prisma.HelpdeskFeedbackWhereInput[] = [];
    const cancellationMirrorOr: Prisma.HelpdeskCancellationWhereInput[] = [
      { ticketId: { in: relatedTicketIds } },
    ];
    if (orderMirrorFilter) {
      caseMirrorOr.push(orderMirrorFilter);
      feedbackMirrorOr.push(orderMirrorFilter);
      cancellationMirrorOr.push(orderMirrorFilter);
    }
    if (buyerMirrorFilter) {
      caseMirrorOr.push(buyerMirrorFilter);
      cancellationMirrorOr.push(buyerMirrorFilter);
    }

    const [cases, feedback, cancellations] = await Promise.all([
      db.helpdeskCase.findMany({
        where: { OR: caseMirrorOr },
        orderBy: { openedAt: "asc" },
        take: 50,
      }),
      feedbackMirrorOr.length > 0
        ? db.helpdeskFeedback.findMany({
            where: { OR: feedbackMirrorOr },
            orderBy: { leftAt: "asc" },
            take: 50,
          })
        : Promise.resolve([]),
      db.helpdeskCancellation.findMany({
        where: { OR: cancellationMirrorOr },
        orderBy: { requestedAt: "asc" },
        take: 50,
      }),
    ]);
    let feedbackSnapshots: HelpdeskFeedbackSnapshot[] = feedback.map(
      feedbackMirrorToSnapshot,
    ).filter((entry) => !isEbayAutomatedFeedbackSnapshot(entry));
    if (
      feedbackSnapshots.length === 0 &&
      isEbay &&
      exists.ebayOrderNumber &&
      exists.integration
    ) {
      try {
        const config = buildEbayConfig({ config: exists.integration.config });
        let ctx = orderCtxForEvents;
        if (ctx === undefined) {
          ctx = await getOrderContextCached(
            exists.integration.id,
            config,
            exists.ebayOrderNumber,
            { awaitFresh: true },
          );
        }
        if (ctx) {
          feedbackSnapshots = await fetchEbayFeedbackForOrderContext({
            integrationId: exists.integration.id,
            config,
            order: ctx,
          });
        }
      } catch (err) {
        console.warn("[helpdesk/events] live feedback fetch failed", err);
      }
    }

    for (const c of cases) {
      // HelpdeskCaseKind values map back to eBay's user-facing category
      // names. We surface the friendly labels in the timeline pill so the
      // agent doesn't have to translate eBay's acronyms in their head.
      const kindLabel =
        c.kind === "RETURN"
          ? "Return Case"
          : c.kind === "NOT_AS_DESCRIBED"
            ? "INAD Claim"
            : c.kind === "ITEM_NOT_RECEIVED"
              ? "Item Not Received Claim"
              : c.kind === "CHARGEBACK"
                ? "Chargeback Case"
                : "Case";
      const shortCaseLabel =
        c.kind === "RETURN"
          ? "Return Case"
          : c.kind === "NOT_AS_DESCRIBED"
            ? "INAD Claim"
            : c.kind === "ITEM_NOT_RECEIVED"
              ? "INR Case"
              : c.kind === "CHARGEBACK"
                ? "Chargeback"
                : "Case";
      events.push({
        id: `case-opened-${c.id}`,
        type: "system" as const,
        action: "EBAY_CASE_OPENED",
        kind: "case" as const,
        text: `Buyer Opened ${kindLabel} #${c.externalId} on eBay`,
        shortText: `Buyer Opened ${shortCaseLabel}`,
        href: c.manageUrl,
        externalId: c.externalId,
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
          text: `eBay Closed ${kindLabel} #${c.externalId}${closeQualifier}`,
          shortText: `${shortCaseLabel} Closed`,
          href: c.manageUrl,
          externalId: c.externalId,
          actor: null,
          at: c.closedAt,
        });
      }
    }

    for (const f of feedbackSnapshots) {
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
        shortText:
          f.kind === "POSITIVE"
            ? "Positive Feedback"
            : f.kind === "NEGATIVE"
              ? "Negative Feedback"
              : "Neutral Feedback",
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
        shortText: "Cancel Requested",
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
          shortText: `Cancel ${decided}`,
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
  const dedupedEvents = dedupeTimelineEvents(events);
  dedupedEvents.sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );

  return NextResponse.json({ data: dedupedEvents });
}
