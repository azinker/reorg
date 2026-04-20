"use client";

import { useEffect, useRef, useState, useMemo } from "react";
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
  // Debounce search before it hits the network. The header field still
  // reflects every keystroke instantly (controlled local state in
  // HelpdeskHeader), but the API request — which can be slow on a large
  // mailbox (sequential scan over `messages.bodyText`) — only fires after
  // the user pauses typing for 500 ms. eDesk uses ~500 ms too; at 350 ms a
  // fast typist would still trigger one fetch mid-word. Crucially, common
  // "type-then-delete" gestures (e.g. typing "Apple" then immediately
  // backspacing it out) now stay entirely under the debounce window and
  // fire ZERO fetches, eliminating the freeze the user experienced.
  const debouncedSearch = useDebouncedValue(search, 500);
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
  } = useHelpdesk({ folder, channel: channelArg, search: searchArg });

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
    setSelectedTicketId(next ? next.id : null);
  }, [selectedTicket, tickets, prefs.autoAdvance, setSelectedTicketId]);

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
    ? () => setSelectedTicketId(prevTicketId)
    : undefined;
  const goNext = nextTicketId
    ? () => setSelectedTicketId(nextTicketId)
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
      if (e.key === "ArrowUp" && prevTicketId) setSelectedTicketId(prevTicketId);
      if (e.key === "ArrowDown" && nextTicketId) setSelectedTicketId(nextTicketId);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedTicketId, prevTicketId, nextTicketId, setSelectedTicketId]);

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
        search={search}
        onSearchChange={setSearch}
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
            setSelectedTicketId(null);
          }}
          channelFilter={channelFilter}
          onChannelChange={setChannelFilter}
          isAdmin={isAdmin}
        />

        {prefs.layout === "list" ? (
          // ── LIST LAYOUT ─────────────────────────────────────────────────────────
          // Inbox is full-width when no ticket is selected. Selecting a ticket
          // swaps the inbox for the in-place reader (eDesk-style). The inbox
          // returns when the user clicks "← Back".
          selectedTicketId !== null ? (
            <TicketReader
              ticket={selectedTicket}
              loading={selectedLoading}
              safeMode={safeMode}
              syncStatus={syncStatus}
              showBack
              onBack={() => setSelectedTicketId(null)}
              onPrev={goPrev}
              onNext={goNext}
              hasPrev={!!prevTicketId}
              hasNext={!!nextTicketId}
              onSent={refresh}
            />
          ) : (
            <TicketList
              tickets={tickets}
              loading={loading}
              selectedId={selectedTicketId}
              onSelect={setSelectedTicketId}
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
          )
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
                onSelect={setSelectedTicketId}
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
