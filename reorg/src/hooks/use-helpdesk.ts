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

/**
 * Mirror of the Prisma `HelpdeskTicketType` enum. Kept hand-typed (rather
 * than imported from `@prisma/client`) so this hook stays usable in
 * client-only bundles without dragging the Prisma generated code into
 * the client bundle.
 */
export type HelpdeskTicketType =
  | "QUERY"
  | "PRE_SALES"
  | "RETURN_REQUEST"
  | "ITEM_NOT_RECEIVED"
  | "NEGATIVE_FEEDBACK"
  | "REFUND"
  | "SHIPPING_QUERY"
  | "CANCELLATION"
  | "SYSTEM"
  | "OTHER";

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
  /**
   * Server-derived one-line preview of the most recent real message in the
   * thread (excludes raw eBay digest envelopes). Populated by GET
   * /api/helpdesk/tickets so the inbox table can show actual message text in
   * the "Latest Update" column instead of falling back to the eBay
   * notification subject. Null if no eligible message exists yet.
   */
  latestPreview: string | null;
  kind: "PRE_SALES" | "POST_SALES";
  type: HelpdeskTicketType;
  typeOverridden: boolean;
  /**
   * Sub-type for SYSTEM tickets — see SYSTEM_MESSAGE_TYPES in
   * `lib/helpdesk/from-ebay-detect.ts`. Null on non-SYSTEM tickets and on
   * SYSTEM tickets where detection couldn't pin a sub-type. Powers the
   * filter chips on the From eBay folder.
   */
  systemMessageType: string | null;
  status: "NEW" | "TO_DO" | "WAITING" | "RESOLVED" | "SPAM" | "ARCHIVED";
  isSpam: boolean;
  isArchived: boolean;
  isFavorite: boolean;
  isImportant: boolean;
  snoozedUntil: string | null;
  primaryAssignee: HelpdeskUserBadge | null;
  unreadCount: number;
  lastBuyerMessageAt: string | null;
  lastAgentMessageAt: string | null;
  firstResponseAt: string | null;
  reopenCount: number;
  /** @deprecated server no longer ships these on the inbox list (perf). */
  messageCount?: number;
  /** @deprecated server no longer ships these on the inbox list (perf). */
  noteCount?: number;
  agentFolderId: string | null;
  tags: { id: string; name: string; color: string | null }[];
  createdAt: string;
  updatedAt: string;
}

