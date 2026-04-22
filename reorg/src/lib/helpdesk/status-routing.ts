/**
 * Pure helpers that decide what `HelpdeskTicketStatus` a ticket should land
 * in after each kind of activity. Lives in its own file so it is fully
 * unit-testable without spinning up Prisma or the eBay sync.
 *
 * The state machine matches the eDesk model the user asked for in the
 * triage overhaul:
 *
 *   NEW       — legacy / sync-only. Live buyer mail no longer lands here;
 *               all unanswered buyer messages route straight to TO_DO so
 *               the inbox surfaces a single "needs response" bucket. We
 *               keep the value in the schema so historical rows remain
 *               legible, but `deriveStatusOnInbound` will never *return*
 *               NEW. Folder routing treats NEW as a TO_DO alias.
 *   TO_DO     — ball in OUR court: any buyer message that hasn't been
 *               replied to. Includes brand-new tickets AND replies to
 *               threads we'd previously responded on.
 *   WAITING   — ball in BUYER's court: we sent the last reply
 *   RESOLVED  — explicit close (agent clicked "Send + mark Resolved" or
 *               batch action). Auto-resolve on long inactivity is handled
 *               by the housekeeping job and is not part of this helper.
 *   SNOOZED   — virtual: any status whose row has snoozedUntil > now. We
 *               do NOT store SNOOZED as a status value; folder routing in
 *               folders.ts checks the timestamp instead. This means a
 *               waking snoozed ticket can transition straight back to its
 *               underlying status — which we then *promote* to TO_DO so the
 *               agent's queue shows up as expected.
 *   SPAM      — explicit "this is spam" action.
 *   ARCHIVED  — separate boolean (`isArchived`); not a status here.
 *
 * All functions are pure (input → output) and never touch the DB.
 */

import { HelpdeskMessageSource, HelpdeskTicketStatus } from "@prisma/client";

/**
 * Compact view of the ticket sufficient for routing decisions. We accept a
 * narrow shape (rather than the full `HelpdeskTicket`) so callers can
 * cheaply project just what we need from a Prisma query.
 */
export interface RoutingTicketSnapshot {
  status: HelpdeskTicketStatus;
  /**
   * Have WE replied at least once on this thread before? Drives the
   * NEW vs TO_DO branch on inbound.
   */
  hasAgentReplied: boolean;
  isArchived: boolean;
  isSpam: boolean;
}

/**
 * Decide the new ticket status when a buyer message arrives.
 *
 * Per the v2 folder semantics ("To Do = anything from a buyer that needs a
 * response"), every buyer message that isn't spam routes to TO_DO —
 * including brand-new tickets that previously would have started in NEW
 * AND tickets that were previously archived. The user's spec on archived
 * tickets is explicit:
 *
 *   "Once those messages go to Archived, and if a buyer responds on that
 *    ticket, it would bounce it out of archived and it would go to the
 *    To Do folder, as the buyer messaged us and they are waiting for a
 *    response. That goes for any message that goes to Archive, it should
 *    be bounced back out to To Do if a buyer messages us on that ticket."
 *
 * So the routing rule is:
 *   - SPAM: stays SPAM (explicit agent decision; spam buyers shouldn't
 *     resurrect their own threads).
 *   - ARCHIVED: bounce back to TO_DO. The CALLER is responsible for
 *     clearing `isArchived` / `archivedAt` on the row — this helper just
 *     reports the desired status. We DO NOT touch the `isArchived`
 *     boolean here because this module is pure / DB-free.
 *   - RESOLVED: reopen as TO_DO. Caller is responsible for bumping
 *     `reopenCount` and stamping `lastReopenedAt`.
 *   - Anything else (NEW, TO_DO, WAITING): land in TO_DO. The
 *     `hasAgentReplied` flag on the snapshot is no longer consulted —
 *     it's preserved on the type only because callers may still pass it.
 */
