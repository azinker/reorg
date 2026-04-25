"use client";

/**
 * TicketTable — the eDesk-style 10-column inbox grid used in List layout.
 *
 * This component is intentionally self-contained:
 *   - Loads + persists per-user column preferences via /helpdesk/column-prefs
 *   - Polls /helpdesk/presence for the visible page every 8s (single roundtrip)
 *   - Renders sortable headers that mutate a local sort state (server-side
 *     ordering is folder-driven, so this is a client-side stable sort over
 *     the loaded page; matches eDesk semantics)
 *   - Drag-to-reorder + show/hide via the EditColumnsDialog
 *
 * The host (TicketList) owns selection, search, batch actions, pagination and
 * filters. We're only responsible for rendering the rows + header row +
 * column-config affordances.
 */

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Check,
  CheckSquare,
  Copy,
  Eye,
  Flag,
  Mail,
  GripVertical,
  Inbox,
  Settings2,
  Square,
  Star,
  X,
} from "lucide-react";
import type { HelpdeskTicketSummary } from "@/hooks/use-helpdesk";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

// ─── Column definitions ─────────────────────────────────────────────────────

const KNOWN_COLUMN_KEYS = [
  "channel",
  "customer",
  "type",
  "latestUpdate",
  "owner",
  "timeLeft",
  "created",
  "status",
  "orderId",
  "ebayUsername",
] as const;

export type ColumnKey = (typeof KNOWN_COLUMN_KEYS)[number];

const DEFAULT_COLUMNS: ColumnKey[] = [...KNOWN_COLUMN_KEYS];

interface ColumnDef {
  key: ColumnKey;
  label: string;
  /** Approximate fixed width (CSS). `undefined` → flex-1. */
  width: string | undefined;
  sortable: boolean;
  align?: "left" | "right";
}

const COLUMN_DEFS: Record<ColumnKey, ColumnDef> = {
  channel: { key: "channel", label: "Channel", width: "84px", sortable: true },
  customer: { key: "customer", label: "Customer", width: "180px", sortable: true },
  type: { key: "type", label: "Type", width: "140px", sortable: true },
  latestUpdate: { key: "latestUpdate", label: "Latest Update", width: undefined, sortable: false },
  owner: { key: "owner", label: "Owner", width: "140px", sortable: true },
  timeLeft: { key: "timeLeft", label: "Time Left", width: "120px", sortable: true },
  created: { key: "created", label: "Created", width: "100px", sortable: true, align: "right" },
  status: { key: "status", label: "Status", width: "72px", sortable: false },
  orderId: { key: "orderId", label: "Order ID", width: "140px", sortable: true },
  ebayUsername: { key: "ebayUsername", label: "eBay Username", width: "140px", sortable: true },
};

const TYPE_BADGE_LABEL: Record<string, string> = {
  QUERY: "Query",
  PRE_SALES: "Pre-sales",
  RETURN_REQUEST: "Return",
  ITEM_NOT_RECEIVED: "INR Claim",
  NEGATIVE_FEEDBACK: "Neg. FB",
  REFUND: "Refund",
  SHIPPING_QUERY: "Shipping",
  CANCELLATION: "Cancel",
  SYSTEM: "System",
  OTHER: "Other",
};

const TYPE_BADGE_COLOR: Record<string, string> = {
  QUERY: "border-hairline text-muted-foreground",
  PRE_SALES: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  RETURN_REQUEST: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  ITEM_NOT_RECEIVED: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  NEGATIVE_FEEDBACK: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  REFUND: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  SHIPPING_QUERY: "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
  CANCELLATION: "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
  SYSTEM: "border-hairline text-muted-foreground",
  OTHER: "border-hairline text-muted-foreground",
};

const CHANNEL_BADGE: Record<string, string> = {
  TPP_EBAY: "TPP",
  TT_EBAY: "TT",
};

/**
 * Per-channel pill colors. We use Tailwind's stable semantic palette
 * (violet / emerald) instead of brand classes so the two eBay storefronts
 * are instantly distinguishable at a glance — agents who manage both kept
 * mistaking TT messages for TPP when both rendered with the same neutral
 * surface badge. Keep these classes literal so Tailwind's JIT picks them up.
 */