export interface HelpdeskMessageDetail {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  source: "EBAY" | "EBAY_UI" | "EXTERNAL_EMAIL" | "SYSTEM" | "AUTO_RESPONDER";
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

/**
 * Reply that an agent has hit Send on but which hasn't been pushed to the
 * marketplace yet. Lives in HelpdeskOutboundJob (separate from
 * HelpdeskMessage) and only crosses over after the every-1-min outbound
 * cron actually sends it. We surface PENDING/QUEUED/SENDING jobs in the
 * thread so the agent doesn't see "did my reply go through?" dead air for
 * the up-to-15-min round-trip back from eBay.
 */
export interface HelpdeskPendingOutboundJob {
  id: string;
  composerMode: "REPLY" | "NOTE" | "EXTERNAL";
  bodyText: string;
  status: "PENDING" | "SENDING";
  scheduledAt: string;
  createdAt: string;
  willBlockReason: string | null;
  author: HelpdeskUserBadge | null;
}

/**
 * Optional MarketplaceListing snapshot for the ticket's `ebayItemId`. The
 * server enriches the detail response with this when the buyer is messaging
 * about a listing we manage internally — pre-sales tickets show it as a
 * "Product Inquiry" card in the right rail (no qty / price). For post-sales
 * tickets the OrderInfoSection already pulls richer line-item data from
 * eBay; this field is a fallback for when eBay returns nothing or for
 * pre-sales conversations where no order exists yet.
 */
export interface HelpdeskListingInfo {
  itemId: string;
  sku: string | null;
  title: string | null;
  imageUrl: string | null;
}

export interface HelpdeskTicketDetail extends HelpdeskTicketSummary {
  messages: HelpdeskMessageDetail[];
  notes: HelpdeskNoteDetail[];
  pendingOutboundJobs: HelpdeskPendingOutboundJob[];
  additionalAssignees: { user: HelpdeskUserBadge }[];
  listingInfo: HelpdeskListingInfo | null;
}

export interface HelpdeskSyncStatus {
  flags: {
    safeMode: boolean;
    enableEbaySend: boolean;
    enableResendExternal: boolean;
    enableAttachments: boolean;
    enableEbayReadSync: boolean;
    effectiveCanSendEbay: boolean;
    effectiveCanSendEmail: boolean;
    effectiveCanSyncReadState: boolean;
  };
  /**
   * Active backfill window in days (mirrors HELPDESK_BACKFILL_DAYS env var).
   * Optional so older clients / cached payloads don't break the header.
   * Defaults to 60 on the server when unset.
   */
  backfillDays?: number;
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
  /**
   * Active From-eBay event-type chip (e.g. "RETURN_APPROVED"). Only honored
   * by the API on `folder === "from_ebay"`; passing it on other folders is a
   * no-op so URL-driven state can remain in sync without extra guards.
   */
  systemMessageType?: string | null;
  /** When set, fetches tickets belonging to this agent folder instead of the system folder. */
  agentFolderId?: string | null;
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
  /**
   * Hint to begin loading a ticket's full detail before the user clicks it
   * (typically wired up to `onMouseEnter` on a ticket row). Reads cache first,
   * fires a fetch in the background otherwise, and stores the result so the
   * subsequent click resolves instantly. Safe to call repeatedly — duplicate
   * in-flight prefetches are deduped.
   */
  prefetchTicket: (id: string) => void;
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
  const { folder, channel, search, systemMessageType, agentFolderId } = args;

