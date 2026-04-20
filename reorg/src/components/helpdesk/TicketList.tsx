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
  | { kind: "markRead"; isRead: boolean };

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
}: TicketListProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<AgentBadge[]>([]);
  const [showAssignMenu, setShowAssignMenu] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const assignMenuRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const prefs = useHelpdeskPrefs();
  const rowPad = prefs.density === "compact" ? "py-1.5" : "py-2.5";

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
      <div className="border-b border-hairline p-2">
        <div className="relative flex items-center gap-2">
          {onBatchAction && tickets.length > 0 ? (
            <button
              type="button"
              onClick={toggleAllVisible}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
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
            <div className="flex flex-1 items-center justify-between gap-2 rounded-md border border-brand/30 bg-brand/10 px-2 py-1 text-[11px] text-foreground">
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
              {tickets.length} {tickets.length === 1 ? "ticket" : "tickets"}
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
        <div className="flex flex-wrap items-center gap-1.5 border-b border-hairline bg-card/40 px-3 py-2 text-[11px]">
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
        </div>
      )}

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
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : visibleTickets.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm font-medium text-foreground">No tickets</p>
            <p className="text-xs text-muted-foreground">
              When buyers send eBay messages, they'll appear here within 5–15 minutes.
            </p>
          </div>
        ) : tableMode ? (
          // ── eDESK-STYLE TABLE ─────────────────────────────────────────────────
          // Wider columns: select / star / channel / customer / subject /
          // owner / time / unread badge. Mirrors the eDesk inbox layout but
          // styled with reorG tokens. Density aware.
          <table className="w-full table-fixed border-collapse text-xs">
            <colgroup>
              {onBatchAction && <col className="w-[36px]" />}
              <col className="w-[40px]" />
              <col className="w-[64px]" />
              <col className="w-[200px]" />
              <col />
              <col className="w-[120px]" />
              <col className="w-[44px]" />
              <col className="w-[88px]" />
            </colgroup>
            <thead className="sticky top-0 z-[1] border-b border-hairline bg-card/95 backdrop-blur">
              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                {onBatchAction && (
                  <th className="px-2 py-2">
                    <button
                      type="button"
                      onClick={toggleAllVisible}
                      className="flex h-4 w-4 items-center justify-center rounded border border-hairline text-muted-foreground hover:text-foreground cursor-pointer"
                      title={
                        allVisibleSelected ? "Clear selection" : "Select all visible"
                      }
                    >
                      {allVisibleSelected ? (
                        <CheckSquare className="h-3 w-3" />
                      ) : (
                        <Square className="h-3 w-3" />
                      )}
                    </button>
                  </th>
                )}
                <th className="px-1 py-2"></th>
                <th className="px-2 py-2">Channel</th>
                <th className="px-2 py-2">Customer</th>
                <th className="px-2 py-2">Latest update</th>
                <th className="px-2 py-2">Owner</th>
                <th className="px-2 py-2">Time</th>
                <th className="px-2 py-2 text-right">Tags</th>
              </tr>
            </thead>
            <tbody>
              {visibleTickets.map((t) => {
                const isActive = selectedId === t.id;
                const isUnread = t.unreadCount > 0;
                const isChecked = selected.has(t.id);
                return (
                  <tr
                    key={t.id}
                    onContextMenu={(e) => openContextMenu(e, t.id)}
                    onClick={() => onSelect(t.id)}
                    onMouseEnter={() => onPrefetch?.(t.id)}
                    onFocus={() => onPrefetch?.(t.id)}
                    className={cn(
                      "group cursor-pointer border-b border-hairline align-middle transition-colors",
                      isUnread
                        ? "bg-brand/[0.04]"
                        : "bg-transparent text-muted-foreground",
                      isActive && "!bg-brand-muted",
                      "hover:bg-surface-2",
                    )}
                  >
                    {onBatchAction && (
                      <td
                        className="px-2 py-2.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggle(t.id)}
                          className="h-3.5 w-3.5 cursor-pointer accent-brand"
                          aria-label="Select ticket"
                        />
                      </td>
                    )}
                    <td className="px-1 py-2.5">
                      {/* Star/flag is a v2 feature — surface a placeholder slot
                          today so we can wire it up without a re-layout. */}
                      <Star
                        className={cn(
                          "h-3.5 w-3.5",
                          "text-muted-foreground/30 group-hover:text-muted-foreground",
                        )}
                      />
                    </td>
                    <td className="px-2 py-2.5">
                      <span className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {CHANNEL_BADGE[t.channel] ?? t.channel}
                      </span>
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {isUnread && (
                          <span
                            aria-hidden
                            className="inline-block h-2 w-2 shrink-0 rounded-full bg-brand"
                          />
                        )}
                        <span
                          className={cn(
                            "truncate",
                            isUnread
                              ? "font-bold text-foreground"
                              : "font-normal",
                          )}
                          title={t.buyerName ?? t.buyerUserId ?? "Unknown buyer"}
                        >
                          {t.buyerName ?? t.buyerUserId ?? "Unknown buyer"}
                        </span>
                        {t.kind === "PRE_SALES" && (
                          <span className="shrink-0 rounded bg-sky-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-300">
                            Pre
                          </span>
                        )}
                      </div>
                      <p
                        className={cn(
                          "truncate text-[11px]",
                          isUnread ? "text-foreground/80" : "text-muted-foreground/80",
                        )}
                      >
                        {t.ebayOrderNumber
                          ? `Order #${t.ebayOrderNumber}`
                          : t.buyerEmail ?? "—"}
                      </p>
                    </td>
                    <td className="px-2 py-2.5">
                      <p
                        className={cn(
                          "truncate text-[12px]",
                          isUnread
                            ? "font-semibold text-foreground"
                            : "text-muted-foreground",
                        )}
                        title={t.subject ?? t.ebayItemTitle ?? "(no subject)"}
                      >
                        {t.subject ?? t.ebayItemTitle ?? "(no subject)"}
                      </p>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                        <span
                          className={cn(
                            "rounded border px-1.5 py-0.5 font-semibold uppercase tracking-wider",
                            STATUS_COLOR[t.status] ??
                              "border-hairline text-muted-foreground",
                          )}
                        >
                          {t.status.replace("_", " ")}
                        </span>
                        <SLATimer
                          lastBuyerMessageAt={t.lastBuyerMessageAt}
                          firstResponseAt={t.firstResponseAt ?? null}
                        />
                      </div>
                    </td>
                    <td className="px-2 py-2.5">
                      {t.primaryAssignee ? (
                        <div className="flex items-center gap-1.5">
                          <Avatar user={t.primaryAssignee} size="xs" />
                          <span className="truncate text-[11px] text-muted-foreground">
                            {t.primaryAssignee.name?.split(" ")[0] ??
                              t.primaryAssignee.handle ??
                              "—"}
                          </span>
                        </div>
                      ) : (
                        <span className="text-[10px] text-muted-foreground/60">
                          Unassigned
                        </span>
                      )}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-2.5 text-right tabular-nums",
                        isUnread
                          ? "font-semibold text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {relTime(t.lastBuyerMessageAt ?? t.lastAgentMessageAt)}
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {t.tags.slice(0, 2).map((tag) => (
                          <span
                            key={tag.id}
                            className="inline-flex max-w-[64px] items-center gap-0.5 truncate rounded border border-hairline bg-surface px-1 py-0.5 text-[9px] text-muted-foreground"
                            title={tag.name}
                          >
                            <TagIcon className="h-2.5 w-2.5" />
                            {tag.name}
                          </span>
                        ))}
                        {t.tags.length > 2 && (
                          <span className="text-[9px] text-muted-foreground">
                            +{t.tags.length - 2}
                          </span>
                        )}
                        {t.unreadCount > 0 && (
                          <span className="ml-1 rounded-full bg-brand px-1.5 py-0.5 text-[9px] font-bold text-brand-foreground">
                            {t.unreadCount}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
                    "relative",
                    // ── READ-STATE ────────────────────────────────────────────────
                    // Unread rows get a left accent stripe + tinted background so
                    // the at-a-glance distinction from read rows is unmistakable.
                    // Read rows fall back to the surface background and slightly
                    // dimmed text for clear visual demotion.
                    isUnread
                      ? "bg-brand/[0.04] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-brand"
                      : "bg-transparent opacity-90",
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
                      "flex w-full flex-col gap-1 pr-3 text-left transition-colors cursor-pointer",
                      rowPad,
                      onBatchAction ? "pl-7" : "pl-3",
                      isActive
                        ? "bg-brand-muted"
                        : "hover:bg-surface-2",
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
                      {t.subject ?? t.ebayItemTitle ?? "(no subject)"}
                    </p>
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span
                        className={cn(
                          "rounded border px-1.5 py-0.5 font-semibold uppercase tracking-wider",
                          STATUS_COLOR[t.status] ?? "border-hairline text-muted-foreground",
                        )}
                      >
                        {t.status.replace("_", " ")}
                      </span>
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 font-medium text-muted-foreground">
                        {CHANNEL_BADGE[t.channel] ?? t.channel}
                      </span>
                      {t.kind === "PRE_SALES" && (
                        <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-medium text-sky-700 dark:text-sky-300">
                          Pre-sales
                        </span>
                      )}
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
      {onBatchAction && selected.size > 0 ? (
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