const CHANNEL_BADGE_CLS: Record<string, string> = {
  TPP_EBAY:
    "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  TT_EBAY:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

// ─── Time-Left logic ───────────────────────────────────────────────────────
//
// 24h SLA from first buyer message. Stops counting when an agent has replied
// (status moves to WAITING/RESOLVED). If buyer messages multiple times before
// any agent response, the clock keeps running from the FIRST buyer message —
// it does not reset.

interface TimeLeftResult {
  /** ms remaining (clamped >= 0). null = no SLA applies (resolved/waiting). */
  remainingMs: number | null;
  /**
   * 0..1 *remaining* fill — 1.0 = brand new (full bar), 0 = depleted/overdue
   * (empty bar). Used directly as the bar width.
   */
  pct: number;
  /** "23h", "12m", "Overdue 2h", or "—". */
  label: string;
}

const SLA_MS = 24 * 60 * 60 * 1000;

function computeTimeLeft(t: HelpdeskTicketSummary, now: number): TimeLeftResult {
  if (t.status === "RESOLVED" || t.status === "ARCHIVED" || t.status === "SPAM") {
    return { remainingMs: null, pct: 0, label: "—" };
  }
  // If we've replied at least once, the clock is paused until a new buyer msg.
  // Equivalent: lastAgentMessageAt > lastBuyerMessageAt.
  if (t.lastAgentMessageAt && t.lastBuyerMessageAt) {
    const a = new Date(t.lastAgentMessageAt).getTime();
    const b = new Date(t.lastBuyerMessageAt).getTime();
    if (a >= b) return { remainingMs: null, pct: 0, label: "—" };
  }
  const start = t.lastBuyerMessageAt
    ? new Date(t.lastBuyerMessageAt).getTime()
    : new Date(t.createdAt).getTime();
  const elapsed = now - start;
  const remaining = SLA_MS - elapsed;
  // pct = fraction REMAINING (1.0 = fresh, 0 = depleted).
  const pct = Math.max(0, Math.min(1, remaining / SLA_MS));
  if (remaining <= 0) {
    const overdueH = Math.floor(-remaining / 3_600_000);
    return {
      remainingMs: 0,
      pct: 0,
      label: overdueH > 0 ? `Overdue ${overdueH}h` : "Overdue",
    };
  }
  const remH = Math.floor(remaining / 3_600_000);
  if (remH >= 1) return { remainingMs: remaining, pct, label: `${remH}h` };
  const remM = Math.max(1, Math.floor(remaining / 60_000));
  return { remainingMs: remaining, pct, label: `${remM}m` };
}

// ─── Copy button ───────────────────────────────────────────────────────────

/**
 * Tiny inline copy-to-clipboard button. Used next to order numbers (and
 * other identifiers) in the table so an agent can grab the value without
 * opening the ticket. Stops click propagation so clicking it doesn't
 * also trigger row-select.
 */
function CopyInlineButton({
  value,
  label,
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );
  function onClick(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        // Clipboard blocked — silently fail; the value is visible inline.
      });
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
      title={copied ? "Copied!" : (label ?? `Copy ${value}`)}
      aria-label={label ?? `Copy ${value}`}
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-500" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

// ─── Column-width persistence (per agent, per browser via localStorage) ────

const COL_WIDTHS_STORAGE_KEY = "reorg.helpdesk.col-widths.v1";
const MIN_COL_PX = 60;
const MAX_COL_PX = 800;

function loadColumnWidths(): Partial<Record<ColumnKey, number>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(COL_WIDTHS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Partial<Record<ColumnKey, number>> = {};
    for (const k of KNOWN_COLUMN_KEYS) {
      const v = (parsed as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        out[k] = Math.max(MIN_COL_PX, Math.min(MAX_COL_PX, v));
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveColumnWidths(widths: Partial<Record<ColumnKey, number>>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COL_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Quota / disabled storage — fail silently.
  }
}

// ─── Format helpers ────────────────────────────────────────────────────────

function formatTime12h(date: string | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function previewLatest(t: HelpdeskTicketSummary): string {
  // Prefer the server-derived latest message preview (skips raw eBay digest
  // envelopes), then fall back to the subject / item title for tickets that
  // don't have an eligible message yet (eg. brand-new sync, or threads where
  // the only row is still an un-exploded envelope).
  return t.latestPreview ?? t.subject ?? t.ebayItemTitle ?? "(no subject)";
}

// ─── Sort logic (client-side stable sort over loaded page) ─────────────────

type SortKey = ColumnKey;
type SortDir = "asc" | "desc";

interface SortState {
  key: SortKey | null;
  dir: SortDir;
}

function compareTickets(
  a: HelpdeskTicketSummary,
  b: HelpdeskTicketSummary,
  key: SortKey,
  now: number,
): number {
  switch (key) {
    case "channel":
      return (CHANNEL_BADGE[a.channel] ?? a.channel).localeCompare(
        CHANNEL_BADGE[b.channel] ?? b.channel,
      );
    case "customer":
      return (a.buyerName ?? a.buyerUserId ?? "").localeCompare(
        b.buyerName ?? b.buyerUserId ?? "",
      );
    case "type":
      return a.type.localeCompare(b.type);
    case "owner":
      return (a.primaryAssignee?.name ?? "zzz").localeCompare(
        b.primaryAssignee?.name ?? "zzz",
      );
    case "timeLeft": {
      const ax = computeTimeLeft(a, now).remainingMs ?? Number.POSITIVE_INFINITY;
      const bx = computeTimeLeft(b, now).remainingMs ?? Number.POSITIVE_INFINITY;
      return ax - bx;
    }
    case "created":
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    case "orderId":
      return (a.ebayOrderNumber ?? "").localeCompare(b.ebayOrderNumber ?? "");
    case "ebayUsername":
      return (a.buyerUserId ?? "").localeCompare(b.buyerUserId ?? "");
    case "latestUpdate":
    case "status":
      return 0;
  }
}

// ─── Presence types (matches /api/helpdesk/presence response) ──────────────

interface PresenceUser {
  userId: string;
  isSelf: boolean;
  user: {
    id: string;
    name: string | null;
    avatarUrl: string | null;
    handle: string | null;
  };
}

type PresenceMap = Record<string, PresenceUser[]>;

// ─── Component ─────────────────────────────────────────────────────────────

interface TicketTableProps {
  tickets: HelpdeskTicketSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPrefetch?: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent, id: string) => void;

  // Selection / batch
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAllVisible: () => void;
  allVisibleSelected: boolean;
  showSelection: boolean;
}

export function TicketTable({
  tickets,
  selectedId,
  onSelect,
  onPrefetch,
  onContextMenu,
  selected,
  onToggle,
  onToggleAllVisible,
  allVisibleSelected,
  showSelection,
}: TicketTableProps) {
  // ── Column preferences ────────────────────────────────────────────────────
  const [columns, setColumns] = useState<ColumnKey[]>(DEFAULT_COLUMNS);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/helpdesk/column-prefs?layout=table", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j: { data?: { columns?: ColumnKey[] } }) => {
        if (cancelled) return;
        const cols = j.data?.columns;
        if (cols && cols.length > 0) setColumns(cols);
      })
      .catch(() => {
        // Defaults already applied — non-fatal.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveColumns = useCallback(async (next: ColumnKey[]) => {
    setColumns(next);
    try {
      await fetch("/api/helpdesk/column-prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layout: "table", columns: next }),
      });
    } catch {
      // Local state already updated; surfaced silently.
    }
  }, []);

  // ── Column widths (per agent, persisted via localStorage) ────────────────
  // We store overrides in a partial map keyed on column key. Any column
  // without an explicit width falls back to its default in COLUMN_DEFS.
  const [colWidths, setColWidths] = useState<Partial<Record<ColumnKey, number>>>(
    () => ({}),
  );
  useEffect(() => {
    setColWidths(loadColumnWidths());
  }, []);
  const updateColWidth = useCallback((key: ColumnKey, width: number) => {
    setColWidths((prev) => {
      const next = {
        ...prev,
        [key]: Math.max(MIN_COL_PX, Math.min(MAX_COL_PX, Math.round(width))),
      };
      saveColumnWidths(next);
      return next;
    });
  }, []);

  // ── Sort state ────────────────────────────────────────────────────────────
  const [sort, setSort] = useState<SortState>({ key: null, dir: "asc" });

  function toggleSort(key: ColumnKey) {
    if (!COLUMN_DEFS[key].sortable) return;
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return { key: null, dir: "asc" };
    });
  }

  // Tick every 60s so the time-left column re-renders. Cheap because each row
  // recomputes from cached fields, no network.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const visibleTickets = useMemo(() => {
    if (!sort.key) return tickets;
    const key = sort.key;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...tickets].sort((a, b) => dir * compareTickets(a, b, key, now));
  }, [tickets, sort, now]);

  // ── Presence polling (one bulk request every 8s) ──────────────────────────
  const [presence, setPresence] = useState<PresenceMap>({});
  const visibleIdsKey = useMemo(
    () => visibleTickets.map((t) => t.id).join(","),
    [visibleTickets],
  );

  useEffect(() => {
    if (!visibleIdsKey) {
      setPresence({});
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    async function tick() {
      try {
        const res = await fetch(
          `/api/helpdesk/presence?ticketIds=${encodeURIComponent(visibleIdsKey)}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`presence ${res.status}`);
        const j = (await res.json()) as { data?: PresenceMap };
        if (!cancelled) setPresence(j.data ?? {});
      } catch {
        if (!cancelled) setPresence({});
      }
    }
    void tick();
    timer = window.setInterval(tick, 8_000);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [visibleIdsKey]);

  // ── Render ────────────────────────────────────────────────────────────────
  const totalGridTemplate = useMemo(() => {
    const parts: string[] = [];
    if (showSelection) parts.push("36px"); // checkbox
    parts.push("28px"); // important flag column (always-on indicator slot)
    for (const k of columns) {
      const def = COLUMN_DEFS[k];
      const override = colWidths[k];
      if (typeof override === "number") {
        parts.push(`${override}px`);
      } else {
        parts.push(def.width ?? "minmax(200px, 1fr)");
      }
    }
    return parts.join(" ");
  }, [columns, showSelection, colWidths]);

  return (
    <div className="flex h-full flex-col">
      {/* Top bar: Edit Columns button. */}
      <div className="flex items-center justify-end gap-2 border-b border-hairline bg-card/50 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2 text-xs text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
          title="Reorder, show, or hide inbox columns"
        >
          <Settings2 className="h-3.5 w-3.5" />
          Edit Columns
        </button>
      </div>

      {/* Grid header */}
      <div
        className="sticky top-0 z-[2] grid items-center border-b border-hairline bg-card/95 px-2 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur"
        style={{ gridTemplateColumns: totalGridTemplate }}
      >
        {showSelection && (
          <div className="px-2">
            <button
              type="button"
              onClick={onToggleAllVisible}
              className="flex h-4 w-4 items-center justify-center rounded border border-hairline text-muted-foreground hover:text-foreground cursor-pointer"
              title={allVisibleSelected ? "Clear selection" : "Select all visible"}
            >
              {allVisibleSelected ? (
                <CheckSquare className="h-3 w-3" />
              ) : (
                <Square className="h-3 w-3" />
              )}
            </button>
          </div>
        )}
        <div /> {/* important flag spacer */}
        {columns.map((k) => {
          const def = COLUMN_DEFS[k];
          const isSorted = sort.key === k;
          return (
            <ColumnHeader
              key={k}
              columnKey={k}
              label={def.label}
              align={def.align}
              sortable={def.sortable}
              isSorted={isSorted}
              sortDir={sort.dir}
              onSort={() => toggleSort(k)}
              currentWidth={colWidths[k]}
              defaultWidth={def.width}
              onResize={(w) => updateColWidth(k, w)}
            />
          );
        })}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {visibleTickets.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
            <Inbox className="h-6 w-6 opacity-60" />
            <p className="text-sm">No tickets in view.</p>
          </div>
        ) : (
          visibleTickets.map((t) => (
            <TicketRow
              key={t.id}
              ticket={t}
              columns={columns}
              gridTemplate={totalGridTemplate}
              showSelection={showSelection}
              selected={selected.has(t.id)}
              isActive={selectedId === t.id}
              onToggleSelect={() => onToggle(t.id)}
              onSelect={() => onSelect(t.id)}
              onPrefetch={onPrefetch ? () => onPrefetch(t.id) : undefined}
              onContextMenu={onContextMenu}
              presenceUsers={presence[t.id] ?? []}
              now={now}
            />
          ))
        )}
      </div>

      {editOpen && (
        <EditColumnsDialog
          columns={columns}
          onSave={(next) => {
            void saveColumns(next);
            setEditOpen(false);
          }}
          onClose={() => setEditOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Column header (clickable label + drag-to-resize handle) ──────────────

interface ColumnHeaderProps {
  columnKey: ColumnKey;
  label: string;
  align?: "left" | "right";
  sortable: boolean;
  isSorted: boolean;
  sortDir: SortDir;
  onSort: () => void;
  currentWidth: number | undefined;
  defaultWidth: string | undefined;
  onResize: (newWidth: number) => void;
}

function ColumnHeader({
  columnKey,
  label,
  align,
  sortable,
  isSorted,
  sortDir,
  onSort,
  currentWidth,
  defaultWidth,
  onResize,
}: ColumnHeaderProps) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Snapshot starting width from the actual rendered cell so we resize
    // smoothly even when the column is currently using its default
    // (string) width like "84px" or "minmax(...)".
    const rect = headerRef.current?.getBoundingClientRect();
    const startWidth =
      typeof currentWidth === "number"
        ? currentWidth
        : rect
          ? rect.width
          : parsePxWidth(defaultWidth) ?? 160;
    dragStateRef.current = { startX: e.clientX, startWidth };

    function onMouseMove(ev: MouseEvent) {
      const ds = dragStateRef.current;
      if (!ds) return;
      const delta = ev.clientX - ds.startX;
      onResize(ds.startWidth + delta);
    }
    function onMouseUp() {
      dragStateRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  return (
    <div
      ref={headerRef}
      className="relative flex items-center"
      data-col={columnKey}
    >
      <button
        type="button"
        onClick={onSort}
        disabled={!sortable}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 px-2 text-left",
          align === "right" && "justify-end text-right",
          sortable
            ? "cursor-pointer hover:text-foreground"
            : "cursor-default",
          isSorted && "text-foreground",
        )}
        title={sortable ? `Sort by ${label}` : undefined}
      >
        <span className="truncate">{label}</span>
        {isSorted &&
          (sortDir === "asc" ? (
            <ArrowUpAZ className="h-3 w-3" />
          ) : (
            <ArrowDownAZ className="h-3 w-3" />
          ))}
      </button>
      {/* Resize handle — hugs the right edge, full row height. */}
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label} column`}
        onMouseDown={startResize}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          // Double-click resets to the column default. We mirror this by
          // sending a special width matching the default; if the default
          // is flex/auto, we fall back to a reasonable 200px so the
          // column doesn't collapse.
          e.stopPropagation();
          onResize(parsePxWidth(defaultWidth) ?? 200);
        }}
        className="absolute right-0 top-1/2 -translate-y-1/2 inline-block h-5 w-1.5 cursor-col-resize rounded-sm bg-transparent transition-colors hover:bg-brand/60"
        title="Drag to resize · double-click to reset"
      />
    </div>
  );
}

function parsePxWidth(width: string | undefined): number | null {
  if (!width) return null;
  const m = /^(\d+(?:\.\d+)?)px$/.exec(width.trim());
  if (!m) return null;
  return Number(m[1]);
}

// ─── Row ────────────────────────────────────────────────────────────────────

interface TicketRowProps {
  ticket: HelpdeskTicketSummary;
  columns: ColumnKey[];
  gridTemplate: string;
  showSelection: boolean;
  selected: boolean;
  isActive: boolean;
  onToggleSelect: () => void;
  onSelect: () => void;
  onPrefetch?: () => void;
  onContextMenu?: (e: React.MouseEvent, id: string) => void;
  presenceUsers: PresenceUser[];
  now: number;
}

function TicketRow({
  ticket: t,
  columns,
  gridTemplate,
  showSelection,
  selected,
  isActive,
  onToggleSelect,
  onSelect,
  onPrefetch,
  onContextMenu,
  presenceUsers,
  now,
}: TicketRowProps) {
  const isUnread = t.unreadCount > 0;
  const tl = useMemo(() => computeTimeLeft(t, now), [t, now]);

  // Filter out self from the list of "other agents viewing" — we don't want
  // an agent to see their own green eye on every row they're hovering.
  const otherViewers = presenceUsers.filter((p) => !p.isSelf);

  return (
    <div
      role="row"
      onClick={onSelect}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      onContextMenu={(e) => onContextMenu?.(e, t.id)}
      style={{ gridTemplateColumns: gridTemplate }}
      className={cn(
        "group grid cursor-pointer items-center border-b border-hairline px-2 py-4 text-[15px] transition-colors",
        isUnread
          ? "bg-brand/[0.04] text-foreground"
          : "bg-transparent text-muted-foreground",
        isActive && "!bg-brand-muted",
        "hover:bg-surface-2",
      )}
    >
      {showSelection && (
        <div
          className="px-2"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect();
          }}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={() => undefined}
            className="h-4 w-4 cursor-pointer accent-brand"
            aria-label="Select ticket"
          />
        </div>
      )}

      {/* Important flag — always rendered so the column doesn't reflow. */}
      <div className="flex justify-center">
        {t.isImportant && (
          <Flag
            className="h-4 w-4 fill-red-500 text-red-500"
            aria-label="Important"
          />
        )}
        {!t.isImportant && t.isFavorite && (
          <Star
            className="h-4 w-4 fill-amber-500 text-amber-500"
            aria-label="Favorite"
          />
        )}
      </div>

      {columns.map((k) => (
        <Cell
          key={k}
          column={k}
          ticket={t}
          isUnread={isUnread}
          timeLeft={tl}
          otherViewers={otherViewers}
        />
      ))}
    </div>
  );
}

