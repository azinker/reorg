"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePageVisibility } from "@/lib/use-page-visibility";
import {
  buildFilterKey,
  getCounts,
  getDetail,
  getInbox,
  getSyncStatus,
  setCounts,
  setDetail,
  setInbox,
  setSyncStatus,
  type InboxPageSnapshot,
} from "@/lib/helpdesk/inbox-cache";

/**
 * Help Desk client state hook.
 *
 * Two big design notes that are easy to miss:
 *
 * 1. **Module-level cache.** Initial state is hydrated synchronously from
 *    `inbox-cache.ts` so an unmount → remount (e.g. navigating to
 *    /help-desk/filters and back, or flipping the layout pref between split
 *    and list) does NOT trigger a "No tickets" empty-state flash. The hook
 *    still fires a silent background refresh after hydration so the data
 *    catches up to the server.
 *
 * 2. **Cursor-stack pagination.** The previous behaviour appended pages to
 *    the visible list ("Load more"). It now exposes prev/next page
 *    navigation: a stack of `startCursors` records the cursor used to fetch
 *    each page so we can re-fetch any prior page in one round-trip.
 *
 * Polling cadence:
 *   - 60s while the tab is visible
 *   - paused when hidden (saves Neon network transfer)
 *   - one immediate refresh when the tab becomes visible again, but only
 *     if the cache is older than VISIBILITY_REFRESH_MIN_MS
 */

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
  | "spam"
  | "archived";

/** Compact user shape used for assignees, message authors, and note authors. */
export interface HelpdeskUserBadge {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl?: string | null;
  handle?: string | null;
}

export interface HelpdeskTicketSummary {
  id: string;
  channel: string;
  integrationLabel: string;
  threadKey: string;
  buyerUserId: string | null;
  buyerName: string | null;
  buyerEmail: string | null;
  ebayItemId: string | null;
  ebayItemTitle: string | null;
  ebayOrderNumber: string | null;
  subject: string | null;
  kind: "PRE_SALES" | "POST_SALES";
  status: "NEW" | "TO_DO" | "WAITING" | "RESOLVED" | "SPAM" | "ARCHIVED";
  isSpam: boolean;
  isArchived: boolean;
  snoozedUntil: string | null;
  primaryAssignee: HelpdeskUserBadge | null;
  unreadCount: number;
  lastBuyerMessageAt: string | null;
  lastAgentMessageAt: string | null;
  firstResponseAt: string | null;
  reopenCount: number;
  messageCount: number;
  noteCount: number;
  tags: { id: string; name: string; color: string | null }[];
  createdAt: string;
  updatedAt: string;
}

export interface HelpdeskMessageDetail {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  source: "EBAY" | "EBAY_UI" | "EXTERNAL_EMAIL" | "SYSTEM";
  fromName: string | null;
  fromIdentifier: string | null;
  subject: string | null;
  bodyText: string;
  isHtml: boolean;
  rawMedia: unknown;
  sentAt: string;
  author: HelpdeskUserBadge | null;
}

export interface HelpdeskNoteDetail {
  id: string;
  authorUserId: string;
  bodyText: string;
  mentions: unknown;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: HelpdeskUserBadge;
}

export interface HelpdeskTicketDetail extends HelpdeskTicketSummary {
  messages: HelpdeskMessageDetail[];
  notes: HelpdeskNoteDetail[];
  additionalAssignees: { user: HelpdeskUserBadge }[];
}

export interface HelpdeskSyncStatus {
  flags: {
    safeMode: boolean;
    enableEbaySend: boolean;
    enableResendExternal: boolean;
    enableAttachments: boolean;
    effectiveCanSendEbay: boolean;
    effectiveCanSendEmail: boolean;
  };
  lastTickAt: string | null;
  lastOutcome: string | null;
  lastSummary: unknown;
  checkpoints: {
    integrationId: string;
    integrationLabel: string | null;
    platform: string | null;
    folder: string;
    lastWatermark: string | null;
    lastFullSyncAt: string | null;
    backfillCursor: string | null;
    backfillDone: boolean;
    updatedAt: string;
  }[];
}