  // Stable cache key that drives hydration on mount and on filter change.
  // The systemMessageType chip is included so each chip selection on the
  // From eBay folder gets its own cached page (otherwise switching chips
  // would briefly flash stale ticket lists from a different chip).
  const filterKey = useMemo(
    () => buildFilterKey({ folder, channel, search, systemMessageType, agentFolderId }),
    [folder, channel, search, systemMessageType, agentFolderId],
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
  /**
   * AbortController for the *currently in-flight* tickets fetch. Every time
   * we start a new fetch we cancel the previous one — without this, typing
   * "Apple" then immediately backspacing it out fires the search="Apple"
   * request, then the search="" request, and Chrome runs both in parallel.
   * On a cold Vercel function the slower one can take 8+ seconds, holds a
   * network slot the whole time, AND triggers a React re-render with stale
   * data when it eventually returns. Aborting closes the socket immediately,
   * frees the slot, and prevents the stale re-render storm. This is the
   * actual fix for the "page goes unresponsive when I delete the search"
   * complaint that the request-ID guard alone could not solve.
   */
  const ticketsFetchAbortRef = useRef<AbortController | null>(null);
  /** Same idea for the lighter counts/sync-status fetches. */
  const auxFetchAbortRef = useRef<AbortController | null>(null);
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

      // Abort whatever tickets fetch is currently in flight. This is what
      // actually frees the underlying TCP slot and stops the stale React
      // re-render when the prior response would otherwise arrive late.
      ticketsFetchAbortRef.current?.abort();
      const ac = new AbortController();
      ticketsFetchAbortRef.current = ac;

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
        if (systemMessageType) params.set("systemMessageType", systemMessageType);
        if (agentFolderId) params.set("agentFolderId", agentFolderId);

        // Tickets is the only thing that depends on the current filter
        // (folder/channel/search/cursor). Counts and sync-status are global
        // and are refreshed on a slower cadence by separate effects, so we
        // do NOT fetch them here. Previously this `Promise.all` fanned out
        // to 3 endpoints on every keystroke change, which was the main
        // source of the inbox feeling unresponsive while typing.
        const ticketsRes = await fetch(
          `/api/helpdesk/tickets?${params.toString()}`,
          { cache: "no-store", signal: ac.signal },
        );
        if (requestId !== inflightRequestIdRef.current) return;
        if (!ticketsRes.ok) throw new Error(`Tickets ${ticketsRes.status}`);
        const ticketsJson = (await ticketsRes.json()) as {
          data: HelpdeskTicketSummary[];
          nextCursor: string | null;
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
        setError(null);
        lastListRefreshAtRef.current = Date.now();
      } catch (err) {
        if (requestId !== inflightRequestIdRef.current) return;
        // Aborts are expected (filter changed mid-flight). Don't surface
        // them as user-facing errors.
        if (
          ac.signal.aborted ||
          (err instanceof DOMException && err.name === "AbortError") ||
          (err instanceof Error && /aborted/i.test(err.message))
        ) {
          return;
        }
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
        // Hydrate the UI instantly from cache so opening a previously-viewed
        // ticket feels instantaneous, but ALWAYS continue on to the network
        // refetch below. The previous early-return-on-silent meant that
        // after an agent added a note or queued a reply, the cache (which
        // doesn't yet contain the new note/job) won out forever and the
        // thread never updated until the user clicked away and back.
        setSelectedTicket(cached.data);
      } else if (!silent) {
        setSelectedLoading(true);
      }
      try {
        const res = await fetch(`/api/helpdesk/tickets/${id}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Ticket ${res.status}`);
        const json = (await res.json()) as { data: HelpdeskTicketDetail };
        setSelectedTicket(json.data);
        setDetail(id, json.data);

        // Auto-mark-read: when an agent opens an unread ticket, mark it read
        // immediately. This also mirrors to eBay when read sync is enabled.
        // Side-effects live on the batch POST path (sole writer for
        // unreadCount + eBay mirror); GET stays side-effect-free so hover
        // prefetch can't accidentally flip state.
        if (json.data.unreadCount > 0) {
          // Optimistic: clear unread locally so the list row + unread dot
          // stop showing as unread the instant the agent opens the ticket.
          // Without this the badge stays "unread" for up to 60 s until the
          // next background poll, which looks broken from the agent's POV.
          setSnapshot((prev) => ({
            ...prev,
            tickets: prev.tickets.map((t) =>
              t.id === id ? { ...t, unreadCount: 0 } : t,
            ),
          }));
          setSelectedTicket((prev) =>
            prev && prev.id === id ? { ...prev, unreadCount: 0 } : prev,
          );

          void fetch("/api/helpdesk/tickets/batch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "markRead",
              ticketIds: [id],
              isRead: true,
            }),
          }).catch(() => {});
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!silent && !cached) setSelectedLoading(false);
      }
    },
    [],
  );

  const loadSyncStatus = useCallback(async () => {
    // Reuse the aux abort controller so a fresh page load cancels any prior
    // background poll's still-pending sync-status fetch.
    auxFetchAbortRef.current?.abort();
    const ac = new AbortController();
    auxFetchAbortRef.current = ac;
    try {
      const res = await fetch("/api/helpdesk/sync-status", {
        cache: "no-store",
        signal: ac.signal,
      });
      if (!res.ok) return;
      const json = (await res.json()) as { data: HelpdeskSyncStatus };
      setSyncStatusState(json.data);
      setSyncStatus(json.data);
    } catch {
      // best-effort; ignore (incl. AbortError)
    }
  }, []);

  /**
   * Folder badge counts. Independent of search/folder/channel — they're a
   * global view of the mailbox. Refreshed on mount + on every polling tick,
   * NOT on every keystroke change. (Search keystrokes used to refire this
   * with every other filter change, which made typing feel laggy.)
   */
  const loadCounts = useCallback(async () => {
    try {
      const res = await fetch("/api/helpdesk/counts", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as {
        data: Partial<Record<HelpdeskFolderKey, number>>;
      };
      setCountsState(json.data ?? {});
      setCounts(json.data ?? {});
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
    void loadCounts();
    const id = selectedTicketIdRef.current;
    if (id) void loadSelected(id, { silent: true });
  }, [
    snapshot.pageIndex,
    snapshot.startCursors,
    fetchPage,
    loadSyncStatus,
    loadCounts,
    loadSelected,
  ]);

  refreshRef.current = refresh;

  // ── Initial load + when filters change ─────────────────────────────────────
  // If we hydrated something fresh-ish from the cache (< 30 s old), skip the
  // immediate visible load and let the polling interval bring it up to date.
  // Otherwise fire a real fetch right away.
  //
  // CRITICAL: this effect must ONLY fetch tickets. Counts and sync-status
  // are mailbox-global and live in their own mount-only effects below.
  // Putting them here was firing them on every keystroke change, which:
  //   - took up Chrome's per-origin connection slots (max 6 over HTTP/1.1
  //     and even on HTTP/2 it competes with bundled-fetch concurrency
  //     limits), starving the *actual* tickets request the user is waiting
  //     for, and
  //   - on a cold Vercel function the slow sync-status response (7+ s in
  //     the field) would shift the header layout when it returned (the
  //     "Synced X ago" label changes width), making the search input fail
  //     Playwright's actionability check and feel non-responsive to a
  //     real user trying to click it.
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
  }, [filterKey, fetchPage]);

  // ── Independent global fetches (counts + sync-status) ──────────────────────
  // These describe the WHOLE mailbox, not the current filter, so they only
  // run once on mount. The 60 s polling effect below keeps them fresh.
  useEffect(() => {
    void loadCounts();
    void loadSyncStatus();
  }, [loadCounts, loadSyncStatus]);

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

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  // Cancel any pending fetches if the user navigates away from /help-desk
  // mid-request (e.g. into Settings). Prevents lingering "ghost" requests
  // from logging errors and from triggering React state updates on an
  // unmounted tree.
  useEffect(() => {
    return () => {
      ticketsFetchAbortRef.current?.abort();
      auxFetchAbortRef.current?.abort();
    };
  }, []);

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
    prefetchTicket,
  };
}

