"use client";

/**
 * Return Cases list (/help-desk/returns).
 *
 * Mirrors eBay Seller Hub → Manage returns, re-skinned as a reorG dark
 * operational dashboard. Combines TPP + TT in one table with store badges and
 * a store filter, plus the eBay status buckets, date range, search, and sort.
 *
 * The list reads ONLY from our local cache (pull-only sync). A manual "Sync
 * now" button triggers the read-only sync worker. There are NO write actions
 * on this page — every action lives on the detail page behind the safety gate.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  RefreshCw,
  Loader2,
  Search,
  ShieldAlert,
  PackageOpen,
  AlertTriangle,
  ChevronRight,
  Lock,
  Unlock,
  X,
} from "lucide-react";
import {
  StoreBadge,
  fmtDate,
  fmtAgo,
  fmtMoney,
  humanizeReason,
  reasonDefectAssociation,
  type ReturnLifecycle,
} from "./returns-ui";

const LIST_STATUS_TONE: Record<string, string> = {
  attention: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  progress: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
  shipped: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-300",
  delivered: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  closed: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
};

interface ReturnRow {
  id: string;
  returnId: string;
  platform: string;
  ebayOrderNumber: string | null;
  itemTitle: string | null;
  imageUrl: string | null;
  buyerUserId: string | null;
  returnState: string | null;
  lifecycle: ReturnLifecycle;
  isClosed: boolean;
  statusDescriptor: { label: string; tone: "attention" | "progress" | "shipped" | "delivered" | "closed" };
  sellerActionDue: boolean;
  reason: string | null;
  reasonType: string | null;
  sellerRefundValue: number | null;
  sellerRefundCurrency: string | null;
  refundIsActual: boolean;
  sellerResponseDueAt: string | null;
  openedAt: string;
  lastSyncedAt: string;
  ticketId: string | null;
}

interface StatusFilter {
  key: string;
  label: string;
}

interface ListResponse {
  items: ReturnRow[];
  total: number;
  page: number;
  pageSize: number;
  needsAttention: number;
  needsAttentionByStore?: Record<string, number>;
  filters: StatusFilter[];
}

const STORE_OPTIONS = [
  { key: "", label: "All stores" },
  { key: "TPP_EBAY", label: "TPP eBay" },
  { key: "TT_EBAY", label: "TT eBay" },
];

const STORE_LABELS: Record<string, string> = {
  TPP_EBAY: "TPP eBay",
  TT_EBAY: "TT eBay",
};

const SORT_OPTIONS = [
  { key: "opened_desc", label: "Date requested (newest)" },
  { key: "opened_asc", label: "Date requested (oldest)" },
  { key: "deadline_asc", label: "Respond-by deadline" },
];

// eBay-style relative date ranges. Value = lookback days ("" = all). The sync
// mirrors ~90 days, so "Last 90 days" is effectively "everything we hold".
const DATE_RANGE_OPTIONS = [
  { key: "1", label: "Last 24 hours" },
  { key: "7", label: "Last 7 days" },
  { key: "30", label: "Last 30 days" },
  { key: "60", label: "Last 60 days" },
  { key: "90", label: "Last 90 days" },
  { key: "", label: "All time" },
];

const FILTERS_STORAGE_KEY = "reorg.returns.filters.v1";

type PersistedFilters = {
  store: string;
  status: string;
  search: string;
  searchAllStatuses: boolean;
  sort: string;
  dateRange: string;
  page: number;
};

function readPersistedFilters(): Partial<PersistedFilters> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedFilters>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export default function ReturnsListClient() {
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ListResponse | null>(null);

  // Lazy-init from sessionStorage so the chosen status/store/search/sort survives
  // navigating into a return and back (Back to return cases).
  const initialFilters = useRef<Partial<PersistedFilters>>(readPersistedFilters());
  const [store, setStore] = useState(initialFilters.current.store ?? "");
  const [status, setStatus] = useState(initialFilters.current.status ?? "open_all");
  const [search, setSearch] = useState(initialFilters.current.search ?? "");
  const [searchInput, setSearchInput] = useState(initialFilters.current.search ?? "");
  const [searchAllStatuses, setSearchAllStatuses] = useState(
    initialFilters.current.searchAllStatuses ?? false,
  );
  const [sort, setSort] = useState(initialFilters.current.sort ?? "opened_desc");
  const [dateRange, setDateRange] = useState(initialFilters.current.dateRange ?? "90");
  const [page, setPage] = useState(initialFilters.current.page ?? 1);

  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);

  // Live-write toggle (returns_live_writes). Default LOCKED.
  const [liveWrites, setLiveWrites] = useState<boolean | null>(null);
  const [liveToggling, setLiveToggling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (store) qs.set("store", store);
      // "Search across all statuses" sends the special "all" bucket so the
      // query ignores the selected status filter entirely.
      const effectiveStatus = searchAllStatuses ? "all" : status;
      if (effectiveStatus) qs.set("status", effectiveStatus);
      if (search) qs.set("q", search);
      if (sort) qs.set("sort", sort);
      if (dateRange) {
        const fromIso = new Date(
          Date.now() - Number(dateRange) * 86_400_000,
        ).toISOString();
        qs.set("from", fromIso);
      }
      qs.set("page", String(page));
      qs.set("pageSize", "50");
      const res = await fetch(`/api/helpdesk/returns?${qs.toString()}`, {
        cache: "no-store",
      });
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const json = (await res.json()) as { data: ListResponse };
      setData(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load returns.");
    } finally {
      setLoading(false);
    }
  }, [store, status, searchAllStatuses, search, sort, dateRange, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // Persist the active filters so they survive navigating into a return detail
  // page and back.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const payload: PersistedFilters = {
        store,
        status,
        search,
        searchAllStatuses,
        sort,
        dateRange,
        page,
      };
      window.sessionStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* sessionStorage unavailable — non-fatal */
    }
  }, [store, status, searchAllStatuses, search, sort, dateRange, page]);

  // Keep a stable handle to the latest loader so the auto-sync interval can
  // refresh the list (with whatever filters are active) without re-subscribing
  // every time a filter changes.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  // Load live-write setting once.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings?key=returns_live_writes", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled) return;
        setLiveWrites(Boolean(json?.data ?? false));
      })
      .catch(() => {
        if (!cancelled) setLiveWrites(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onToggleLiveWrites() {
    if (liveWrites === null) return;
    setLiveToggling(true);
    try {
      const newVal = !liveWrites;
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "returns_live_writes", value: newVal }),
      });
      if (res.ok) setLiveWrites(newVal);
    } catch {
      /* best-effort */
    } finally {
      setLiveToggling(false);
    }
  }

  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/helpdesk/returns/sync", { method: "POST" });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        summaries?: { upserted: number; errors: string[] }[];
        error?: string;
      } | null;
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error ?? `Sync failed (${res.status})`);
      }
      const summaries = json?.summaries ?? [];
      const upserted = summaries.reduce((acc, s) => acc + (s.upserted ?? 0), 0);
      const errs = summaries.flatMap((s) => s.errors ?? []);
      setLastSyncAt(new Date());
      setSyncMsg(
        errs.length > 0
          ? `Synced ${upserted} return(s); ${errs.length} issue(s): ${errs.join("; ")}`
          : null,
      );
      await loadRef.current();
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, []);

  // Auto-sync: run once on mount ("right away"), then every 15 minutes while
  // the page is open. A server cron also runs every 15 min so the mirror stays
  // fresh even when nobody has this page open. Sync is idempotent (upsert on
  // returnId), so overlap with the cron is harmless. runSync is stable (it
  // reads the latest loader via loadRef), so filter changes never re-trigger
  // a full eBay sync.
  useEffect(() => {
    void runSync();
    const id = setInterval(() => void runSync(), 15 * 60 * 1000);
    return () => clearInterval(id);
  }, [runSync]);

  function applySearch() {
    setPage(1);
    setSearch(searchInput.trim());
  }

  function clearSearch() {
    setSearchInput("");
    setPage(1);
    setSearch("");
  }

  if (forbidden) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-12">
        <div className="rounded-xl border border-hairline bg-card p-6 text-center">
          <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-amber-500" />
          <h1 className="text-lg font-semibold text-foreground">Admins only</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Return Cases is restricted to Admin users in v1.
          </p>
          <Link
            href="/help-desk"
            className="mt-4 inline-flex items-center gap-2 rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-foreground hover:bg-surface-2 cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Help Desk
          </Link>
        </div>
      </div>
    );
  }

  const filters = data?.filters ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/help-desk"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Help Desk
        </Link>
        <div
          className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs font-medium text-muted-foreground"
          title="Returns sync runs automatically every 15 minutes (and on a server cron even when this page is closed)."
        >
          {syncing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5 text-emerald-500" />
          )}
          {syncing
            ? "Syncing…"
            : lastSyncAt
              ? `Auto-sync · synced ${fmtAgo(lastSyncAt.toISOString())}`
              : "Auto-syncs every 15 min"}
        </div>
      </div>

      <header className="mb-5 flex items-start gap-3">
        <div className="rounded-lg bg-orange-500/15 p-2">
          <PackageOpen className="h-5 w-5 text-orange-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-foreground">
              Return Cases
            </h1>
            {data && data.needsAttention > 0 ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-orange-500/15 px-2 py-0.5 text-xs font-semibold text-orange-600 dark:text-orange-300"
                title="Open return cases where eBay is waiting on you — accept/decline a request, provide a label, or issue a refund."
              >
                <AlertTriangle className="h-3 w-3" />
                {data.needsAttention} awaiting your action
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            eBay return requests across TPP and TT. Read-only mirror — every
            seller action runs through a preview + confirmation behind the
            returns write lock.
          </p>
          {data && data.needsAttention > 0 && data.needsAttentionByStore ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {data.needsAttention} awaiting your action
              </span>{" "}
              = open cases needing a seller decision (accept/decline, provide a
              label, or refund) —{" "}
              {Object.entries(data.needsAttentionByStore)
                .map(([k, v]) => `${STORE_LABELS[k] ?? k} ${v}`)
                .join(" · ")}
            </p>
          ) : null}
        </div>
        {/* Live-write lock control */}
        <button
          type="button"
          onClick={onToggleLiveWrites}
          disabled={liveToggling || liveWrites === null}
          title="When OFF, all live eBay return writes are blocked (preview still works). Default OFF."
          className={
            "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer " +
            (liveWrites
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/25"
              : "bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25")
          }
        >
          {liveToggling ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : liveWrites ? (
            <Unlock className="h-3.5 w-3.5" />
          ) : (
            <Lock className="h-3.5 w-3.5" />
          )}
          Live writes {liveWrites ? "ON" : "LOCKED"}
        </button>
      </header>

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-brand/20 bg-gradient-to-r from-brand/[0.06] to-transparent p-3">
        <Field label="Status" tone="text-brand">
          <select
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value);
            }}
            className="h-9 rounded-md border border-hairline bg-surface px-2 text-sm text-foreground cursor-pointer"
          >
            {filters.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Store" tone="text-violet-400">
          <select
            value={store}
            onChange={(e) => {
              setPage(1);
              setStore(e.target.value);
            }}
            className="h-9 rounded-md border border-hairline bg-surface px-2 text-sm text-foreground cursor-pointer"
          >
            {STORE_OPTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date range" tone="text-sky-400">
          <select
            value={dateRange}
            onChange={(e) => {
              setPage(1);
              setDateRange(e.target.value);
            }}
            className="h-9 rounded-md border border-hairline bg-surface px-2 text-sm text-foreground cursor-pointer"
          >
            {DATE_RANGE_OPTIONS.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sort" tone="text-indigo-400">
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="h-9 rounded-md border border-hairline bg-surface px-2 text-sm text-foreground cursor-pointer"
          >
            {SORT_OPTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/* Search — own full-width row below the filters */}
      <div className="mb-4 rounded-xl border border-brand/20 bg-gradient-to-r from-brand/[0.06] to-transparent p-3">
        <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-brand">
          Search (Return ID, order number, buyer, item title)
        </span>
        {/* Single bordered container so the search button never overlaps the
            field's border. The whole control gets one ring on focus. */}
        <div className="flex w-full overflow-hidden rounded-md border border-hairline bg-surface focus-within:ring-2 focus-within:ring-brand/40">
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applySearch();
              if (e.key === "Escape" && searchInput) clearSearch();
            }}
            placeholder="Search returns…"
            className="h-9 w-full min-w-0 flex-1 border-0 bg-transparent px-3 text-sm text-foreground outline-none"
          />
          {searchInput ? (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="Clear search"
              title="Clear search"
              className="inline-flex h-9 shrink-0 items-center px-2 text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={applySearch}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 border-l border-hairline bg-surface-2 px-4 text-sm font-medium text-foreground hover:bg-surface cursor-pointer"
          >
            <Search className="h-4 w-4" />
            Search
          </button>
        </div>
        {/* When checked, the search spans every status bucket instead of just
            the selected status filter. */}
        <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={searchAllStatuses}
            onChange={(e) => {
              setSearchAllStatuses(e.target.checked);
              setPage(1);
            }}
            className="h-3.5 w-3.5 cursor-pointer accent-brand"
          />
          <span>
            Search across <span className="font-medium text-foreground">all statuses</span>{" "}
            (ignore the status filter above)
          </span>
        </label>
      </div>

      {syncMsg ? (
        <p className="mb-3 text-xs text-muted-foreground">{syncMsg}</p>
      ) : null}

      {/* Results summary — reflects the active status filter + page window. */}
      {data && !loading && !error ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {searchAllStatuses
              ? "All statuses"
              : filters.find((f) => f.key === status)?.label ?? "All returns"}
          </span>
          <span>
            {total === 0
              ? "No results"
              : `Results ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
          </span>
        </div>
      ) : null}

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-hairline bg-card">
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 border-b border-brand/20 bg-brand/[0.06] px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-brand/80">
          <span>Item</span>
          <span className="w-48">Return Reason</span>
          <span className="w-44">Status</span>
          <span className="w-28 text-right">Refund</span>
          <span className="w-52">Buyer</span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="px-4 py-10 text-center text-sm text-red-600 dark:text-red-300">
            {error}
          </div>
        ) : !data || data.items.length === 0 ? (
          <div className="px-4 py-16 text-center">
            <PackageOpen className="mx-auto mb-2 h-7 w-7 text-muted-foreground/60" />
            <p className="text-sm text-muted-foreground">
              No returns match these filters.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-hairline">
            {data.items.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/help-desk/returns/${encodeURIComponent(r.returnId)}`}
                  className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-2 cursor-pointer"
                >
                  {/* Item cell */}
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md border border-hairline bg-surface">
                      {r.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={r.imageUrl}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center">
                          <PackageOpen className="h-4 w-4 text-muted-foreground/50" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <StoreBadge platform={r.platform} />
                        {r.sellerActionDue ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-orange-600 dark:text-orange-300">
                            <AlertTriangle className="h-2.5 w-2.5" /> Action
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-sm font-medium text-foreground">
                        {r.itemTitle ?? "(no title)"}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        Return {r.returnId}
                        {r.ebayOrderNumber ? ` · Order ${r.ebayOrderNumber}` : ""}
                        {" · "}
                        {fmtDate(r.openedAt)}
                      </p>
                    </div>
                  </div>

                  {/* Return Reason cell */}
                  <div className="w-48">
                    {r.reason ? (
                      <>
                        <p className="text-xs font-medium text-foreground">
                          {humanizeReason(r.reason)}
                        </p>
                        {(() => {
                          const defect = reasonDefectAssociation(r.reason, r.reasonType);
                          if (defect === null) return null;
                          return (
                            <span
                              className={
                                "mt-0.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold " +
                                (defect
                                  ? "bg-red-500/15 text-red-600 dark:text-red-300"
                                  : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300")
                              }
                            >
                              {defect ? "Defect Associated" : "No Defect Associated"}
                            </span>
                          );
                        })()}
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>

                  {/* Status cell — clear, eBay-style label */}
                  <div className="w-44">
                    <span
                      className={
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold " +
                        LIST_STATUS_TONE[r.statusDescriptor.tone]
                      }
                    >
                      {r.statusDescriptor.label}
                    </span>
                    {r.sellerResponseDueAt && !r.isClosed ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Respond by {fmtDate(r.sellerResponseDueAt)}
                      </p>
                    ) : null}
                  </div>

                  {/* Refund cell */}
                  <div className="w-28 text-right">
                    <p className="text-sm font-medium text-foreground">
                      {fmtMoney(r.sellerRefundValue, r.sellerRefundCurrency)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {r.sellerRefundValue == null
                        ? ""
                        : r.refundIsActual
                          ? "refunded"
                          : "estimated"}
                    </p>
                  </div>

                  {/* Buyer cell */}
                  <div className="flex w-52 items-center justify-between gap-2">
                    <span
                      title={r.buyerUserId ?? undefined}
                      className="min-w-0 break-words text-xs text-muted-foreground"
                    >
                      {r.buyerUserId ?? "—"}
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Pagination */}
      {data && total > pageSize ? (
        <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of{" "}
            {total}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-md border border-hairline bg-surface px-2.5 py-1 disabled:opacity-40 cursor-pointer"
            >
              Prev
            </button>
            <span>
              Page {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded-md border border-hairline bg-surface px-2.5 py-1 disabled:opacity-40 cursor-pointer"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      {data && data.items.length > 0 ? (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Mirror freshness: last synced {fmtAgo(data.items[0]?.lastSyncedAt)}.
        </p>
      ) : null}
    </div>
  );
}

function Field({
  label,
  children,
  tone = "text-muted-foreground",
}: {
  label: string;
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span
        className={"text-[10px] font-medium uppercase tracking-wider " + tone}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
