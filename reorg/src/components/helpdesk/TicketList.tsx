"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Loader2,
  Archive,
  CheckCircle2,
  AlertOctagon,
  X,
  CheckSquare,
  Square,
  UserPlus,
  Inbox,
  MailOpen,
  MailMinus,
  ExternalLink,
  Clock,
  Star,
  Tag as TagIcon,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { HelpdeskTicketSummary } from "@/hooks/use-helpdesk";
import { SLATimer } from "@/components/helpdesk/SLATimer";
import { useHelpdeskPrefs } from "@/components/helpdesk/HelpdeskSettingsDialog";
import { Avatar } from "@/components/ui/avatar";
import { TicketTable } from "@/components/helpdesk/TicketTable";

/** Compact agent shape used by the bulk-assign dropdown. */
interface AgentBadge {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  handle: string | null;
}

export type BulkAction =
  | { kind: "archive"; archived: boolean }
  | { kind: "setStatus"; status: "RESOLVED" | "TO_DO" | "WAITING" }
  | { kind: "markSpam"; isSpam: boolean }
  | { kind: "assign"; userId: string | null }
  | { kind: "markRead"; isRead: boolean }
  | { kind: "moveToFolder"; agentFolderId: string | null };

interface TicketListProps {
  tickets: HelpdeskTicketSummary[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (v: string) => void;
  /**
   * Manual refresh hook. The toolbar no longer renders a Refresh button
   * (replaced by 60s polling + the global "Sync now"), but consumers may
   * still call this after an action so we keep the prop optional for
   * forward-compat. Today nothing inside TicketList invokes it.
   */
  onRefresh?: () => void;
  /** Optional bulk-action handler. If omitted, batch-select is hidden. */
  onBatchAction?: (action: BulkAction, ticketIds: string[]) => Promise<void> | void;
  /** When true, hides the divider on the right side (used in List layout). */
  flush?: boolean;
  /** Container width override; defaults to the standard 360px split-pane width. */
  widthClassName?: string;
  /**
   * eDesk-style table renderer. Activated by the List layout when the inbox
   * is full-width — gives us room to surface columns the narrow Split-layout
   * column can't fit (channel chip, customer with VIP/New badge, owner avatar,
   * SLA bar, order value, tags). Split layout keeps the dense row rendering.
   */
  tableMode?: boolean;
  /** Channel filter (mirrors HelpDeskClient state). Only used in tableMode. */
  channelFilter?: "TPP_EBAY" | "TT_EBAY" | "ALL";
  onChannelFilterChange?: (v: "TPP_EBAY" | "TT_EBAY" | "ALL") => void;
  /** Status filter applied client-side over the loaded page. Only in tableMode. */
  statusFilter?: "ALL" | "NEW" | "TO_DO" | "WAITING" | "RESOLVED";
  onStatusFilterChange?: (
    v: "ALL" | "NEW" | "TO_DO" | "WAITING" | "RESOLVED",
  ) => void;
  /**
   * Pagination — prev/next arrows in the toolbar footer. The list is shown
   * one page (50 tickets) at a time. These props are wired through from the
   * `useHelpdesk` hook; if any are omitted the pagination footer is hidden.
   */
  pageIndex?: number;
  pageSize?: number;
  hasNextPage?: boolean;
  hasPrevPage?: boolean;
  paging?: boolean;
  onPrevPage?: () => void;
  onNextPage?: () => void;
  /**
   * Optional prefetch hook called on row hover/focus. Wired up to
   * `useHelpdesk().prefetchTicket` so the ticket detail starts loading the
   * moment the cursor lands on a row — by the time the user clicks, the
   * payload is already in the inbox cache and the click resolves instantly.
   * eDesk uses the same pattern (and it's the single biggest reason their
   * inbox feels snappier than ours).
   */
  onPrefetch?: (id: string) => void;
  /**
   * Optional slot rendered between the toolbar and the ticket rows. Used by
   * the From eBay folder to surface its event-type chip bar (Return
   * Approved / Item Not Received / …) right above the list. Kept as a
   * generic slot so future folders can reuse the same affordance without
   * baking new flags into TicketList.
   */
  headerExtra?: React.ReactNode;
  /** Agent folders for the "Move to folder" bulk action. */
  agentFolders?: Array<{ id: string; name: string; color: string }>;
}

const STATUS_COLOR: Record<string, string> = {
  NEW: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  TO_DO: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  WAITING: "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30",
  RESOLVED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  SPAM: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  ARCHIVED: "bg-surface-2 text-muted-foreground border-hairline",
};

const CHANNEL_BADGE: Record<string, string> = {
  TPP_EBAY: "TPP",
  TT_EBAY: "TT",
};

function relTime(date: string | null): string {
  if (!date) return "—";
  const ms = Date.now() - new Date(date).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d`;
  return new Date(date).toLocaleDateString();
}

function workReason(t: HelpdeskTicketSummary): string {
  if (t.isSpam || t.status === "SPAM") return "Spam review";
  if (t.isArchived || t.status === "ARCHIVED") return "Archived";
  if (t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now()) {
    return "Snoozed";
  }
  if (t.type === "SYSTEM" || t.systemMessageType) return "eBay update";
  if (t.unreadCount > 0) return "Buyer replied";
  if (t.status === "WAITING") return "Waiting";
  if (t.status === "RESOLVED") return "Resolved";
  if (!t.primaryAssignee) return "Unassigned";
  return "Needs review";
}

interface ContextMenuState {
  ticketId: string;
  x: number;
  y: number;
}

export function TicketList({
  tickets,
  loading,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  onBatchAction,
  flush = false,
  widthClassName,
  tableMode = false,
  channelFilter = "ALL",
  onChannelFilterChange,
  statusFilter = "ALL",
  onStatusFilterChange,
  pageIndex = 0,
  pageSize = 50,
  hasNextPage = false,
  hasPrevPage = false,
  paging = false,
  onPrevPage,
  onNextPage,
  onPrefetch,
  headerExtra,
  agentFolders = [],
}: TicketListProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<AgentBadge[]>([]);
  const [showAssignMenu, setShowAssignMenu] = useState(false);
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const moveMenuRef = useRef<HTMLDivElement | null>(null);
  const assignMenuRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const prefs = useHelpdeskPrefs();
  const rowPad =
    prefs.density === "compact"
      ? "py-1.5"
      : prefs.density === "spacious"
        ? "py-4"
        : "py-2.5";

  // Lazy-load the agent roster the first time someone selects a ticket so the
  // assign dropdown can render their avatars + names. Cheap query (≤ 10 rows).
  useEffect(() => {
    const needed = selected.size > 0 || contextMenu !== null;
    if (!needed || agents.length > 0 || !onBatchAction) return;
    let cancelled = false;
    void fetch("/api/helpdesk/agents", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j: { data: AgentBadge[] }) => {
        if (!cancelled) setAgents(j.data ?? []);
      })
      .catch(() => {
        // non-fatal — assign dropdown will just be empty
      });
    return () => {
      cancelled = true;
    };
  }, [selected.size, contextMenu, agents.length, onBatchAction]);

  // Click-away to close assign menu.
  useEffect(() => {
    if (!showAssignMenu) return;
    function onDoc(e: MouseEvent) {
      if (assignMenuRef.current && !assignMenuRef.current.contains(e.target as Node)) {
        setShowAssignMenu(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showAssignMenu]);

  // Click-away to close move-to-folder menu.
  useEffect(() => {
    if (!showMoveMenu) return;
    function onDoc(e: MouseEvent) {
      if (moveMenuRef.current && !moveMenuRef.current.contains(e.target as Node)) {
        setShowMoveMenu(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showMoveMenu]);

  // Right-click context menu close-on-click-outside / Esc.
  useEffect(() => {
    if (!contextMenu) return;
    function onDoc(e: MouseEvent) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setContextMenu(null);
    }
    function onScroll() {
      setContextMenu(null);
    }
    // mousedown closes on next click anywhere; capture-phase scroll closes when
    // the user scrolls the inbox so the menu doesn't drift off its anchor.
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [contextMenu]);

  /**
   * Apply the table-mode status chip client-side. We deliberately keep this
   * filter local instead of pushing it into the API request because:
   *   - It composes with the active folder (which already pre-filters) without
   *     a backend round-trip.
   *   - The chip is intended to be a quick eyeball filter on the visible page,
   *     not a deep-search across all tickets.
   * In Split / non-tableMode this collapses to the identity (statusFilter is
   * ignored) so the dense-row inbox remains unaffected.
   */
  const visibleTickets = useMemo(() => {
    if (!tableMode || statusFilter === "ALL") return tickets;
    return tickets.filter((t) => t.status === statusFilter);
  }, [tickets, tableMode, statusFilter]);

  const allVisibleSelected = useMemo(
    () => visibleTickets.length > 0 && visibleTickets.every((t) => selected.has(t.id)),
    [visibleTickets, selected],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllVisible() {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const t of visibleTickets) next.delete(t.id);
        return next;
      }
      const next = new Set(prev);
      for (const t of visibleTickets) next.add(t.id);
      return next;
    });
  }
  function clearSelection() {
    setSelected(new Set());
  }
  async function runAction(action: BulkAction) {
    if (!onBatchAction || selected.size === 0) return;
    setBusy(true);
    try {
      await onBatchAction(action, Array.from(selected));
      clearSelection();
      setShowAssignMenu(false);
      setShowMoveMenu(false);
    } finally {
      setBusy(false);
    }
  }

  /** Run a single-ticket action from the right-click menu, then close it. */
  async function runContextAction(action: BulkAction, ticketId: string) {
    if (!onBatchAction) return;
    setContextMenu(null);
    setBusy(true);
    try {
      await onBatchAction(action, [ticketId]);
    } finally {
      setBusy(false);
    }
  }

  function openContextMenu(e: React.MouseEvent, ticketId: string) {
    if (!onBatchAction) return;
    e.preventDefault();
    // Clamp to viewport so we never spawn off-screen.
    const margin = 8;
    const menuW = 220;
    const menuH = 320;
    const x = Math.min(e.clientX, window.innerWidth - menuW - margin);
    const y = Math.min(e.clientY, window.innerHeight - menuH - margin);
    setContextMenu({ ticketId, x, y });
  }

  const containerWidth = widthClassName ?? "w-[360px] shrink-0";

  return (
    <div
      className={cn(
        "relative flex h-full flex-col bg-background",
        containerWidth,
        !flush && "border-r border-hairline",
      )}
    >
      <div className="border-b border-hairline bg-card/70 p-2 backdrop-blur-sm">
        <div className="relative flex items-center gap-2">
          {onBatchAction && tickets.length > 0 ? (
            <button
              type="button"
              onClick={toggleAllVisible}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-surface text-muted-foreground shadow-sm transition-colors hover:border-brand/40 hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 cursor-pointer"
              title={allVisibleSelected ? "Clear selection" : "Select all visible"}
              aria-label={allVisibleSelected ? "Clear selection" : "Select all visible"}
            >
              {allVisibleSelected ? (
                <CheckSquare className="h-3.5 w-3.5" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
          {/*
            Header search has moved to the global Help Desk header (one
            source of truth). We keep `search` / `onSearchChange` props on
            this component so the toolbar can show an active-search chip
            and the empty state can read the query, but no input lives here.
          */}
          {search.trim().length > 0 ? (
            <div className="flex flex-1 items-center justify-between gap-2 rounded-md border border-brand/30 bg-brand/10 px-2 py-1 text-[11px] text-foreground shadow-sm">
              <span className="truncate">
                Filtering by{" "}
                <span className="font-semibold">&ldquo;{search}&rdquo;</span>
              </span>
              <button
                type="button"
                onClick={() => onSearchChange("")}
                className="shrink-0 rounded px-1 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
                title="Clear search"
              >
                Clear
              </button>
            </div>
          ) : (
            <div className="flex-1 text-[11px] text-muted-foreground">
              <span className="font-semibold text-foreground">{tickets.length}</span>{" "}
              {tickets.length === 1 ? "ticket" : "tickets"}
            </div>
          )}
          {/*
            The standalone "Refresh" button used to sit here. We've removed it
            because:
              - "Sync now" in the global header pulls fresh messages from eBay,
                which is what an agent actually wants.
              - The inbox auto-refreshes every 60s in the background.
              - It only appeared in List layout (visually crowding "Sync now"),
                which made it look like a duplicate control.
          */}
        </div>
      </div>

      {/*
        ── FILTER CHIPS (table mode only) ───────────────────────────────────────
        Surfaced when the inbox occupies the full content area. The dense Split
        layout keeps the existing search-only header to preserve density.
      */}
      {tableMode && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-hairline bg-surface/45 px-3 py-2 text-[11px]">
          <span className="text-muted-foreground">Marketplace</span>
          <FilterChip
            active={channelFilter === "ALL"}
            onClick={() => onChannelFilterChange?.("ALL")}
            label="All"
          />
          <FilterChip
            active={channelFilter === "TPP_EBAY"}
            onClick={() => onChannelFilterChange?.("TPP_EBAY")}
            label="TPP"
          />
          <FilterChip
            active={channelFilter === "TT_EBAY"}
            onClick={() => onChannelFilterChange?.("TT_EBAY")}
            label="TT"
          />
          <span className="ml-3 text-muted-foreground">Status</span>
          <FilterChip
            active={statusFilter === "ALL"}
            onClick={() => onStatusFilterChange?.("ALL")}
            label="Any"
          />
          <FilterChip
            active={statusFilter === "NEW"}
            onClick={() => onStatusFilterChange?.("NEW")}
            label="New"
          />
          <FilterChip
            active={statusFilter === "TO_DO"}
            onClick={() => onStatusFilterChange?.("TO_DO")}
            label="To Do"
          />
          <FilterChip
            active={statusFilter === "WAITING"}
            onClick={() => onStatusFilterChange?.("WAITING")}
            label="Waiting"
          />
          <FilterChip
            active={statusFilter === "RESOLVED"}
            onClick={() => onStatusFilterChange?.("RESOLVED")}
            label="Resolved"
          />
          {onBatchAction && selected.size > 0 ? (
            <>
              <span className="mx-2 h-5 w-px bg-hairline" aria-hidden />
              <span className="rounded-md bg-brand-muted px-2 py-1 font-semibold text-brand">
                {selected.size} selected
              </span>

              <div className="relative" ref={assignMenuRef}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setShowAssignMenu((v) => !v)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2 text-foreground transition-colors hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                  title="Assign selected tickets"
                >
                  <UserPlus className="h-3.5 w-3.5" /> Assign
                </button>
                {showAssignMenu ? (
                  <div className="absolute left-0 top-full z-30 mt-1 max-h-64 w-56 overflow-y-auto rounded-md border border-hairline bg-popover py-1 text-[12px] text-popover-foreground shadow-xl">
                    {agents.length === 0 ? (
                      <div className="px-3 py-2 text-muted-foreground">No agents</div>
                    ) : (
                      <>
                        {agents.map((a) => (
                          <button
                            key={a.id}
                            type="button"
                            disabled={busy}
                            onClick={() => runAction({ kind: "assign", userId: a.id })}
                            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                          >
                            <Avatar user={a} size="xs" />
                            <span className="truncate">
                              {a.name ?? a.handle ?? a.email ?? "Agent"}
                            </span>
                          </button>
                        ))}
                        <div className="my-1 border-t border-hairline" />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => runAction({ kind: "assign", userId: null })}
                          className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-muted-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                        >
                          <Avatar user={null} size="xs" unassigned />
                          Unassign
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={() => runAction({ kind: "markRead", isRead: true })}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2 text-foreground transition-colors hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                title="Mark selected as read"
              >
                <MailOpen className="h-3.5 w-3.5" /> Read
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction({ kind: "markRead", isRead: false })}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2 text-foreground transition-colors hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                title="Mark selected as unread"
              >
                <MailMinus className="h-3.5 w-3.5" /> Unread
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={() => runAction({ kind: "setStatus", status: "TO_DO" })}
                className="inline-flex h-7 items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 font-medium text-amber-700 transition-colors hover:bg-amber-500/15 disabled:opacity-50 dark:text-amber-300 cursor-pointer"
                title="Move selected to To Do"
              >
                To Do
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction({ kind: "setStatus", status: "WAITING" })}
                className="inline-flex h-7 items-center rounded-md border border-violet-500/30 bg-violet-500/10 px-2 font-medium text-violet-700 transition-colors hover:bg-violet-500/15 disabled:opacity-50 dark:text-violet-300 cursor-pointer"
                title="Move selected to Waiting"
              >
                Waiting
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction({ kind: "setStatus", status: "RESOLVED" })}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 disabled:opacity-50 dark:text-emerald-300 cursor-pointer"
                title="Mark selected resolved"
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> Resolve
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction({ kind: "archive", archived: true })}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2 text-foreground transition-colors hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                title="Archive selected"
              >
                <Archive className="h-3.5 w-3.5" /> Archive
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction({ kind: "markSpam", isSpam: true })}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2 text-red-700 transition-colors hover:bg-red-500/15 disabled:opacity-50 dark:text-red-300 cursor-pointer"
                title="Mark selected spam"
              >
                <AlertOctagon className="h-3.5 w-3.5" /> Spam
              </button>

              {agentFolders.length > 0 ? (
                <div className="relative" ref={moveMenuRef}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setShowMoveMenu((v) => !v)}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2 text-foreground transition-colors hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                    title="Move selected to an agent folder"
                  >
                    <Inbox className="h-3.5 w-3.5" /> Folder
                  </button>
                  {showMoveMenu ? (
                    <div className="absolute left-0 top-full z-30 mt-1 max-h-64 w-56 overflow-y-auto rounded-md border border-hairline bg-popover py-1 text-[12px] text-popover-foreground shadow-xl">
                      {agentFolders.map((af) => (
                        <button
                          key={af.id}
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            runAction({ kind: "moveToFolder", agentFolderId: af.id })
                          }
                          className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                        >
                          <span className={cn("h-2.5 w-2.5 rounded-full", `bg-${af.color}-500`)} />
                          <span className="truncate">{af.name}</span>
                        </button>
                      ))}
                      <div className="my-1 border-t border-hairline" />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          runAction({ kind: "moveToFolder", agentFolderId: null })
                        }
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-muted-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                      >
                        Remove from folder
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <button
                type="button"
                disabled={busy}
                onClick={clearSelection}
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                title="Clear selection"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                Clear
              </button>
            </>
          ) : null}
        </div>
      )}

      {headerExtra}

      <div className="flex-1 overflow-y-auto">
        {/*
          Empty/loading state precedence:
            1. We have tickets → render them.
            2. We're still loading the very first page → spinner.
            3. We're done loading and the page is genuinely empty → "No tickets".
          The previous version flashed "No tickets" any time the visible list
          was empty mid-fetch (e.g. on a route remount before the first
          response landed). With the inbox cache in place we usually skip the
          spinner entirely on remount, but keep it for a true cold start.
        */}
        {visibleTickets.length === 0 && loading ? (
          <TicketListSkeleton />
        ) : visibleTickets.length === 0 ? (
          <>
            <EmptyTicketListState search={search} />
            {/*
              When buyers send eBay messages, they'll appear here within 5–15 minutes.
            */}
          </>
        ) : tableMode ? (
          // ── eDESK-STYLE 10-COLUMN GRID ───────────────────────────────────────
          // Replaces the old 8-column <table> with a self-contained component
          // that owns column preferences (per-user, drag-to-reorder), sortable
          // headers, the time-left countdown bar, and the green-eye presence
          // poll. Selection / batch actions / context menu still live on this
          // component because they're shared with the dense Split rows below.
          <TicketTable
            tickets={visibleTickets}
            selectedId={selectedId}
            onSelect={onSelect}
            onPrefetch={onPrefetch}
            onContextMenu={openContextMenu}
            selected={selected}
            onToggle={toggle}
            onToggleAllVisible={toggleAllVisible}
            allVisibleSelected={allVisibleSelected}
            showSelection={!!onBatchAction}
          />
        ) : (
          <ul className="divide-y divide-hairline">
            {visibleTickets.map((t) => {
              const isActive = selectedId === t.id;
              const isUnread = t.unreadCount > 0;
              const isChecked = selected.has(t.id);
              return (
                <li
                  key={t.id}
                  className={cn(
                    "relative transition-[background-color,opacity] duration-150 ease-out motion-reduce:transition-none",
                    // ── READ-STATE ────────────────────────────────────────────────
                    // Unread rows get a left accent stripe + tinted background so
                    // the at-a-glance distinction from read rows is unmistakable.
                    // Read rows fall back to the surface background and slightly
                    // dimmed text for clear visual demotion.
                    isUnread
                      ? "bg-brand/[0.04] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-brand"
                      : "bg-transparent opacity-90",
                    isActive && "opacity-100",
                  )}
                  onContextMenu={(e) => openContextMenu(e, t.id)}
                >
                  {onBatchAction && (
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggle(t.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute left-2 top-3 z-10 h-3 w-3 cursor-pointer accent-brand"
                      aria-label="Select ticket"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => onSelect(t.id)}
                    onMouseEnter={() => onPrefetch?.(t.id)}
                    onFocus={() => onPrefetch?.(t.id)}
                    className={cn(
                      "flex w-full flex-col gap-1 pr-3 text-left transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/35",
                      rowPad,
                      onBatchAction ? "pl-7" : "pl-3",
                      isActive
                        ? "bg-brand-muted shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)]"
                        : "hover:bg-surface-2/80",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {/* Unread dot (in addition to the stripe) — a redundant
                          but high-affordance signal that scans well in dark
                          mode where tinted backgrounds are subtler. */}
                      {isUnread && (
                        <span
                          aria-hidden
                          className="inline-block h-2 w-2 shrink-0 rounded-full bg-brand"
                        />
                      )}
                      <span
                        className={cn(
                          "truncate text-sm",
                          isUnread
                            ? "font-bold text-foreground"
                            : "font-normal text-muted-foreground",
                        )}
                      >
                        {t.buyerName ?? t.buyerUserId ?? "Unknown buyer"}
                      </span>
                      <span
                        className={cn(
                          "ml-auto shrink-0 text-[10px]",
                          isUnread
                            ? "font-semibold text-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        {relTime(t.lastBuyerMessageAt ?? t.lastAgentMessageAt)}
                      </span>
                    </div>
                    <p
                      className={cn(
                        "line-clamp-1 text-xs",
                        isUnread
                          ? "font-medium text-foreground"
                          : "text-muted-foreground/80",
                      )}
                    >
                      {t.latestPreview ?? t.subject ?? t.ebayItemTitle ?? "(no subject)"}
                    </p>
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span
                        className={cn(
                          "rounded border px-1.5 py-0.5 font-semibold uppercase",
                          STATUS_COLOR[t.status] ?? "border-hairline text-muted-foreground",
                        )}
                      >
                        {t.status.replace("_", " ")}
                      </span>
                      <span className="rounded border border-hairline bg-surface-2 px-1.5 py-0.5 font-medium text-muted-foreground">
                        {CHANNEL_BADGE[t.channel] ?? t.channel}
                      </span>
                      {t.kind === "PRE_SALES" && (
                        <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-medium text-sky-700 dark:text-sky-300">
                          Pre-sales
                        </span>
                      )}
                      <span className="rounded border border-hairline bg-surface px-1.5 py-0.5 font-medium text-muted-foreground">
                        {workReason(t)}
                      </span>
                      <SLATimer
                        lastBuyerMessageAt={t.lastBuyerMessageAt}
                        firstResponseAt={t.firstResponseAt ?? null}
                      />
                      <div className="ml-auto flex items-center gap-1">
                        {t.primaryAssignee ? (
                          <Avatar user={t.primaryAssignee} size="xs" />
                        ) : null}
                        {t.unreadCount > 0 && (
                          <span className="rounded-full bg-brand px-1.5 py-0.5 font-bold text-brand-foreground">
                            {t.unreadCount}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/*
        ── PAGINATION FOOTER ───────────────────────────────────────────────────
        Pinned to the bottom of the inbox column (outside the scroll area so
        the controls stay visible no matter where the user is scrolled). Uses
        prev/next arrows instead of an append-only "Load more" button:
        the agent can step through 50 tickets at a time and walk back if
        they overshoot, which is closer to how a mailbox feels.

        Hidden entirely when:
          - parent didn't wire `onPrevPage`/`onNextPage` (e.g. embedded usage)
          - we have nothing to render and aren't on page 2+
            (i.e. there's nothing to paginate)
      */}
      {(onPrevPage || onNextPage) &&
      (visibleTickets.length > 0 || hasPrevPage) ? (
        <div className="flex items-center justify-between border-t border-hairline bg-card/40 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>
            {visibleTickets.length === 0
              ? "—"
              : `Showing ${pageIndex * pageSize + 1}–${
                  pageIndex * pageSize + visibleTickets.length
                }`}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onPrevPage}
              disabled={!hasPrevPage || paging}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-hairline bg-surface text-foreground transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
              title="Previous page"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="px-1.5 text-[11px] font-medium text-foreground">
              {paging ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : (
                `Page ${pageIndex + 1}`
              )}
            </span>
            <button
              type="button"
              onClick={onNextPage}
              disabled={!hasNextPage || paging}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-hairline bg-surface text-foreground transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
              title="Next page"
              aria-label="Next page"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      {/*
        ── BULK ACTION BAR ──────────────────────────────────────────────────────
        Anchored to the viewport (fixed positioning) rather than scoped to the
        TicketList container. This way it always sits centered along the bottom
        of the screen and never overlaps the inbox-column scroll content. We
        intentionally render it via a portal-free fixed position because nothing
        in the existing layout creates a containing block for `position: fixed`,
        so this is robust across both Split and List layouts.
      */}
      {false && onBatchAction && selected.size > 0 ? (
        <div
          className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4"
          aria-live="polite"
        >
          <div className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-hairline bg-card/95 px-2 py-1.5 shadow-2xl shadow-black/40 backdrop-blur">
            <span className="rounded-md bg-brand-muted px-2 py-1 text-[11px] font-semibold text-brand">
              {selected.size} selected
            </span>

            <div className="relative" ref={assignMenuRef}>
              <button
                type="button"
                disabled={busy}
                onClick={() => setShowAssignMenu((v) => !v)}
                className="inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[11px] text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                title="Assign to agent"
              >
                <UserPlus className="h-3 w-3" /> Assign
              </button>
              {showAssignMenu ? (
                <div className="absolute bottom-full left-0 mb-1 max-h-64 w-56 overflow-y-auto rounded-md border border-hairline bg-popover py-1 text-[12px] text-popover-foreground shadow-xl">
                  {agents.length === 0 ? (
                    <div className="px-3 py-2 text-muted-foreground">No agents</div>
                  ) : (
                    <>
                      {agents.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          disabled={busy}
                          onClick={() => runAction({ kind: "assign", userId: a.id })}
                          className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                        >
                          <Avatar user={a} size="xs" />
                          <span className="truncate">
                            {a.name ?? a.handle ?? a.email ?? "Agent"}
                          </span>
                        </button>
                      ))}
                      <div className="my-1 border-t border-hairline" />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => runAction({ kind: "assign", userId: null })}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-muted-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                      >
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-hairline-strong text-[9px]">
                          —
                        </span>
                        Unassign
                      </button>
                    </>
                  )}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              disabled={busy}
              onClick={() => runAction({ kind: "markRead", isRead: true })}
              className="inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[11px] text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
              title="Mark as read"
            >
              <MailOpen className="h-3 w-3" /> Mark read
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction({ kind: "markRead", isRead: false })}
              className="inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[11px] text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
              title="Mark as unread"
            >
              <MailMinus className="h-3 w-3" /> Mark unread
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction({ kind: "setStatus", status: "RESOLVED" })}
              className="inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[11px] text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
              title="Mark resolved"
            >
              <CheckCircle2 className="h-3 w-3" /> Resolve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction({ kind: "archive", archived: true })}
              className="inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[11px] text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
              title="Archive"
            >
              <Archive className="h-3 w-3" /> Archive
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction({ kind: "archive", archived: false })}
              className="inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[11px] text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
              title="Move back to inbox"
            >
              <Inbox className="h-3 w-3" /> Inbox
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction({ kind: "markSpam", isSpam: true })}
              className="inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[11px] text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
              title="Mark spam"
            >
              <AlertOctagon className="h-3 w-3" /> Spam
            </button>

            {agentFolders.length > 0 ? (
              <div className="relative" ref={moveMenuRef}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setShowMoveMenu((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[11px] text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                  title="Move to folder"
                >
                  <Inbox className="h-3 w-3" /> Move to folder
                </button>
                {showMoveMenu ? (
                  <div className="absolute bottom-full left-0 mb-1 max-h-64 w-56 overflow-y-auto rounded-md border border-hairline bg-popover py-1 text-[12px] text-popover-foreground shadow-xl">
                    {agentFolders.map((af) => (
                      <button
                        key={af.id}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          runAction({ kind: "moveToFolder", agentFolderId: af.id });
                          setShowMoveMenu(false);
                        }}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                      >
                        <span className={cn("h-2.5 w-2.5 rounded-full", `bg-${af.color}-500`)} />
                        <span className="truncate">{af.name}</span>
                      </button>
                    ))}
                    <div className="my-1 border-t border-hairline" />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        runAction({ kind: "moveToFolder", agentFolderId: null });
                        setShowMoveMenu(false);
                      }}
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-muted-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                    >
                      Remove from folder
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            <button
              type="button"
              disabled={busy}
              onClick={clearSelection}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-surface-2 cursor-pointer"
              title="Clear selection"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          </div>
        </div>
      ) : null}

      {/*
        ── RIGHT-CLICK CONTEXT MENU ─────────────────────────────────────────────
        Mirrors the bulk-action surface but scoped to the single ticket the user
        right-clicked. Positioned as `fixed` at the cursor coords so it never
        gets clipped by an overflow-hidden ancestor, which the inbox column has.
      */}
      {contextMenu &&
        onBatchAction &&
        (() => {
          // Look in the unfiltered list — the context menu can be opened on
          // any rendered row, but we want to be robust if filter state shifts.
          const ticket = tickets.find((t) => t.id === contextMenu.ticketId);
          if (!ticket) return null;
          const isUnread = ticket.unreadCount > 0;
          return (
            <div
              ref={contextMenuRef}
              role="menu"
              aria-label="Ticket actions"
              className="fixed z-50 w-56 rounded-md border border-hairline bg-popover py-1 text-[12px] text-popover-foreground shadow-2xl shadow-black/40"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <ContextMenuItem
                icon={isUnread ? MailOpen : MailMinus}
                label={isUnread ? "Mark as read" : "Mark as unread"}
                onClick={() =>
                  runContextAction({ kind: "markRead", isRead: isUnread }, ticket.id)
                }
              />
              <ContextMenuItem
                icon={CheckCircle2}
                label="Mark resolved"
                onClick={() =>
                  runContextAction(
                    { kind: "setStatus", status: "RESOLVED" },
                    ticket.id,
                  )
                }
              />
              <ContextMenuItem
                icon={Clock}
                label="Move to Waiting"
                onClick={() =>
                  runContextAction(
                    { kind: "setStatus", status: "WAITING" },
                    ticket.id,
                  )
                }
              />
              <div className="my-1 border-t border-hairline" />
              <ContextMenuItem
                icon={Archive}
                label={ticket.isArchived ? "Move back to inbox" : "Archive"}
                onClick={() =>
                  runContextAction(
                    { kind: "archive", archived: !ticket.isArchived },
                    ticket.id,
                  )
                }
              />
              <ContextMenuItem
                icon={AlertOctagon}
                label={ticket.isSpam ? "Not spam" : "Mark spam"}
                onClick={() =>
                  runContextAction(
                    { kind: "markSpam", isSpam: !ticket.isSpam },
                    ticket.id,
                  )
                }
              />
              <div className="my-1 border-t border-hairline" />
              <ContextMenuItem
                icon={ExternalLink}
                label="Open in new tab"
                onClick={() => {
                  window.open(`/help-desk?ticket=${ticket.id}`, "_blank");
                  setContextMenu(null);
                }}
              />
            </div>
          );
        })()}
    </div>
  );
}

function TicketListSkeleton() {
  return (
    <div className="space-y-0 border-t border-transparent p-3" aria-label="Loading tickets">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="rounded-md border border-hairline bg-card/60 p-3"
        >
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-foreground/10" />
            <span className="h-3 w-28 animate-pulse rounded bg-foreground/10" />
            <span className="ml-auto h-2.5 w-10 animate-pulse rounded bg-foreground/10" />
          </div>
          <div className="mt-3 h-3 w-4/5 animate-pulse rounded bg-foreground/10" />
          <div className="mt-3 flex gap-1.5">
            <span className="h-5 w-14 animate-pulse rounded bg-foreground/10" />
            <span className="h-5 w-10 animate-pulse rounded bg-foreground/10" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyTicketListState({ search }: { search: string }) {
  const hasSearch = search.trim().length > 0;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-md border border-hairline bg-surface">
        <Inbox className="h-5 w-5 text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">
          {hasSearch ? "No matching tickets" : "No tickets"}
        </p>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          {hasSearch
            ? "Try the buyer's eBay username, the full order number, or switch back to All Tickets."
            : "Buyer messages will appear here after the next Help Desk sync."}
        </p>
        <div className="mt-3 flex flex-wrap justify-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="rounded-full border border-hairline bg-surface px-2 py-0.5">
            Buyer username
          </span>
          <span className="rounded-full border border-hairline bg-surface px-2 py-0.5">
            eBay order ID
          </span>
          <span className="rounded-full border border-hairline bg-surface px-2 py-0.5">
            Folder filter
          </span>
        </div>
      </div>
    </div>
  );
}

interface ContextMenuItemProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}
function ContextMenuItem({ icon: Icon, label, onClick }: ContextMenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground hover:bg-surface-2 cursor-pointer"
    >
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </button>
  );
}

interface FilterChipProps {
  active: boolean;
  onClick: () => void;
  label: string;
}
/**
 * Small toggle chip used in the table-mode filter bar. Active state uses the
 * brand-muted background so it visually pairs with the sidebar's selected-row
 * treatment, keeping the inbox feeling cohesive.
 */
function FilterChip({ active, onClick, label }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer",
        active
          ? "border-brand/40 bg-brand-muted text-brand"
          : "border-hairline bg-surface text-muted-foreground hover:bg-surface-2 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
