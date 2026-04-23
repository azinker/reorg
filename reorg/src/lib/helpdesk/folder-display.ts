/**
 * Client-safe folder display helpers for the Help Desk.
 *
 * Mirrors the folder keys/labels defined in `folders.ts` but carries NO
 * Prisma runtime dependency — so it can be imported from client components
 * (e.g. the ticket triage bar) without pulling `@prisma/client` into the
 * browser bundle.
 *
 * The canonical definitions (WHERE clauses, routing) live in `folders.ts`
 * on the server. This file just knows how to turn a live ticket record
 * into its human-visible folder name for per-ticket UI.
 */

export type HelpdeskFolderKey =
  | "pre_sales"
  | "my_tickets"
  | "all_tickets"
  | "all_new"
  | "all_to_do"
  | "all_to_do_unread"
  | "all_to_do_awaiting"
  | "all_waiting"
  | "buyer_cancellation"
  | "from_ebay"
  | "snoozed"
  | "resolved"
  | "unassigned"
  | "mentioned"
  | "favorites"
  | "spam"
  | "archived";

/**
 * Must match `FOLDER_LABELS` in `folders.ts`. Kept as a string map here so
 * the client can render folder names without a Prisma dependency.
 */
export const FOLDER_LABELS: Record<HelpdeskFolderKey, string> = {
  pre_sales: "Pre-sales",
  my_tickets: "My Tickets",
  all_tickets: "All Tickets",
  all_new: "New",
  all_to_do: "To Do",
  all_to_do_unread: "Unread",
  all_to_do_awaiting: "Read",
  all_waiting: "Waiting",
  buyer_cancellation: "Buyer Request Cancellation",
  from_ebay: "From eBay",
  snoozed: "Snoozed",
  resolved: "Resolved",
  unassigned: "Unassigned",
  mentioned: "Mentioned",
  favorites: "Favorites",
  spam: "Spam",
  archived: "Archived",
};

// Mirror of BUYER_CANCELLATION_TAG_NAME from `folders.ts`. Duplicated as a
// plain string constant so the client doesn't have to import from the
// Prisma-heavy server module.
const BUYER_CANCELLATION_TAG_NAME = "Buyer Request Cancellation";

/**
 * Derive the *primary* folder a live ticket belongs to from its own fields —
 * mirrors the precedence used by the sidebar query (exclusions win, then
 * state, then routing). The triage bar uses this so the agent always sees
 * "this ticket is in <folder>" without having to thread the currently
 * selected sidebar folder through every render path.
 *
 * Precedence (first match wins):
 *   1.  Archived              → Archived
 *   2.  Spam (status=SPAM)    → Spam
 *   3.  Snoozed (future)      → Snoozed
 *   4.  Resolved              → Resolved
 *   5.  type=SYSTEM           → From eBay
 *   6.  Cancellation tag      → Buyer Request Cancellation
 *   7.  kind=PRE_SALES        → Pre-sales
 *   8.  status=WAITING        → Waiting
 *   9.  unreadCount > 0       → To Do · Unread
 *  10.  otherwise             → To Do · Read
 *
 * The precedence must stay in lockstep with the `buildFolderWhere` clauses
 * in `folders.ts` — if a sidebar exclusion changes, update both.
 */
export function deriveTicketFolder(ticket: {
  status: string;
  isArchived: boolean;
  isSpam: boolean;
  type: string;
  kind: string;
  snoozedUntil: string | Date | null;
  unreadCount: number;
  tags?: { name: string }[] | null;
}): HelpdeskFolderKey {
  if (ticket.isArchived) return "archived";
  if (ticket.isSpam || ticket.status === "SPAM") return "spam";
  if (ticket.snoozedUntil) {
    const until =
      ticket.snoozedUntil instanceof Date
        ? ticket.snoozedUntil
        : new Date(ticket.snoozedUntil);
    if (!Number.isNaN(until.getTime()) && until.getTime() > Date.now()) {
      return "snoozed";
    }
  }
  if (ticket.status === "RESOLVED") return "resolved";
  if (ticket.type === "SYSTEM") return "from_ebay";
  if (ticket.tags?.some((t) => t.name === BUYER_CANCELLATION_TAG_NAME)) {
    return "buyer_cancellation";
  }
  if (ticket.kind === "PRE_SALES") return "pre_sales";
  if (ticket.status === "WAITING") return "all_waiting";
  if (ticket.unreadCount > 0) return "all_to_do_unread";
  return "all_to_do_awaiting";
}
