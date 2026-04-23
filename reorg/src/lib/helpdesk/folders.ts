/**
 * Folder definitions for the Help Desk inbox sidebar. Each folder is a
 * server-side filter applied to HelpdeskTicket. Counts are computed once
 * and reused for badges.
 */

import {
  HelpdeskTicketStatus,
  HelpdeskTicketKind,
  HelpdeskTicketType,
  type Prisma,
} from "@prisma/client";

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
 * Tag name reserved for tickets that have been auto-routed by the
 * "Buyer Request Cancellation" filter. The tag is the storage mechanism for
 * the folder; the sidebar folder is just a saved query that asks for tickets
 * carrying this tag. Defined here so the folders module, the seed script, and
 * any future filter machinery agree on the spelling.
 */
export const BUYER_CANCELLATION_TAG_NAME = "Buyer Request Cancellation";

export interface HelpdeskFolderContext {
  /** Acting agent's User.id — required for "my_tickets" and "mentioned". */
  userId: string;
}

/**
 * Build a Prisma where clause for the given folder. Folder semantics
 * (v2 — NEW is folded into TO_DO so the agent has a single
 * "needs response" bucket):
 *
 *   - pre_sales:    open + kind=PRE_SALES (not snoozed, not archived, not spam, not cancellation)
 *   - my_tickets:   open + primary or additional assignee = me (not cancellation)
 *   - all_tickets:  open (every active status incl. snoozed-now-due, not cancellation).
 *                   This is the "All Messages" sidebar entry — shows NEW + TO_DO + WAITING.
 *   - all_new:      LEGACY ALIAS — now matches the same set as all_to_do.
 *                   Kept so any saved view / link / count cache that still
 *                   asks for "all_new" gets a reasonable answer instead of
 *                   silently dropping to 0. The sidebar no longer surfaces it.
 *   - all_to_do:    status ∈ {NEW, TO_DO} (not cancellation). NEW exists only
 *                   for historical rows from before the v2 routing change;
 *                   live mail now lands directly in TO_DO via
 *                   deriveStatusOnInbound, but legacy rows must still appear
 *                   here so the agent doesn't lose their existing queue.
 *   - all_waiting:  status=WAITING (not cancellation)
 *   - buyer_cancellation: open + carries the "Buyer Request Cancellation" tag
 *                         (auto-applied by the system filter on every sync)
 *   - snoozed:      snoozedUntil > now
 *   - resolved:     status=RESOLVED, not archived
 *   - unassigned:   open + primaryAssigneeId IS NULL (not cancellation)
 *   - mentioned:    has note where me ∈ mentions, ticket open (not cancellation)
 *   - favorites:    isFavorite=true, not archived (team-wide; any agent can
 *                   star or un-star a ticket and it shows up here for everyone)
 *   - spam:         status=SPAM, not archived
 *   - archived:     isArchived=true
 *
 * "Not cancellation" means tickets carrying the
 * BUYER_CANCELLATION_TAG_NAME tag are excluded from the general open
 * folders so they live exclusively in the dedicated "Cancel Requests"
 * folder. This matches the user's mental model — a cancellation request is
 * a distinct workflow, not a regular inbox ticket — and prevents double-
 * counting in the sidebar badges.
 */
