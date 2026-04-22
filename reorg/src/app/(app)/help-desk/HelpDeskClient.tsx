"use client";

import { startTransition, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useHelpdesk, type HelpdeskFolderKey } from "@/hooks/use-helpdesk";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { HelpdeskHeader } from "@/components/helpdesk/HelpdeskHeader";
import { FolderSidebar } from "@/components/helpdesk/FolderSidebar";
import { TicketList } from "@/components/helpdesk/TicketList";
import { TicketReader } from "@/components/helpdesk/TicketReader";
import {
  useHelpdeskPrefs,
  updateHelpdeskPrefs,
} from "@/components/helpdesk/HelpdeskSettingsDialog";
import { HelpdeskSplit } from "@/components/helpdesk/HelpdeskSplit";
import { cn } from "@/lib/utils";

export default function HelpDeskClient() {
  const [folder, setFolder] = useState<HelpdeskFolderKey>("all_tickets");
  const [channelFilter, setChannelFilter] = useState<"TPP_EBAY" | "TT_EBAY" | "ALL">(
    "ALL",
  );
  /**
   * Status filter chip applied client-side in the eDesk-style table view.
   * Lives at the page level so it persists across table-list re-renders and
   * pairs cleanly with the sidebar folder + channel filter.
   */
  const [statusFilter, setStatusFilter] = useState<
    "ALL" | "NEW" | "TO_DO" | "WAITING" | "RESOLVED"
  >("ALL");
  const [search, setSearch] = useState("");
  const prefs = useHelpdeskPrefs();

  // Pick up `?q=` from the URL — sub-pages (filters, dashboard, profile,
  // global-settings) drive their global-search field by pushing
  // `/help-desk?q=...`. We seed the inbox search from it on mount and
  // again whenever the param actually changes (e.g. agent submits a new
  // search from a sub-page while we were already mounted via back/forward).
  // We do NOT mirror local `setSearch` calls back into the URL — the
  // header debounces every keystroke and continuously rewriting the URL
  // would fight the browser back-button.

  /**
   * Lightweight `/api/users/me` fetch on mount. Drives two things:
   *   - `isAdmin` so the FolderSidebar can show / hide the "Global Settings"
   *     link (server-side guards still enforce the actual permission).
   *   - `agent`, the signed-in user's profile, which the HelpdeskHeader
   *     renders as a small avatar so the agent always knows whose mailbox
   *     they're operating in (especially under "Login as" impersonation).
   */
  const [isAdmin, setIsAdmin] = useState(false);
  const [agent, setAgent] = useState<{
    id: string;
    name: string | null;
    email: string | null;
    handle: string | null;
    avatarUrl: string | null;
    impersonating: boolean;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/users/me", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as {
          data?: {
            id?: string;
            name?: string | null;
            email?: string | null;
            handle?: string | null;
            avatarUrl?: string | null;
            role?: string;
            impersonation?: { realUserId: string } | null;
          };
        };
        if (cancelled) return;
        setIsAdmin(j.data?.role === "ADMIN");
        if (j.data?.id) {
          setAgent({
            id: j.data.id,
            name: j.data.name ?? null,
            email: j.data.email ?? null,
            handle: j.data.handle ?? null,
            avatarUrl: j.data.avatarUrl ?? null,
            impersonating: !!j.data.impersonation,
          });
        }
      } catch {
        // best-effort; non-admin treatment is the safe default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const channelArg = channelFilter === "ALL" ? undefined : channelFilter;
  // Network-side debounce on top of the header's input-side debounce.
  //
  //   - HelpdeskHeader debounces 250 ms before notifying us of a search
  //     change (so per-keystroke re-renders of FolderSidebar / TicketList /
  //     TicketReader never happen).
  //   - We add another 200 ms before firing the network request, which
  //     means the API is hit ~450 ms after the user stops typing — close
  //     to eDesk's ~500 ms. Common type-then-delete gestures (e.g.
  //     "Apple" followed by 5 backspaces in <750 ms total) still fire
  //     zero re-renders below the header AND zero API calls.
  //
  // We deliberately keep this short because the heavy lifting (avoiding
  // the re-render storm) already happens in HelpdeskHeader; this debounce
  // is only here to coalesce two-stage typing patterns into a single
  // fetch.
  const debouncedSearch = useDebouncedValue(search, 200);
  const searchArg =
    debouncedSearch.trim().length > 0 ? debouncedSearch.trim() : undefined;

  /**
   * Deep-link support: when another page links here as `/help-desk?ticket=<id>`
   * (e.g. the "Other Tickets from this Buyer" links in ContextPanel), pre-select
   * that ticket on first mount. Once the user starts clicking around we leave
   * the URL alone — replicating the URL on every selection would fight the
   * native browser back-button experience.
   */
  const searchParams = useSearchParams();
  const initialTicketIdRef = useRef<string | null>(searchParams.get("ticket"));

  const lastQParamRef = useRef<string | null>(null);

  const {
    tickets,
    counts,
    loading,
    paging,
    pageIndex,
    pageSize,
    hasNextPage,
    hasPrevPage,
    goNextPage,
    goPrevPage,
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
  } = useHelpdesk({ folder, channel: channelArg, search: searchArg });

  // Honor ?q=... → seed search field. We compare against a ref so we
  // don't fight ourselves when the user types after navigation. On a
  // brand-new q= we also wipe any pre-selected ticket so the inbox
  // panel actually shows the search results instead of the previously
  // open thread (this is the behaviour an agent expects when they
  // submit a fresh search from the global header while a ticket is
  // already open: the reader closes and the result list appears).
  //
  // We also handle the inverse: q removed (back-button to a clean
  // /help-desk URL) clears the search field so the agent returns to
  // the unfiltered inbox state, matching what a top-nav click should
  // do.
  useEffect(() => {
    const q = searchParams.get("q");
    if (q !== lastQParamRef.current) {
      const previous = lastQParamRef.current;
      lastQParamRef.current = q;
      if (q != null) {
        setSearch(q);
        setSelectedTicketId(null);
      } else if (previous != null) {
        setSearch("");
      }
    }
    // setSelectedTicketId is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  /**
   * All selection changes (open ticket, back-to-inbox, prev/next, folder
   * change clearing the selection) go through this helper. We wrap the
   * `setSelectedTicketId` call in React 18's `startTransition` so the click
   * event itself resolves immediately — React then renders the resulting
   * mount/unmount of TicketReader as a *low-priority* update that is allowed
   * to be interrupted by subsequent user input. Without this, the click
   * handler returns only after React has finished mounting/unmounting the
   * (very heavy) reader subtree, which on production can take 30+ seconds
   * for long eBay HTML threads and makes the UI feel completely frozen.
   */
  const selectTicket = useCallback(
    (id: string | null) => {
      startTransition(() => {
        setSelectedTicketId(id);
      });
    },
    [setSelectedTicketId],
  );

  /**
   * Last non-null ticket detail we showed in the reader. We pass this to
   * `TicketReader` even after the user clicks "Back" so the reader's DOM
   * (including all sanitised SafeHtml bubbles) stays mounted while we
   * visually cross-fade back to the inbox. Hiding the reader via CSS
   * instead of unmounting avoids a 1–2 second long task on heavy threads
   * where React would otherwise tear down hundreds of sanitised HTML
   * nodes and trigger GC. The retained content gets replaced atomically
   * the next time the user actually opens a *different* ticket.
   */
  const [retainedTicket, setRetainedTicket] = useState<typeof selectedTicket>(
    null,
  );
  useEffect(() => {
    if (selectedTicket) setRetainedTicket(selectedTicket);
  }, [selectedTicket]);

  const safeMode = useMemo(
    () => syncStatus?.flags.safeMode ?? true,
    [syncStatus?.flags.safeMode],
  );

  // Apply deep-link selection once the hook has loaded its setter.
  useEffect(() => {
    const id = initialTicketIdRef.current;
    if (id) {
      setSelectedTicketId(id);
      initialTicketIdRef.current = null;
    }
    // setSelectedTicketId is stable; we only want this to run on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-advance: when the selected ticket transitions to RESOLVED (e.g. user
  // sent a "Send + mark Resolved"), jump to the next visible ticket. We track
  // the previous status with a ref so the effect only fires on a real change.
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const current = selectedTicket?.status ?? null;
    const previous = prevStatusRef.current;
    prevStatusRef.current = current;
    if (!prefs.autoAdvance) return;
    if (!selectedTicket) return;
    if (previous === "RESOLVED") return;
    if (current !== "RESOLVED") return;
    const idx = tickets.findIndex((t) => t.id === selectedTicket.id);
    if (idx < 0) return;
    const next = tickets.find(
      (t, i) => i !== idx && t.status !== "RESOLVED" && !t.isArchived,
    );
    selectTicket(next ? next.id : null);
  }, [selectedTicket, tickets, prefs.autoAdvance, selectTicket]);

  // ─── Prev/Next ticket navigation (eDesk-style global header arrows) ─────────
  // Derived from the *currently rendered* ticket list (after server-side
  // search/folder/channel filtering). We deliberately ignore the table-mode
  // status chip filter here because that lives in <TicketList /> and isn't
  // available at this level — the arrows still walk the inbox in display
  // order, which is what an agent expects.
  const selectedIndex = useMemo(() => {
    if (!selectedTicketId) return -1;
    return tickets.findIndex((t) => t.id === selectedTicketId);
  }, [tickets, selectedTicketId]);
  const prevTicketId =
    selectedIndex > 0 ? tickets[selectedIndex - 1]?.id ?? null : null;
  const nextTicketId =
    selectedIndex >= 0 && selectedIndex < tickets.length - 1
      ? tickets[selectedIndex + 1]?.id ?? null
      : null;
  const goPrev = prevTicketId
    ? () => selectTicket(prevTicketId)
    : undefined;
  const goNext = nextTicketId
    ? () => selectTicket(nextTicketId)
    : undefined;

  // Up/Down arrow keys when no input is focused → walk the inbox.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      if (!selectedTicketId) return;
      e.preventDefault();
      if (e.key === "ArrowUp" && prevTicketId) selectTicket(prevTicketId);
      if (e.key === "ArrowDown" && nextTicketId) selectTicket(nextTicketId);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedTicketId, prevTicketId, nextTicketId, selectTicket]);

  // ─── Batch action handler shared between layouts ─────────────────────────────
  async function onBatchAction(
    action:
      | { kind: "archive"; archived: boolean }
      | { kind: "setStatus"; status: string }
      | { kind: "markSpam"; isSpam: boolean }
      | { kind: "assign"; userId: string | null }
      | { kind: "markRead"; isRead: boolean },
    ticketIds: string[],
  ) {
    let body: Record<string, unknown>;
    switch (action.kind) {
      case "archive":
        body = { action: "archive", ticketIds, isArchived: action.archived };
        break;
      case "setStatus":
        body = { action: "setStatus", ticketIds, status: action.status };
        break;
      case "markSpam":
        body = { action: "markSpam", ticketIds, isSpam: action.isSpam };
        break;
      case "assign":
        body = { action: "assignPrimary", ticketIds, userId: action.userId };
        break;
      case "markRead":
        body = { action: "markRead", ticketIds, isRead: action.isRead };
        break;
    }
    const res = await fetch("/api/helpdesk/tickets/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(`Batch action failed: ${j.error?.message ?? res.status}`);
    }
    refresh();
  }

  return (
    // Lock the page to the available main-content height so each pane
    // (sidebar / inbox / reader / context) manages its own scroll.
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <HelpdeskHeader
        syncStatus={syncStatus}
        manualSyncing={manualSyncing}
        onManualSync={triggerManualSync}
        agent={agent}
        // While a ticket is open in the reader the header search field
        // shows blank (the agent already drilled down — keeping the
        // previous query visible there is misleading). The actual
        // `search` state still drives the underlying inbox filter; we
        // just hide it from the header chrome.
        search={selectedTicketId ? "" : search}
        onSearchChange={setSearch}
        ticketOpen={!!selectedTicketId}
        onCloseTicket={() => selectTicket(null)}
      />
      {error && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-5 py-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <FolderSidebar
          active={folder}
          counts={counts}
          onChange={(f) => {
            setFolder(f);
            selectTicket(null);
          }}
          channelFilter={channelFilter}
          onChannelChange={setChannelFilter}
          isAdmin={isAdmin}
        />

        {prefs.layout === "list" ? (
          // ── LIST LAYOUT ─────────────────────────────────────────────────────────
          // Inbox is full-width when no ticket is selected. Selecting a ticket
          // overlays the in-place reader on top (eDesk-style). The inbox
          // returns when the user clicks "← Back".
          //
          // PERFORMANCE: TicketList stays MOUNTED at all times. We toggle its
          // visibility via the `hidden` class instead of conditionally rendering
          // it. This eliminates the unmount→remount cost on every Back click,
          // which on production was a 30+ second main-thread block (long task)
          // because remounting 50 ticket rows + restarting their effects /
          // SLA timers is genuinely expensive. The reader itself still mounts
          // on open and unmounts on Back, but that work is now wrapped in
          // `startTransition` so the click event resolves instantly and React
          // is allowed to interleave the heavy unmount with subsequent input.
          <div className="relative flex flex-1 min-w-0 overflow-hidden">
            <div
              className={cn(
                "flex flex-1 min-w-0",
                selectedTicketId !== null && "hidden",
              )}
            >
              <TicketList
                tickets={tickets}
                loading={loading}
                selectedId={selectedTicketId}
                onSelect={selectTicket}
                onPrefetch={prefetchTicket}
                search={search}
                onSearchChange={setSearch}
                onRefresh={refresh}
                onBatchAction={onBatchAction}
                flush
                widthClassName="flex-1 min-w-0"
                tableMode
                channelFilter={channelFilter}
                onChannelFilterChange={setChannelFilter}
                statusFilter={statusFilter}
                onStatusFilterChange={setStatusFilter}
                pageIndex={pageIndex}
                pageSize={pageSize}
                hasNextPage={hasNextPage}
                hasPrevPage={hasPrevPage}
                paging={paging}
                onPrevPage={goPrevPage}
                onNextPage={goNextPage}
              />
            </div>
            {/*
              PERFORMANCE: TicketReader stays mounted as soon as any ticket
              has been opened. On "Back" we just hide it with CSS — the
              entire SafeHtml/ContextPanel/Composer subtree (often hundreds
              of sanitised DOM nodes) is preserved instead of being torn
              down, which eliminates the 1–2 s long task that the unmount
              cascade used to produce on heavy eBay HTML threads. The
              retained ticket is swapped only when the user opens a
              *different* ticket, so the cost is paid at most once per
              switch instead of once per Back.
            */}
            {retainedTicket && (
              <div
                className={cn(
                  "flex flex-1 min-w-0",
                  selectedTicketId === null && "hidden",
                )}
              >
                <TicketReader
                  ticket={
                    selectedTicket && selectedTicket.id === selectedTicketId
                      ? selectedTicket
                      : retainedTicket
                  }
                  loading={selectedLoading}
                  safeMode={safeMode}
                  syncStatus={syncStatus}
                  showBack
                  onBack={() => selectTicket(null)}
                  onPrev={goPrev}
                  onNext={goNext}
                  hasPrev={!!prevTicketId}
                  hasNext={!!nextTicketId}
                  onSent={refresh}
                />
              </div>
            )}
          </div>
        ) : (
          // ── SPLIT LAYOUT (default) ──────────────────────────────────────────────
          // Two resizable columns: ticket list ↔ reader (thread + context).
          // The reader itself contains a second resizer between thread and
          // context. Both widths persist in helpdesk prefs.
          <HelpdeskSplit
            value={prefs.inboxWidthPct}
            onCommit={(pct) => updateHelpdeskPrefs({ inboxWidthPct: pct })}
            min={15}
            max={45}
            className="flex-1"
            left={
              <TicketList
                tickets={tickets}
                loading={loading}
                selectedId={selectedTicketId}
                onSelect={selectTicket}
                onPrefetch={prefetchTicket}
                search={search}
                onSearchChange={setSearch}
                onRefresh={refresh}
                onBatchAction={onBatchAction}
                flush
                widthClassName="flex-1 min-w-0"
                pageIndex={pageIndex}
                pageSize={pageSize}
                hasNextPage={hasNextPage}
                hasPrevPage={hasPrevPage}
                paging={paging}
                onPrevPage={goPrevPage}
                onNextPage={goNextPage}
              />
            }
            right={
              <TicketReader
                ticket={selectedTicket}
                loading={selectedLoading}
                safeMode={safeMode}
                syncStatus={syncStatus}
                showBack={false}
                onPrev={goPrev}
                onNext={goNext}
                hasPrev={!!prevTicketId}
                hasNext={!!nextTicketId}
                onSent={refresh}
              />
            }
          />
        )}
      </div>
    </div>
  );
}