export function deriveStatusOnInbound(
  ticket: RoutingTicketSnapshot,
): HelpdeskTicketStatus {
  if (ticket.isSpam || ticket.status === HelpdeskTicketStatus.SPAM) {
    return HelpdeskTicketStatus.SPAM;
  }
  return HelpdeskTicketStatus.TO_DO;
}

/**
 * Decide the new status when an OUTBOUND message has just landed.
 *
 *   - If the agent explicitly chose a target status (RESOLVED via
 *     "Send + mark Resolved", or WAITING via the default "Send"), honour
 *     it.
 *   - Otherwise default to WAITING — we replied, so it's the buyer's turn.
 */
export function deriveStatusOnOutbound(
  current: HelpdeskTicketStatus,
  explicit: HelpdeskTicketStatus | null,
): HelpdeskTicketStatus {
  if (explicit) return explicit;
  // Don't downgrade from RESOLVED on background sync if we somehow get a
  // double-fire — RESOLVED stays RESOLVED.
  if (current === HelpdeskTicketStatus.RESOLVED) return current;
  return HelpdeskTicketStatus.WAITING;
}

/**
 * Decide the new status when a SYNCED outbound (i.e. a reply we discovered
 * via the eBay sync, not one our composer queued) lands as the latest
 * message on the ticket. The source classifier tells us *how* the reply
 * arrived:
 *
 *   - `EBAY` (reorG-stamped): the reorG outbound queue sent it. The
 *     agent already chose RESOLVED vs WAITING in the composer; that
 *     choice was applied locally when the job was created. We don't
 *     second-guess it on the round-trip back from eBay — defaulting to
 *     WAITING preserves the ticket's previous status if the composer
 *     already moved it to RESOLVED.
 *
 *   - `EBAY_UI`: a human agent typed the reply directly on eBay.com,
 *     bypassing reorG entirely. There is no in-app "Send + Resolve"
 *     trigger because the action happened outside reorG, but the act of
 *     answering on eBay is a strong signal the agent considers the
 *     ticket handled — they replied and moved on. We flip these straight
 *     to RESOLVED so they don't sit in WAITING forever and the agent's
 *     queue stays clean. A buyer follow-up still bounces the ticket back
 *     to TO_DO via `deriveStatusOnInbound`.
 *
 *   - `AUTO_RESPONDER`: the AR fired a courtesy notification — the
 *     buyer hasn't actually been engaged with yet. Caller is expected to
 *     skip this transition entirely (sync.ts already does); we still
 *     handle the case defensively by returning WAITING to mirror the
 *     legacy behaviour.
 *
 *   - Anything else (EXTERNAL_EMAIL, SYSTEM): treat as WAITING.
 *
 * Pure / DB-free so it stays unit-testable.
 */
export function deriveStatusOnSyncedOutbound(
  source: HelpdeskMessageSource,
): HelpdeskTicketStatus {
  if (source === HelpdeskMessageSource.EBAY_UI) {
    return HelpdeskTicketStatus.RESOLVED;
  }
  return HelpdeskTicketStatus.WAITING;
}

/**
 * Decide the wake-up status when a snooze has expired (`snoozedUntil` is
 * in the past). We always promote to TO_DO so the ticket reappears in the
 * agent's active queue — that matches the user-confirmed
 * "Snoozed → To Do" routing rule. Spam / Archived rows are preserved.
 *
 * NB: callers should *also* clear `snoozedUntil` when applying this
 * status — the value is what marks the row as snoozed for the folder
 * filter. Returning a status without nulling the timestamp would leave
 * the row visible as "snoozed" forever.
 */
export function deriveStatusOnSnoozeWake(
  current: HelpdeskTicketStatus,
  flags: { isSpam: boolean; isArchived: boolean },
): HelpdeskTicketStatus {
  if (flags.isSpam) return HelpdeskTicketStatus.SPAM;
  if (flags.isArchived) return current; // leave the underlying status
  return HelpdeskTicketStatus.TO_DO;
}
