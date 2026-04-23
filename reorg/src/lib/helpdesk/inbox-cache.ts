/**
 * Module-level cache for the Help Desk inbox.
 *
 * WHY THIS EXISTS
 * ────────────────
 * `HelpDeskClient` (and the underlying `useHelpdesk` hook) hold their state in
 * React. That state evaporates whenever the component unmounts:
 *
 *   - User navigates from /help-desk → /help-desk/filters → back to /help-desk.
 *     Returning to the inbox shows an empty list + "No tickets" for several
 *     seconds while the hook re-fetches everything from Neon.
 *   - User flips the layout pref between "split" and "list" — the entire
 *     subtree (TicketList + TicketReader + ContextPanel) is unmounted and
 *     re-mounted, triggering a fresh round of fetches. Painfully slow on
 *     localhost dev mode with OneDrive in the loop.
 *
 * This file lives outside React, so the data we put into it survives both
 * unmounts. The hook reads from it synchronously on mount (no flash, no
 * "No tickets" empty state when we already know the answer) and writes to it
 * after every successful fetch.
 *
 * WHAT WE CACHE
 * ─────────────
 *   - Per filter key (folder | channel | search):
 *       * pageIndex, startCursors[], current page tickets, nextCursor
 *   - Globally:
 *       * counts (folder badge counts)
 *       * syncStatus (header "Synced X ago" + safeMode flag)
 *   - Per ticket id:
 *       * full ticket detail (messages, notes, etc.)
 *
 * STALENESS
 * ─────────
 * The cache never expires on its own. The hook always fires a silent
 * background refresh after hydration — the cached value is just there to fill
 * the screen instantly while the network catches up. If the server returns
 * different data, React re-renders and the cache is overwritten with the
 * fresh values.
 *
 * KEY SHAPE
 * ─────────
 * `${folder}|${channel ?? "ALL"}|${search ?? ""}|${systemMessageType ?? ""}`
 *
 * Search is included so typing in the global search doesn't pollute the cache
 * for the unfiltered inbox. systemMessageType is included so each From eBay
 * sub-filter chip (RETURN_APPROVED, INR_OPENED, etc.) gets its own cached
 * page — without it, switching chips would briefly flash a stale list.
 */

import type {
  HelpdeskFolderKey,
  HelpdeskSyncStatus,
  HelpdeskTicketDetail,
  HelpdeskTicketSummary,
} from "@/hooks/use-helpdesk";

export interface InboxPageSnapshot {
  /** Zero-based page index. */
  pageIndex: number;
  /**
   * Cursor used to fetch each page we've visited so far. `startCursors[0]`
   * is always `null` (page 0 starts at the top of the inbox); subsequent
   * entries are the `nextCursor` returned when fetching the previous page.
   *
   * We keep the whole stack so "Previous" can re-fetch a known cursor
   * without having to seek forward from the top every time.
   */
  startCursors: (string | null)[];
  /** Tickets on the *current* page (i.e. what TicketList should render). */
  tickets: HelpdeskTicketSummary[];
  /** Cursor to pass to fetch the next page; `null` means we're at the end. */
  nextCursor: string | null;
  /** Wall-clock ms when this snapshot was last refreshed. */
  fetchedAt: number;
}

interface CountsSnapshot {
  data: Partial<Record<HelpdeskFolderKey, number>>;
  fetchedAt: number;
}

interface SyncStatusSnapshot {
  data: HelpdeskSyncStatus;
  fetchedAt: number;
}

interface DetailSnapshot {
  data: HelpdeskTicketDetail;
  fetchedAt: number;
}

const inboxByFilter = new Map<string, InboxPageSnapshot>();
let cachedCounts: CountsSnapshot | null = null;
let cachedSyncStatus: SyncStatusSnapshot | null = null;
const cachedDetailById = new Map<string, DetailSnapshot>();

/**
 * Build a stable cache key for the inbox page snapshot. The key intentionally
 * does NOT include the page index — page state lives inside the snapshot so
 * "Next" and "Previous" can mutate it without rebuilding the key.
 */
export function buildFilterKey(opts: {
  folder: string;
  channel?: string;
  search?: string;
  systemMessageType?: string | null;
  agentFolderId?: string | null;
}): string {
  return `${opts.folder}|${opts.channel ?? "ALL"}|${opts.search ?? ""}|${
    opts.systemMessageType ?? ""
  }|${opts.agentFolderId ?? ""}`;
}

export function getInbox(key: string): InboxPageSnapshot | undefined {
  return inboxByFilter.get(key);
}

export function setInbox(key: string, snapshot: InboxPageSnapshot): void {
  inboxByFilter.set(key, snapshot);
}

export function clearInbox(): void {
  inboxByFilter.clear();
}

export function getCounts(): CountsSnapshot | null {
  return cachedCounts;
}

export function setCounts(data: Partial<Record<HelpdeskFolderKey, number>>): void {
  cachedCounts = { data, fetchedAt: Date.now() };
}

export function getSyncStatus(): SyncStatusSnapshot | null {
  return cachedSyncStatus;
}

export function setSyncStatus(data: HelpdeskSyncStatus): void {
  cachedSyncStatus = { data, fetchedAt: Date.now() };
}

export function getDetail(id: string): DetailSnapshot | null {
  return cachedDetailById.get(id) ?? null;
}

export function setDetail(id: string, data: HelpdeskTicketDetail): void {
  cachedDetailById.set(id, { data, fetchedAt: Date.now() });
}