// ─── Cell renderer ─────────────────────────────────────────────────────────

interface CellProps {
  column: ColumnKey;
  ticket: HelpdeskTicketSummary;
  isUnread: boolean;
  timeLeft: TimeLeftResult;
  otherViewers: PresenceUser[];
}

function Cell({ column, ticket: t, isUnread, timeLeft, otherViewers }: CellProps) {
  switch (column) {
    case "channel": {
      const label = CHANNEL_BADGE[t.channel] ?? t.channel;
      const pillCls =
        CHANNEL_BADGE_CLS[t.channel] ??
        "border-hairline bg-surface text-muted-foreground";
      const isEbay = t.channel === "TPP_EBAY" || t.channel === "TT_EBAY";
      return (
        <div className="flex items-center gap-2 px-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
              pillCls,
            )}
            title={isEbay ? `${label} · eBay` : label}
          >
            {isEbay && (
              // Real eBay 4-color glyph (lives in /public/logos). We use a
              // plain <img> because Next/Image isn't worth the wrapper for
              // a tiny static svg, and we want the brand colors preserved
              // so the icon reads as "eBay" instantly even when the
              // surrounding pill is tinted violet/emerald.
              <img
                src="/logos/ebay.svg"
                alt=""
                width={16}
                height={16}
                className="h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              />
            )}
            {label}
          </span>
        </div>
      );
    }

    case "customer": {
      // Customer column prefers the buyer's real first/last name. Pre-sales
      // inquiries (no order number) often don't carry a name on the eBay
      // envelope, so we fall back to the eBay username — that's still more
      // useful than a blank cell, and the eBay Username column will simply
      // mirror the same string in those cases. When the AR runs on a
      // post-sales ticket we update buyerName separately so the two
      // columns diverge naturally.
      const username = t.buyerUserId ?? null;
      const name = t.buyerName ?? null;
      const isJustUsername =
        !!name &&
        !!username &&
        name.toLowerCase() === username.toLowerCase();
      const realName = name && !isJustUsername ? name : null;
      const display = realName ?? username ?? "—";
      const tooltip = realName
        ? username
          ? `${realName} (${username})`
          : realName
        : username
          ? `No first/last name on file for ${username}`
          : "Unknown buyer";
      const copyValue = realName ?? username ?? "";
      return (
        <div className="flex min-w-0 items-center gap-1.5 px-2">
          {isUnread && (
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-brand"
            />
          )}
          <span
            className={cn(
              "min-w-0 truncate",
              isUnread ? "font-semibold text-foreground" : "font-normal",
              !realName && "text-muted-foreground",
            )}
            title={tooltip}
          >
            {display}
          </span>
          {copyValue ? (
            <CopyInlineButton
              value={copyValue}
              label={`Copy ${realName ? "name" : "username"} ${copyValue}`}
            />
          ) : null}
        </div>
      );
    }

    case "type": {
      const cls = TYPE_BADGE_COLOR[t.type] ?? TYPE_BADGE_COLOR.OTHER;
      // Surface archived state in search results — filtered tickets don't
      // appear in folder views, so the only place an agent sees them is
      // a global search hit. Showing the badge inline next to the type
      // prevents the "why is this ticket here?" confusion.
      return (
        <div className="flex items-center gap-1 px-2">
          <span
            className={cn(
              "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
              cls,
            )}
          >
            {TYPE_BADGE_LABEL[t.type] ?? "Query"}
          </span>
          {t.isArchived ? (
            <span
              className="inline-flex items-center rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:border-amber-400/40 dark:text-amber-300"
              title="This ticket is in the Archived folder. A buyer reply will bounce it back to To Do."
            >
              Archived
            </span>
          ) : null}
        </div>
      );
    }

    case "latestUpdate": {
      const text = previewLatest(t);
      return (
        <div className="min-w-0 px-2">
          <div className="flex min-w-0 items-center gap-2">
            {isUnread ? (
              // Purple unread indicator. Matches the WAITING chip palette
              // already established in TicketList so unread state reads as
              // "needs attention" without introducing a new hue. A plain
              // color dot would fail the "color alone isn't the signal"
              // rule, so the row's latest-update text also bolds/darkens
              // via isUnread above, and an sr-only label explains it to AT.
              <span
                className="inline-flex shrink-0 items-center justify-center"
                title="Unread"
                aria-hidden="true"
              >
                <span className="h-2 w-2 rounded-full bg-purple-500 shadow-[0_0_6px_rgba(168,85,247,0.6)] dark:bg-purple-400" />
              </span>
            ) : null}
            {isUnread ? <span className="sr-only">Unread message.</span> : null}
            <p
              className={cn(
                "min-w-0 flex-1 truncate",
                isUnread ? "text-foreground" : "text-muted-foreground",
              )}
              title={text}
            >
              {text}
            </p>
          </div>
        </div>
      );
    }

    case "owner":
      return (
        <div className="px-2">
          {t.primaryAssignee ? (
            <div className="flex min-w-0 items-center gap-2">
              <Avatar user={t.primaryAssignee} size="sm" />
              <span className="truncate text-sm text-muted-foreground">
                {t.primaryAssignee.name?.split(" ")[0] ??
                  t.primaryAssignee.handle ??
                  "—"}
              </span>
            </div>
          ) : (
            <span className="text-sm text-muted-foreground/60">Unassigned</span>
          )}
        </div>
      );

    case "timeLeft":
      return (
        <div className="px-2">
          {timeLeft.remainingMs === null ? (
            <span className="text-sm text-muted-foreground/60">{timeLeft.label}</span>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span
                className={cn(
                  "text-sm tabular-nums",
                  // Color the label by URGENCY of remaining time:
                  //   pct === 0  → overdue (red, bold)
                  //   pct ≤ 0.25 → almost depleted (red)
                  //   pct ≤ 0.5  → halfway (amber)
                  //   pct  > 0.5 → healthy (green-ish, muted)
                  timeLeft.pct === 0
                    ? "font-semibold text-red-600 dark:text-red-300"
                    : timeLeft.pct <= 0.25
                      ? "font-semibold text-red-600 dark:text-red-300"
                      : timeLeft.pct <= 0.5
                        ? "font-semibold text-amber-600 dark:text-amber-300"
                        : "text-muted-foreground",
                )}
              >
                {timeLeft.label}
              </span>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    // Bar fill represents REMAINING time:
                    //   > 0.5 → green (lots of time)
                    //   0.25..0.5 → amber (halfway)
                    //   ≤ 0.25 → red (almost out)
                    //   0 → red (overdue, but bar is empty so color barely matters)
                    timeLeft.pct > 0.5
                      ? "bg-emerald-500"
                      : timeLeft.pct > 0.25
                        ? "bg-amber-500"
                        : "bg-red-500",
                  )}
                  style={{ width: `${Math.round(timeLeft.pct * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      );

    case "created":
      return (
        <div
          className={cn(
            "px-2 text-right tabular-nums text-sm",
            isUnread ? "text-foreground" : "text-muted-foreground",
          )}
          title={new Date(t.createdAt).toLocaleString()}
        >
          {formatTime12h(t.createdAt)}
        </div>
      );

    case "status": {
      const watchedByOthers = otherViewers.length > 0;
      const tooltip = watchedByOthers
        ? `Currently being viewed by ${otherViewers
            .map((v) => v.user.name ?? v.user.handle ?? "another agent")
            .join(", ")}`
        : "Inbox";
      return (
        <div
          className="flex items-center justify-center px-2"
          title={tooltip}
        >
          {watchedByOthers ? (
            <Eye className="h-[18px] w-[18px] text-emerald-500" aria-label={tooltip} />
          ) : (
            <Mail
              className="h-[18px] w-[18px] text-muted-foreground/70"
              aria-label="Inbox"
            />
          )}
        </div>
      );
    }

    case "orderId":
      return (
        <div className="flex min-w-0 items-center gap-1.5 px-2">
          {t.ebayOrderNumber ? (
            <>
              <span
                className="min-w-0 truncate font-mono text-sm text-foreground"
                title={t.ebayOrderNumber}
              >
                {t.ebayOrderNumber}
              </span>
              <CopyInlineButton
                value={t.ebayOrderNumber}
                label={`Copy order ${t.ebayOrderNumber}`}
              />
            </>
          ) : (
            // No order number means this came in before any sale (pre-sales
            // inquiry). The blank em-dash was confusing, so we surface a
            // clear "PRE SALES" pill instead — matches the PRE_SALES type
            // badge color so agents can spot it at a glance.
            <span
              className="inline-flex items-center rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-300"
              title="No order number — buyer messaged before purchase"
            >
              Pre Sales
            </span>
          )}
        </div>
      );

    case "ebayUsername":
      return (
        <div className="flex min-w-0 items-center gap-1.5 px-2">
          {t.buyerUserId ? (
            <>
              <span
                className="min-w-0 truncate text-sm text-muted-foreground"
                title={t.buyerUserId}
              >
                {t.buyerUserId}
              </span>
              <CopyInlineButton
                value={t.buyerUserId}
                label={`Copy username ${t.buyerUserId}`}
              />
            </>
          ) : (
            <span className="text-sm text-muted-foreground/60">—</span>
          )}
        </div>
      );
  }
}

// ─── Edit Columns dialog (drag-to-reorder + show/hide) ─────────────────────

function EditColumnsDialog({
  columns,
  onSave,
  onClose,
}: {
  columns: ColumnKey[];
  onSave: (next: ColumnKey[]) => void;
  onClose: () => void;
}) {
  // Local working copy: visible (in order) + hidden (everything else).
  const [visible, setVisible] = useState<ColumnKey[]>(columns);
  const [dragKey, setDragKey] = useState<ColumnKey | null>(null);
  const [dragOverKey, setDragOverKey] = useState<ColumnKey | null>(null);

  const hidden = useMemo(
    () => DEFAULT_COLUMNS.filter((k) => !visible.includes(k)),
    [visible],
  );

  function toggleVisible(k: ColumnKey) {
    setVisible((prev) => {
      if (prev.includes(k)) {
        if (prev.length === 1) return prev; // must keep at least one
        return prev.filter((x) => x !== k);
      }
      return [...prev, k];
    });
  }

  function handleDrop(target: ColumnKey) {
    if (!dragKey || dragKey === target) {
      setDragKey(null);
      setDragOverKey(null);
      return;
    }
    setVisible((prev) => {
      const next = prev.filter((k) => k !== dragKey);
      const idx = next.indexOf(target);
      if (idx === -1) return [dragKey, ...next];
      next.splice(idx, 0, dragKey);
      return next;
    });
    setDragKey(null);
    setDragOverKey(null);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-hairline bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">
            Edit columns
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4 p-4">
          {/* Visible (sortable) */}
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Visible · drag to reorder
            </p>
            <ul className="flex flex-col gap-1">
              {visible.map((k) => {
                const def = COLUMN_DEFS[k];
                return (
                  <li
                    key={k}
                    draggable
                    onDragStart={() => setDragKey(k)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverKey(k);
                    }}
                    onDragLeave={() =>
                      setDragOverKey((cur) => (cur === k ? null : cur))
                    }
                    onDrop={() => handleDrop(k)}
                    onDragEnd={() => {
                      setDragKey(null);
                      setDragOverKey(null);
                    }}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-md border border-hairline bg-surface px-2 py-1.5 text-xs text-foreground cursor-grab",
                      dragKey === k && "opacity-40",
                      dragOverKey === k &&
                        dragKey &&
                        dragKey !== k &&
                        "border-brand bg-brand/5",
                    )}
                    style={
                      {
                        userSelect: "none",
                      } as CSSProperties
                    }
                  >
                    <span className="flex items-center gap-2">
                      <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
                      {def.label}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleVisible(k)}
                      disabled={visible.length === 1}
                      className="rounded px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                    >
                      Hide
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Hidden */}
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Hidden
            </p>
            {hidden.length === 0 ? (
              <p className="text-xs text-muted-foreground/60">
                All columns visible.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {hidden.map((k) => (
                  <li
                    key={k}
                    className="flex items-center justify-between gap-2 rounded-md border border-dashed border-hairline px-2 py-1.5 text-xs text-muted-foreground"
                  >
                    {COLUMN_DEFS[k].label}
                    <button
                      type="button"
                      onClick={() => toggleVisible(k)}
                      className="rounded px-1.5 py-0.5 text-[10px] uppercase text-brand transition-colors hover:bg-brand/10 cursor-pointer"
                    >
                      Show
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-hairline px-4 py-3">
          <button
            type="button"
            onClick={() => setVisible(DEFAULT_COLUMNS)}
            className="rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
          >
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-2 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(visible)}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground transition-opacity hover:opacity-90 cursor-pointer"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