export function buildFolderWhere(
  folder: HelpdeskFolderKey,
  ctx: HelpdeskFolderContext,
): Prisma.HelpdeskTicketWhereInput {
  const now = new Date();
  const openStatuses: HelpdeskTicketStatus[] = [
    HelpdeskTicketStatus.NEW,
    HelpdeskTicketStatus.TO_DO,
    HelpdeskTicketStatus.WAITING,
  ];
  const open: Prisma.HelpdeskTicketWhereInput = {
    status: { in: openStatuses },
    isArchived: false,
    isSpam: false,
  };
  const notSnoozed: Prisma.HelpdeskTicketWhereInput = {
    OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
  };
  // Re-used by every "open" folder below — buyer cancellation tickets are
  // siloed in their own folder and must NOT appear in the general inbox.
  const notCancellation: Prisma.HelpdeskTicketWhereInput = {
    NOT: {
      tags: {
        some: { tag: { name: BUYER_CANCELLATION_TAG_NAME } },
      },
    },
  };
  // Re-used by every "open" folder below — From-eBay system notifications
  // (Return Approved, Item Delivered, "We sent your payout", etc.) are
  // routed to the dedicated `from_ebay` sub-folder and must NOT appear in
  // All Tickets / To Do / Waiting / etc. Per the user spec, hardcoded sync
  // logic stamps `type=SYSTEM` so we can key off that single column instead
  // of subject-pattern guesswork.
  const notSystem: Prisma.HelpdeskTicketWhereInput = {
    type: { not: HelpdeskTicketType.SYSTEM },
  };

  switch (folder) {
    case "pre_sales":
      return {
        AND: [open, notSnoozed, notCancellation, notSystem, { kind: HelpdeskTicketKind.PRE_SALES }],
      };
    case "my_tickets":
      return {
        AND: [
          open,
          notSnoozed,
          notCancellation,
          notSystem,
          {
            OR: [
              { primaryAssigneeId: ctx.userId },
              { additionalAssignees: { some: { userId: ctx.userId } } },
            ],
          },
        ],
      };
    case "all_tickets":
      return { AND: [open, notSnoozed, notCancellation, notSystem] };
    case "all_new":
    case "all_to_do":
      // v2: TO_DO is the single "needs response" bucket. We accept legacy
      // NEW rows in the same query so historical tickets created before the
      // routing rewrite remain visible without a one-off backfill.
      return {
        AND: [
          {
            status: {
              in: [HelpdeskTicketStatus.NEW, HelpdeskTicketStatus.TO_DO],
            },
            isArchived: false,
            isSpam: false,
          },
          notSnoozed,
          notCancellation,
          notSystem,
        ],
      };
    case "all_to_do_unread":
      // v3: "Unread" sub-folder under To Do. The count shown here is the
      // one agents watch — it aligns with eBay's own "Unread from members"
      // badge because we only count tickets that still have at least one
      // unread buyer message. Auto-mark-read flips unreadCount to 0 when an
      // agent opens a ticket, moving it to the "Read" sibling.
      return {
        AND: [
          {
            status: {
              in: [HelpdeskTicketStatus.NEW, HelpdeskTicketStatus.TO_DO],
            },
            isArchived: false,
            isSpam: false,
            unreadCount: { gt: 0 },
          },
          notSnoozed,
          notCancellation,
          notSystem,
        ],
      };
    case "all_to_do_awaiting":
      // v3: "Read" sub-folder under To Do (formerly "Awaiting Reply"). Tickets
      // the agent has read (unreadCount=0) but hasn't responded to yet. Keeps
      // the overall pending workload visible without inflating the scary
      // "Unread" badge. Storage key stays `all_to_do_awaiting` so any saved
      // view / link / cached count keeps resolving correctly.
      return {
        AND: [
          {
            status: {
              in: [HelpdeskTicketStatus.NEW, HelpdeskTicketStatus.TO_DO],
            },
            isArchived: false,
            isSpam: false,
            unreadCount: 0,
          },
          notSnoozed,
          notCancellation,
          notSystem,
        ],
      };
    case "all_waiting":
      return {
        AND: [
          { status: HelpdeskTicketStatus.WAITING, isArchived: false, isSpam: false },
          notSnoozed,
          notCancellation,
          notSystem,
        ],
      };
    case "buyer_cancellation":
      // Open tickets that carry the reserved cancellation tag. We compare on
      // tag NAME (not id) so this folder keeps working even if the tag row is
      // recreated — the sidebar / counts route doesn't have to know an id.
      return {
        AND: [
          open,
          notSnoozed,
          {
            tags: {
              some: {
                tag: { name: BUYER_CANCELLATION_TAG_NAME },
              },
            },
          },
        ],
      };
    case "from_ebay":
      // Tickets stamped `type=SYSTEM` by the hardcoded From-eBay detector.
      // We deliberately drop the `open` status filter here — eBay system
      // notifications can land in any status (TO_DO/WAITING/RESOLVED) but
      // the agent still wants them visible under one roof. We DO drop
      // archived/spam rows so manually-archived noise stays hidden.
      return {
        AND: [
          { type: HelpdeskTicketType.SYSTEM, isArchived: false, isSpam: false },
          notSnoozed,
        ],
      };
    case "snoozed":
      return { snoozedUntil: { gt: now }, isArchived: false };
    case "resolved":
      return { status: HelpdeskTicketStatus.RESOLVED, isArchived: false };
    case "unassigned":
      return {
        AND: [open, notSnoozed, notCancellation, { primaryAssigneeId: null }],
      };
    case "mentioned":
      // mentions are stored as [{ handle, userId }]; array_contains matches
      // any element equal to the value, so we hand it the {userId: <id>} shape.
      return {
        AND: [
          open,
          notSnoozed,
          notCancellation,
          {
            notes: {
              some: {
                isDeleted: false,
                mentions: { array_contains: [{ userId: ctx.userId }] },
              } as Prisma.HelpdeskNoteWhereInput,
            },
          },
        ],
      };
    case "favorites":
      // Team-wide favorites: any active (non-archived) ticket flagged by any
      // agent. We deliberately do NOT filter by status so an agent can star
      // a RESOLVED ticket and still find it again. Snoozed favorites are
      // included — the goal is "things I want to find quickly", not "active
      // queue". Archived rows are excluded so old cleanup doesn't pollute.
      return { isFavorite: true, isArchived: false };
    case "spam":
      return { isSpam: true, isArchived: false };
    case "archived":
      return { isArchived: true };
  }
}

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
