/**
 * Folder definitions for the Help Desk inbox sidebar. Each folder is a
 * server-side filter applied to HelpdeskTicket. Counts are computed once
 * and reused for badges.
 */

import {
  HelpdeskTicketStatus,
  HelpdeskTicketKind,
  type Prisma,
} from "@prisma/client";

export type HelpdeskFolderKey =
  | "pre_sales"
  | "my_tickets"
  | "all_tickets"
  | "all_new"
  | "all_to_do"
  | "all_waiting"
  | "buyer_cancellation"
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
 * Build a Prisma where clause for the given folder. Folder semantics:
 *   - pre_sales:    open + kind=PRE_SALES (not snoozed, not archived, not spam, not cancellation)
 *   - my_tickets:   open + primary or additional assignee = me (not cancellation)
 *   - all_tickets:  open (every active status, includes snoozed-now-due, not cancellation)
 *   - all_new:      status=NEW (not cancellation)
 *   - all_to_do:    status=TO_DO (not cancellation)
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

  switch (folder) {
    case "pre_sales":
      return {
        AND: [open, notSnoozed, notCancellation, { kind: HelpdeskTicketKind.PRE_SALES }],
      };
    case "my_tickets":
      return {
        AND: [
          open,
          notSnoozed,
          notCancellation,
          {
            OR: [
              { primaryAssigneeId: ctx.userId },
              { additionalAssignees: { some: { userId: ctx.userId } } },
            ],
          },
        ],
      };
    case "all_tickets":
      return { AND: [open, notSnoozed, notCancellation] };
    case "all_new":
      return {
        AND: [
          { status: HelpdeskTicketStatus.NEW, isArchived: false, isSpam: false },
          notSnoozed,
          notCancellation,
        ],
      };
    case "all_to_do":
      return {
        AND: [
          { status: HelpdeskTicketStatus.TO_DO, isArchived: false, isSpam: false },
          notSnoozed,
          notCancellation,
        ],
      };
    case "all_waiting":
      return {
        AND: [
          { status: HelpdeskTicketStatus.WAITING, isArchived: false, isSpam: false },
          notSnoozed,
          notCancellation,
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
  all_waiting: "Waiting",
  buyer_cancellation: "Buyer Request Cancellation",
  snoozed: "Snoozed",
  resolved: "Resolved",
  unassigned: "Unassigned",
  mentioned: "Mentioned",
  favorites: "Favorites",
  spam: "Spam",
  archived: "Archived",
};