interface UseHelpdeskArgs {
  folder: HelpdeskFolderKey;
  channel?: "TPP_EBAY" | "TT_EBAY";
  search?: string;
}

interface UseHelpdeskReturn {
  tickets: HelpdeskTicketSummary[];
  counts: Partial<Record<HelpdeskFolderKey, number>>;
  loading: boolean;
  /** True while paginating to a prev/next page. Distinct from `loading`. */
  paging: boolean;
  /** Current page, zero-based. Resets to 0 when filters change. */
  pageIndex: number;
  /** True if the API reports more tickets after the current page. */
  hasNextPage: boolean;
  /** True if `pageIndex > 0` (we've stepped forward at least once). */
  hasPrevPage: boolean;
  goNextPage: () => void;
  goPrevPage: () => void;
  /** Number of tickets per page (constant). Useful for "showing X-Y" labels. */
  pageSize: number;
  error: string | null;
  refresh: () => void;
  selectedTicketId: string | null;
  setSelectedTicketId: (id: string | null) => void;
  selectedTicket: HelpdeskTicketDetail | null;
  selectedLoading: boolean;
  syncStatus: HelpdeskSyncStatus | null;
  triggerManualSync: () => Promise<void>;
  manualSyncing: boolean;
}

const POLL_INTERVAL_MS = 60_000;
const PAGE_SIZE = 50;
/**
 * Don't fire a fresh visibility-refresh inside this window. If the user tabs
 * away and back inside this many ms we keep showing the cached inbox and let
 * the next 60 s poll catch up. Eliminates the visible "everything redraws when
 * I switch tabs back" stutter.
 */
const VISIBILITY_REFRESH_MIN_MS = 15_000;

/** Empty page snapshot used when nothing is cached for a filter key yet. */
function emptySnapshot(): InboxPageSnapshot {
  return {
    pageIndex: 0,
    startCursors: [null],
    tickets: [],
    nextCursor: null,
    fetchedAt: 0,
  };
}