/**
 * In-flight prefetch dedupe set. Module-level so it survives across the
 * (rare) `useHelpdesk` remount and so multiple TicketList instances coexist
 * without firing duplicate prefetches.
 */
const inflightPrefetches = new Set<string>();

/**
 * Pure prefetch function exported on the hook return. Lives at module scope
 * (not inside the hook) so the identity is stable and callers can use it in
 * `onMouseEnter` handlers without retriggering effects.
 */
function prefetchTicket(id: string): void {
  if (!id) return;
  if (getDetail(id)) return; // already cached, nothing to do
  if (inflightPrefetches.has(id)) return; // dedupe
  inflightPrefetches.add(id);
  // Fire and forget — we deliberately do not await. Errors are swallowed
  // because this is a hint, not a contract; if the user clicks anyway the
  // regular `loadSelected` path will surface any failure.
  //
  // IMPORTANT: we tag this with ?prefetch=1 so the server keeps the
  // response SIDE-EFFECT-FREE: no audit "ticket opened" stamp, no
  // mark-as-read, no mirror-to-eBay. Without this, hovering a row would
  // silently push read=true to eBay via mirrorReadStateToEbay and flip
  // real unread messages read on the buyer's inbox — see the fix in
  // src/app/api/helpdesk/tickets/[id]/route.ts (GET).
  void fetch(`/api/helpdesk/tickets/${id}?prefetch=1`, { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) return;
      const json = (await res.json()) as { data: HelpdeskTicketDetail };
      setDetail(id, json.data);
    })
    .catch(() => {
      // benign — selection-time fetch will retry
    })
    .finally(() => {
      inflightPrefetches.delete(id);
    });
}