export function useHelpdesk(args: UseHelpdeskArgs): UseHelpdeskReturn {
  const { folder, channel, search } = args;

  // Stable cache key that drives hydration on mount and on filter change.
  const filterKey = useMemo(
    () => buildFilterKey({ folder, channel, search }),
    [folder, channel, search],
  );

  // Hydrate state synchronously from the module-level cache (if present) so
  // we paint with real data immediately on mount/remount/layout-switch
  // instead of flashing "No tickets" while the network request is in flight.
  const [snapshot, setSnapshot] = useState<InboxPageSnapshot>(
    () => getInbox(filterKey) ?? emptySnapshot(),
  );
  const [counts, setCountsState] = useState<Partial<Record<HelpdeskFolderKey, number>>>(
    () => getCounts()?.data ?? {},
  );
  const [syncStatus, setSyncStatusState] = useState<HelpdeskSyncStatus | null>(
    () => getSyncStatus()?.data ?? null,
  );

  // `loading` only goes true on the very first fetch for a filter key (when
  // we have nothing cached). Subsequent refreshes use `paging` or are silent.
  const [loading, setLoading] = useState(() => snapshot.fetchedAt === 0);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedTicketId, setSelectedTicketIdState] = useState<string | null>(null);
  const [selectedTicket, setSelectedTicket] = useState<HelpdeskTicketDetail | null>(
    null,
  );
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [manualSyncing, setManualSyncing] = useState(false);

  const isPageVisible = usePageVisibility();
  const refreshRef = useRef<() => void>(() => {});
  const lastListRefreshAtRef = useRef(snapshot.fetchedAt);
  const inflightRequestIdRef = useRef(0);
  const selectedTicketIdRef = useRef<string | null>(null);
  selectedTicketIdRef.current = selectedTicketId;

  // ── Filter change: re-hydrate from cache ───────────────────────────────────
  // When the user changes folder/channel/search, swap the page snapshot to
  // whatever we have cached for that key. This keeps prev/next state per
  // filter so jumping between folders preserves your place.
  useEffect(() => {
    const cached = getInbox(filterKey);
    if (cached) {
      setSnapshot(cached);
      setLoading(false);
    } else {
      setSnapshot(emptySnapshot());
      setLoading(true);
    }
  }, [filterKey]);

  /**
   * Fetch a specific page. The cursor passed determines which page is
   * requested (`null` = first page). On success we mutate the snapshot for
   * this filter key in both React state and the module cache.
   *
   * @param targetIndex   Zero-based index of the page we're trying to land on
   * @param cursor        Cursor to send to the API (`null` for the first page)
   * @param opts.silent   If true, skip the visible loading/paging flags
   */
  const fetchPage = useCallback(
    async (
      targetIndex: number,
      cursor: string | null,
      opts: { silent?: boolean; mode?: "initial" | "page" } = {},
    ) => {
      const { silent = false, mode = "initial" } = opts;
      const requestId = ++inflightRequestIdRef.current;
      if (!silent) {
        if (mode === "page") setPaging(true);
        else setLoading(true);
      }
      try {
        const params = new URLSearchParams();
        params.set("folder", folder);
        params.set("limit", String(PAGE_SIZE));
        if (cursor) params.set("cursor", cursor);
        if (channel) params.set("channel", channel);
        if (search) params.set("search", search);

        const [ticketsRes, countsRes] = await Promise.all([
          fetch(`/api/helpdesk/tickets?${params.toString()}`, { cache: "no-store" }),
          // Counts only need to be re-fetched when we're refreshing the list,
          // not on every page step — but the cost is small (13 COUNT queries
          // in parallel) and keeping the badges live is worth it.
          fetch("/api/helpdesk/counts", { cache: "no-store" }),
        ]);
        if (requestId !== inflightRequestIdRef.current) return;
        if (!ticketsRes.ok) throw new Error(`Tickets ${ticketsRes.status}`);
        if (!countsRes.ok) throw new Error(`Counts ${countsRes.status}`);
        const ticketsJson = (await ticketsRes.json()) as {
          data: HelpdeskTicketSummary[];
          nextCursor: string | null;
        };
        const countsJson = (await countsRes.json()) as {
          data: Partial<Record<HelpdeskFolderKey, number>>;
        };
        if (requestId !== inflightRequestIdRef.current) return;

        // Update / extend the startCursors stack so prev/next can replay this
        // page later without re-walking the inbox from page 0.
        setSnapshot((prev) => {
          const startCursors = prev.startCursors.slice();
          startCursors[targetIndex] = cursor;
          const next: InboxPageSnapshot = {
            pageIndex: targetIndex,
            startCursors,
            tickets: ticketsJson.data ?? [],
            nextCursor: ticketsJson.nextCursor ?? null,
            fetchedAt: Date.now(),
          };
          setInbox(filterKey, next);
          return next;
        });
        setCountsState(countsJson.data ?? {});
        setCounts(countsJson.data ?? {});
        setError(null);
        lastListRefreshAtRef.current = Date.now();
      } catch (err) {
        if (requestId !== inflightRequestIdRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!silent) {
          if (mode === "page") setPaging(false);
          else setLoading(false);
        }
      }
    },
    [folder, channel, search, filterKey],
  );

  const goNextPage = useCallback(() => {
    if (paging) return;
    if (!snapshot.nextCursor) return;
    void fetchPage(snapshot.pageIndex + 1, snapshot.nextCursor, { mode: "page" });
  }, [paging, snapshot.nextCursor, snapshot.pageIndex, fetchPage]);

  const goPrevPage = useCallback(() => {
    if (paging) return;
    if (snapshot.pageIndex === 0) return;
    const prevIndex = snapshot.pageIndex - 1;
    const prevCursor = snapshot.startCursors[prevIndex] ?? null;
    void fetchPage(prevIndex, prevCursor, { mode: "page" });
  }, [paging, snapshot.pageIndex, snapshot.startCursors, fetchPage]);

  /**
   * Selected ticket detail fetch. Hydrates from per-id cache first so
   * re-selecting a ticket you've already viewed feels instantaneous.
   */
  const loadSelected = useCallback(
    async (id: string | null, opts: { silent?: boolean } = {}) => {
      const { silent = false } = opts;
      if (!id) {
        setSelectedTicket(null);
        return;
      }
      const cached = getDetail(id);
      if (cached) {
        setSelectedTicket(cached.data);
        if (silent) return; // background poll already happened recently
      } else if (!silent) {
        setSelectedLoading(true);
      }
      try {
        const res = await fetch(`/api/helpdesk/tickets/${id}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Ticket ${res.status}`);
        const json = (await res.json()) as { data: HelpdeskTicketDetail };
        setSelectedTicket(json.data);
        setDetail(id, json.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!silent && !cached) setSelectedLoading(false);
      }
    },
    [],
  );

  const loadSyncStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/helpdesk/sync-status", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { data: HelpdeskSyncStatus };
      setSyncStatusState(json.data);
      setSyncStatus(json.data);
    } catch {
      // best-effort; ignore
    }
  }, []);

  /**
   * Silent background refresh of the *current* page (no spinner). Used by
   * the polling interval, "Sync now", visibility-resumed, etc.
   */
  const refresh = useCallback(() => {
    const cursor = snapshot.startCursors[snapshot.pageIndex] ?? null;
    void fetchPage(snapshot.pageIndex, cursor, { silent: true });
    void loadSyncStatus();
    const id = selectedTicketIdRef.current;
    if (id) void loadSelected(id, { silent: true });
  }, [snapshot.pageIndex, snapshot.startCursors, fetchPage, loadSyncStatus, loadSelected]);

  refreshRef.current = refresh;

  // ── Initial load + when filters change ─────────────────────────────────────
  // If we hydrated something fresh-ish from the cache (< 30 s old), skip the
  // immediate visible load and let the polling interval bring it up to date.
  // Otherwise fire a real fetch right away.
  useEffect(() => {
    const cached = getInbox(filterKey);
    const isFresh = cached && Date.now() - cached.fetchedAt < 30_000;
    if (isFresh) {
      // Silently re-validate in the background.
      void fetchPage(cached.pageIndex, cached.startCursors[cached.pageIndex] ?? null, {
        silent: true,
      });
    } else {
      void fetchPage(0, null);
    }
    void loadSyncStatus();
  }, [filterKey, fetchPage, loadSyncStatus]);

  // Selected ticket fetch
  useEffect(() => {
    void loadSelected(selectedTicketId);
  }, [selectedTicketId, loadSelected]);

  // ── Background polling ─────────────────────────────────────────────────────
  // While the tab is visible:
  //   - if the cached list is > VISIBILITY_REFRESH_MIN_MS stale, refresh now
  //   - then refresh every POLL_INTERVAL_MS until hidden
  // Refreshes are always silent (`refresh()` doesn't toggle `loading`).
  useEffect(() => {
    if (!isPageVisible) return;

    const sinceLast = Date.now() - lastListRefreshAtRef.current;
    if (sinceLast >= VISIBILITY_REFRESH_MIN_MS) {
      refreshRef.current();
    }

    const handle = window.setInterval(() => {
      refreshRef.current();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [isPageVisible]);

  const triggerManualSync = useCallback(async () => {
    setManualSyncing(true);
    try {
      const res = await fetch("/api/helpdesk/sync", { method: "POST" });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `Sync ${res.status}`);
      }
      refreshRef.current();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setManualSyncing(false);
    }
  }, []);

  // Stable wrapper so consumers don't need to memoize.
  const setSelectedTicketId = useCallback((id: string | null) => {
    setSelectedTicketIdState(id);
  }, []);

  return {
    tickets: snapshot.tickets,
    counts,
    loading,
    paging,
    pageIndex: snapshot.pageIndex,
    hasNextPage: snapshot.nextCursor !== null,
    hasPrevPage: snapshot.pageIndex > 0,
    goNextPage,
    goPrevPage,
    pageSize: PAGE_SIZE,
    error,
    refresh,
    selectedTicketId,
    setSelectedTicketId,
    selectedTicket,
    selectedLoading,
    syncStatus,
    triggerManualSync,
    manualSyncing,
  };
}
