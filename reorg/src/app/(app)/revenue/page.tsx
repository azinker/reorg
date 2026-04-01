"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CalendarRange, Loader2, RefreshCw } from "lucide-react";
import type { Platform } from "@/lib/grid-types";
import { PLATFORM_FULL } from "@/lib/grid-types";
import type {
  RevenueDebugData,
  RevenueKpiMetric,
  RevenuePageData,
  RevenueRangePreset,
  RevenueStatusData,
  RevenueSyncJobSummary,
  RevenueSyncResult,
  RevenueSimpleWindow,
  RevenueTopBuyerRow,
  RevenueTopItemRow,
  RevenueTopTablesData,
} from "@/lib/revenue";
import {
  fetchRevenueJson,
  isAbortError,
  RevenueRequestTimeoutError,
} from "@/lib/revenue-client";
import { PlatformIcon } from "@/components/grid/platform-icon";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";

const PIE_COLORS = ["#8b5cf6", "#22c55e", "#f59e0b", "#38bdf8"];
const REVENUE_ANALYTICS_LOAD_TIMEOUT_MS = 120_000;
const REVENUE_STATUS_TIMEOUT_MS = 10_000;
const REVENUE_SYNC_REQUEST_TIMEOUT_MS = 15_000;
const REVENUE_SYNC_POLL_INTERVAL_MS = 8_000;
const REVENUE_TOP_TABLES_TIMEOUT_MS = 90_000;

function logRevenueClient(event: string, payload?: Record<string, unknown>) {
  console.info("[revenue]", {
    event,
    at: new Date().toISOString(),
    ...(payload ?? {}),
  });
}

function formatCurrency(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCurrencyCompact(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatPlainPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function formatMarketplaceBubbleLabel(platform: Platform) {
  if (platform === "TPP_EBAY") return "eBay TPP";
  if (platform === "TT_EBAY") return "eBay TT";
  if (platform === "BIGCOMMERCE") return "BigCommerce BC";
  return "Shopify SHPFY";
}

function marketplaceCountClassName(platform: Platform) {
  if (platform === "TPP_EBAY") return "text-violet-300";
  if (platform === "TT_EBAY") return "text-sky-300";
  if (platform === "BIGCOMMERCE") return "text-amber-300";
  return "text-emerald-300";
}

function deriveVisibleTopBuyerRows(rows: RevenueTopBuyerRow[], selectedPlatforms: Platform[]) {
  return rows
    .map((row) => {
      const platformBreakdown =
        selectedPlatforms.length > 0
          ? row.platformBreakdown.filter((entry) => selectedPlatforms.includes(entry.platform))
          : row.platformBreakdown;
      if (platformBreakdown.length === 0) return null;

      return {
        ...row,
        platforms: platformBreakdown.map((entry) => entry.platform),
        platformBreakdown,
        orderCount: platformBreakdown.reduce((sum, entry) => sum + entry.orderCount, 0),
        grossRevenue: platformBreakdown.reduce((sum, entry) => sum + entry.grossRevenue, 0),
        netRevenue: platformBreakdown.some((entry) => entry.netRevenue == null)
          ? null
          : platformBreakdown.reduce((sum, entry) => sum + (entry.netRevenue ?? 0), 0),
      };
    })
    .filter((row): row is RevenueTopBuyerRow => row != null)
    .sort((a, b) => b.orderCount - a.orderCount || b.grossRevenue - a.grossRevenue)
    .slice(0, 12);
}

function deriveVisibleTopItemRows(rows: RevenueTopItemRow[], selectedPlatforms: Platform[]) {
  return rows
    .map((row) => {
      const platformBreakdown =
        selectedPlatforms.length > 0
          ? row.platformBreakdown.filter((entry) => selectedPlatforms.includes(entry.platform))
          : row.platformBreakdown;
      if (platformBreakdown.length === 0) return null;

      return {
        ...row,
        platforms: platformBreakdown.map((entry) => entry.platform),
        platformBreakdown,
        unitsSold: platformBreakdown.reduce((sum, entry) => sum + entry.unitsSold, 0),
        grossRevenue: platformBreakdown.reduce((sum, entry) => sum + entry.grossRevenue, 0),
        netRevenue: platformBreakdown.some((entry) => entry.netRevenue == null)
          ? null
          : platformBreakdown.reduce((sum, entry) => sum + (entry.netRevenue ?? 0), 0),
      };
    })
    .filter((row): row is RevenueTopItemRow => row != null)
    .sort((a, b) => b.unitsSold - a.unitsSold || b.grossRevenue - a.grossRevenue)
    .slice(0, 12);
}

function formatDateTime(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toDateInputValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function rangeFromPreset(preset: RevenueRangePreset) {
  const to = new Date();
  const from = new Date(to);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (preset === "90d" ? 89 : preset === "365d" ? 364 : 29));
  return {
    from: toDateInputValue(from),
    to: toDateInputValue(to),
  };
}

function getRevenueJobProgress(job: RevenueSyncJobSummary) {
  if (job.status === "COMPLETED" || job.status === "FAILED") return 1;
  if (job.status === "PENDING") return 0.05;
  if (job.syncStages.length === 0) return 0.5;

  const completedStages = job.syncStages.filter((stage) => stage.status === "COMPLETED").length;
  const runningStages = job.syncStages.filter((stage) => stage.status === "RUNNING").length;
  const stageProgress = completedStages / job.syncStages.length;
  return Math.min(0.92, 0.12 + stageProgress * 0.76 + (runningStages > 0 ? 0.08 : 0));
}

function KpiCard(props: { label: string; metric: RevenueKpiMetric; detail?: string | null }) {
  const { label, metric, detail } = props;
  const isCountMetric = label === "Orders" || label === "Unique Buyers" || label === "Units Sold";
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-foreground">
        {isCountMetric ? (metric.value ?? 0).toLocaleString() : formatCurrency(metric.value)}
      </p>
      <p className="mt-3 text-sm text-muted-foreground">
        {metric.deltaPercent == null ? "No prior comparison" : `${formatPercent(metric.deltaPercent)} vs prior period`}
      </p>
      {detail ? (
        <p className="mt-2 text-xs text-sky-200">{detail}</p>
      ) : null}
    </div>
  );
}

export default function RevenuePage() {
  const defaultRange = useMemo(() => rangeFromPreset("30d"), []);
  const [preset, setPreset] = useState<RevenueRangePreset>("30d");
  const [customFrom, setCustomFrom] = useState(defaultRange.from);
  const [customTo, setCustomTo] = useState(defaultRange.to);
  const [granularity, setGranularity] = useState<"day" | "week">("day");
  const [buyerWindow, setBuyerWindow] = useState<RevenueSimpleWindow>("30d");
  const [itemWindow, setItemWindow] = useState<RevenueSimpleWindow>("30d");
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>([]);
  const [topBuyerPlatforms, setTopBuyerPlatforms] = useState<Platform[]>([]);
  const [topItemPlatforms, setTopItemPlatforms] = useState<Platform[]>([]);
  const [data, setData] = useState<RevenuePageData | null>(null);
  const [topTables, setTopTables] = useState<RevenueTopTablesData | null>(null);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [statusData, setStatusData] = useState<RevenueStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [watchingRefresh, setWatchingRefresh] = useState(false);
  const [error, setError] = useState("");
  const [banner, setBanner] = useState<string>("");
  const requestIdRef = useRef(0);
  const tablesRequestIdRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const completedRefreshLoadRef = useRef<string | null>(null);

  const queryRange = useMemo(() => {
    const fallback = rangeFromPreset(preset === "custom" ? "30d" : preset);
    const fromDate = new Date(`${(preset === "custom" ? customFrom : fallback.from) || fallback.from}T00:00:00`);
    const toDate = new Date(`${(preset === "custom" ? customTo : fallback.to) || fallback.to}T23:59:59`);
    return { fromDate, toDate };
  }, [customFrom, customTo, preset]);

  const selectedPlatformParam = useMemo(
    () => (selectedPlatforms.length > 0 ? selectedPlatforms.join(",") : ""),
    [selectedPlatforms],
  );

  const revenueDebugUrl = useMemo(
    () => `/api/revenue/debug${selectedPlatformParam ? `?platforms=${encodeURIComponent(selectedPlatformParam)}` : ""}`,
    [selectedPlatformParam],
  );

  const loadStatus = useCallback(async (options?: { silent?: boolean }) => {
    try {
      logRevenueClient("status-load:start", {
        silent: options?.silent ?? false,
        selectedPlatforms: selectedPlatforms.join(","),
      });
      const query = selectedPlatformParam ? `?platforms=${encodeURIComponent(selectedPlatformParam)}` : "";
      const nextStatus = await fetchRevenueJson<RevenueStatusData>(
        `/api/revenue/status${query}`,
        { cache: "no-store" },
        REVENUE_STATUS_TIMEOUT_MS,
      );
      setStatusData(nextStatus);
      setWatchingRefresh(nextStatus.hasActiveSyncJobs);
      logRevenueClient("status-load:success", {
        hasActiveSyncJobs: nextStatus.hasActiveSyncJobs,
        hasCompletedRefresh: nextStatus.hasCompletedRefresh,
        latestCompletedAt: nextStatus.syncSummary.latestCompletedAt,
        jobCount: nextStatus.syncSummary.jobs.length,
      });
      return nextStatus;
    } catch (statusError) {
      if (!isAbortError(statusError)) {
        logRevenueClient("status-load:error", {
          message: statusError instanceof Error ? statusError.message : String(statusError),
        });
      }
      return null;
    }
  }, [selectedPlatformParam, selectedPlatforms]);

  const loadTopTables = useCallback(async (options?: { preserveTables?: boolean }) => {
    const requestId = ++tablesRequestIdRef.current;
    if (!options?.preserveTables) {
      setTopTables(null);
    }
    setTablesLoading(true);
    logRevenueClient("top-tables-load:start", {
      requestId,
      selectedPlatforms: selectedPlatforms.join(","),
      from: queryRange.fromDate.toISOString(),
      to: queryRange.toDate.toISOString(),
    });

    try {
      const params = new URLSearchParams({
        preset,
        from: queryRange.fromDate.toISOString(),
        to: queryRange.toDate.toISOString(),
        granularity,
        buyerWindow,
        itemWindow,
      });
      if (selectedPlatforms.length > 0) {
        params.set("platforms", selectedPlatforms.join(","));
      }
      const nextTables = await fetchRevenueJson<RevenueTopTablesData>(
        `/api/revenue/tables?${params.toString()}`,
        { cache: "no-store" },
        REVENUE_TOP_TABLES_TIMEOUT_MS,
      );
      if (requestId !== tablesRequestIdRef.current) return;
      setTopTables(nextTables);
      logRevenueClient("top-tables-load:success", {
        requestId,
        topBuyerCount: nextTables.topBuyers.length,
        topItemCount: nextTables.topItems.length,
      });
    } catch (tablesError) {
      if (requestId !== tablesRequestIdRef.current) return;
      logRevenueClient("top-tables-load:error", {
        requestId,
        message: tablesError instanceof Error ? tablesError.message : String(tablesError),
      });
    } finally {
      if (requestId === tablesRequestIdRef.current) {
        setTablesLoading(false);
      }
    }
  }, [buyerWindow, granularity, itemWindow, preset, queryRange.fromDate, queryRange.toDate, selectedPlatforms]);

  const load = useCallback(async (options?: { silent?: boolean; preserveData?: boolean }) => {
    if (options?.silent && loadAbortRef.current) {
      return;
    }
    const requestId = ++requestIdRef.current;
    if (!options?.silent) {
      setLoading(true);
    }
    setError("");
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    logRevenueClient("analytics-load:start", {
      requestId,
      silent: options?.silent ?? false,
      selectedPlatforms: selectedPlatforms.join(","),
      from: queryRange.fromDate.toISOString(),
      to: queryRange.toDate.toISOString(),
    });

    try {
      const params = new URLSearchParams({
        preset,
        from: queryRange.fromDate.toISOString(),
        to: queryRange.toDate.toISOString(),
        granularity,
        buyerWindow,
        itemWindow,
      });
      if (selectedPlatforms.length > 0) {
        params.set("platforms", selectedPlatforms.join(","));
      }
      const nextData = await fetchRevenueJson<RevenuePageData>(
        `/api/revenue?${params.toString()}&includeTopTables=0`,
        {
          cache: "no-store",
          signal: controller.signal,
        },
        REVENUE_ANALYTICS_LOAD_TIMEOUT_MS,
      );
      if (requestId !== requestIdRef.current) return;
      setData(nextData);
      setStatusData({
        integrations: nextData.integrations,
        selectedPlatforms: nextData.filters.platforms,
        syncSummary: nextData.syncSummary,
        hasActiveSyncJobs: nextData.syncSummary.jobs.some(
          (job) => job.status === "PENDING" || job.status === "RUNNING",
        ),
        hasCompletedRefresh: Boolean(nextData.syncSummary.latestCompletedAt),
        notes: nextData.notes,
      });
      const nextHasActiveSyncJobs = nextData.syncSummary.jobs.some(
        (job) => job.status === "PENDING" || job.status === "RUNNING",
      );
      setWatchingRefresh(nextHasActiveSyncJobs);
      logRevenueClient("analytics-load:success", {
        requestId,
        mode: nextData.mode,
        hasAnyRevenueData: nextData.hasAnyRevenueData,
        hasActiveSyncJobs: nextHasActiveSyncJobs,
        latestCompletedAt: nextData.syncSummary.latestCompletedAt,
      });
      if (!nextHasActiveSyncJobs && nextData.syncSummary.latestCompletedAt) {
        setBanner((current) =>
          current.includes("Revenue refresh started") || current.includes("Watch Refresh Status below")
            ? "Revenue data refreshed."
            : current,
        );
      }
      void loadTopTables({ preserveTables: options?.preserveData });
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      if (isAbortError(loadError)) {
        logRevenueClient("analytics-load:aborted", { requestId });
        return;
      }
      const message =
        loadError instanceof RevenueRequestTimeoutError
          ? "Revenue data is taking longer than expected to load. ReorG will keep retrying in the background."
          : loadError instanceof Error
            ? loadError.message
            : "Failed to load revenue";
      logRevenueClient("analytics-load:error", {
        requestId,
        message,
        debugUrl: revenueDebugUrl,
      });
      setError(message);
      void loadStatus({ silent: true });
      if (!options?.preserveData) {
        setData(null);
        setTopTables(null);
      }
    } finally {
      if (loadAbortRef.current === controller) {
        loadAbortRef.current = null;
      }
      if (requestId === requestIdRef.current && !options?.silent) {
        setLoading(false);
      }
    }
  }, [buyerWindow, granularity, itemWindow, loadStatus, loadTopTables, preset, queryRange.fromDate, queryRange.toDate, revenueDebugUrl, selectedPlatforms]);

  useEffect(() => {
    void loadStatus();
    void load();
  }, [load, loadStatus]);

  useEffect(() => {
    return () => {
      loadAbortRef.current?.abort();
    };
  }, []);

  const hasActiveSyncJobs = Boolean(
    data?.syncSummary.jobs.some((job) => job.status === "PENDING" || job.status === "RUNNING") ??
      statusData?.hasActiveSyncJobs,
  );

  useEffect(() => {
    if (!watchingRefresh && !hasActiveSyncJobs) return undefined;
    const timer = window.setInterval(() => {
      void (async () => {
        const latestStatus = await loadStatus({ silent: true });
        if (
          latestStatus &&
          !latestStatus.hasActiveSyncJobs &&
          latestStatus.hasCompletedRefresh
        ) {
          void load({ silent: true, preserveData: true });
        }
      })();
    }, REVENUE_SYNC_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveSyncJobs, load, loadStatus, watchingRefresh]);

  useEffect(() => {
    const latestCompletedAt = statusData?.syncSummary.latestCompletedAt ?? null;
    if (!latestCompletedAt || statusData?.hasActiveSyncJobs) {
      return;
    }
    if (data?.syncSummary.latestCompletedAt === latestCompletedAt) {
      completedRefreshLoadRef.current = latestCompletedAt;
      return;
    }
    if (completedRefreshLoadRef.current === latestCompletedAt) {
      return;
    }

    completedRefreshLoadRef.current = latestCompletedAt;
    logRevenueClient("analytics-load:trigger-on-refresh-complete", {
      latestCompletedAt,
    });
    void load({ silent: true, preserveData: true });
  }, [data?.syncSummary.latestCompletedAt, load, statusData?.hasActiveSyncJobs, statusData?.syncSummary.latestCompletedAt]);

  async function handleManualRefresh() {
    setSyncing(true);
    setWatchingRefresh(false);
    setBanner("Refreshing revenue data. This can take a few minutes for eBay. Watch Refresh Status below for live job updates.");
    setError("");

    try {
      const platforms =
        selectedPlatforms.length > 0
          ? selectedPlatforms
          : data?.integrations.map((integration) => integration.platform) ?? [];
      const result = await fetchRevenueJson<RevenueSyncResult>(
        "/api/revenue/sync",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: queryRange.fromDate.toISOString(),
            to: queryRange.toDate.toISOString(),
            platforms,
          }),
        },
        REVENUE_SYNC_REQUEST_TIMEOUT_MS,
      );
      const hasQueuedOrRunningJobs = result.jobs.some(
        (job) => job.status === "PENDING" || job.status === "RUNNING",
      );
      logRevenueClient("sync:start-response", {
        hasQueuedOrRunningJobs,
        warningCount: result.warnings.length,
      });
      setWatchingRefresh(hasQueuedOrRunningJobs);
      void loadStatus({ silent: true });
      setBanner(
        hasQueuedOrRunningJobs
          ? result.warnings.length > 0
            ? `Revenue refresh started. ${result.warnings[0]}`
            : "Revenue refresh started. Watch Refresh Status below for live job updates."
          : result.warnings.length > 0
            ? `Revenue refresh finished with notes: ${result.warnings[0]}`
            : "Revenue data refreshed.",
      );
      if (!hasQueuedOrRunningJobs) {
        void load({ silent: true, preserveData: true });
      }
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Failed to refresh revenue");
    } finally {
      setSyncing(false);
    }
  }

  function togglePlatform(platform: Platform) {
    setSelectedPlatforms((current) =>
      current.includes(platform)
        ? current.filter((entry) => entry !== platform)
        : [...current, platform],
    );
  }

  function toggleTopBuyerPlatform(platform: Platform) {
    setTopBuyerPlatforms((current) =>
      current.includes(platform)
        ? current.filter((entry) => entry !== platform)
        : [...current, platform],
    );
  }

  function toggleTopItemPlatform(platform: Platform) {
    setTopItemPlatforms((current) =>
      current.includes(platform)
        ? current.filter((entry) => entry !== platform)
        : [...current, platform],
    );
  }

  const kpis = data?.kpis;
  const visibleStatusData = statusData ?? (data
    ? {
        integrations: data.integrations,
        selectedPlatforms: data.filters.platforms,
        syncSummary: data.syncSummary,
        hasActiveSyncJobs: data.syncSummary.jobs.some((job) => job.status === "PENDING" || job.status === "RUNNING"),
        hasCompletedRefresh: Boolean(data.syncSummary.latestCompletedAt),
        notes: data.notes,
      }
    : null);
  const hasTrendData = Boolean(data?.trend.some((point) => point.grossRevenue > 0));
  const hasStoreChartData = Boolean(data?.storeBreakdown.some((row) => row.grossRevenue > 0));
  const hasFeeChartData = Boolean(data?.feeBreakdown.some((row) => row.amount > 0));
  const hasShareData = Boolean(data?.revenueShare.some((row) => row.grossRevenue > 0));
  const availableTopTablePlatforms = visibleStatusData?.integrations.map((integration) => integration.platform) ?? [];
  const visibleTopBuyers = useMemo(
    () => deriveVisibleTopBuyerRows(topTables?.topBuyers ?? data?.topBuyers ?? [], topBuyerPlatforms),
    [data?.topBuyers, topBuyerPlatforms, topTables?.topBuyers],
  );
  const visibleTopItems = useMemo(
    () => deriveVisibleTopItemRows(topTables?.topItems ?? data?.topItems ?? [], topItemPlatforms),
    [data?.topItems, topItemPlatforms, topTables?.topItems],
  );
  const currentGrossRevenue = data?.kpis.grossRevenue.value ?? null;
  const kpiShareDetails = currentGrossRevenue && currentGrossRevenue > 0
    ? {
        netRevenue:
          data?.kpis.netRevenue.value != null
            ? `${formatPlainPercent((data.kpis.netRevenue.value / currentGrossRevenue) * 100)} of gross revenue`
            : null,
        marketplaceFees:
          data?.kpis.marketplaceFees.value != null
            ? `${formatPlainPercent((data.kpis.marketplaceFees.value / currentGrossRevenue) * 100)} of gross revenue`
            : null,
        advertisingFees:
          data?.kpis.advertisingFees.value != null
            ? `${formatPlainPercent((data.kpis.advertisingFees.value / currentGrossRevenue) * 100)} of gross revenue`
            : null,
        totalSellingCosts:
          data?.kpis.totalSellingCosts.value != null
            ? `${formatPlainPercent((data.kpis.totalSellingCosts.value / currentGrossRevenue) * 100)} of gross revenue, excluding tax collected`
            : null,
        taxCollected:
          data?.kpis.taxCollected.value != null
            ? `${formatPlainPercent((data.kpis.taxCollected.value / currentGrossRevenue) * 100)} of gross revenue`
            : null,
      }
    : {
        netRevenue: null,
        marketplaceFees: null,
        advertisingFees: null,
        totalSellingCosts: null,
        taxCollected: null,
      };
  const refreshProgress = useMemo(() => {
    const jobs = visibleStatusData?.syncSummary.jobs ?? [];
    if (jobs.length === 0) {
      return syncing || watchingRefresh
        ? { percent: 8, completed: 0, total: 0, active: true }
        : null;
    }

    const total = jobs.length;
    const completed = jobs.filter((job) => job.status === "COMPLETED" || job.status === "FAILED").length;
    const percent = Math.round(
      (jobs.reduce((sum, job) => sum + getRevenueJobProgress(job), 0) / total) * 100,
    );
    const active = syncing || watchingRefresh || jobs.some((job) => job.status === "PENDING" || job.status === "RUNNING");

    if (!active && completed === total) {
      return null;
    }

    return { percent: Math.max(percent, syncing ? 8 : 0), completed, total, active };
  }, [syncing, visibleStatusData?.syncSummary.jobs, watchingRefresh]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-4 md:p-6">
      <PageTour page="revenue" steps={PAGE_TOUR_STEPS.revenue} />

      <div
        className="flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-end md:justify-between"
        data-tour="revenue-header"
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">
            Revenue
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manual-refresh analytics for gross revenue, fee visibility, top buyers, and top items sold across every connected marketplace.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Last refresh: {formatDateTime(visibleStatusData?.syncSummary.latestCompletedAt ?? null)}
          </p>
        </div>
        <div className="flex flex-col gap-2 md:min-w-[260px] md:items-end">
          <button
            type="button"
            onClick={() => void handleManualRefresh()}
            disabled={syncing}
            className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
          >
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {syncing ? "Refreshing Revenue Data..." : "Refresh Revenue Data"}
          </button>
          {refreshProgress ? (
            <div className="w-full rounded-lg border border-border bg-card/70 px-3 py-2">
              <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                <span>Refresh Progress</span>
                <span>{refreshProgress.percent}%</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-[width] duration-500"
                  style={{ width: `${refreshProgress.percent}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {refreshProgress.total > 0
                  ? `${refreshProgress.completed} of ${refreshProgress.total} stores completed`
                  : "Queuing revenue refresh jobs..."}
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4" data-tour="revenue-filters">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {(["30d", "90d", "365d", "custom"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setPreset(value)}
                className={`cursor-pointer rounded-full border px-3 py-1.5 text-sm ${
                  preset === value
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                {value === "custom" ? "Custom" : value.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-[1fr_1fr_180px]">
            <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
              <CalendarRange className="h-4 w-4" />
              <input
                type="date"
                value={customFrom}
                onChange={(event) => setCustomFrom(event.target.value)}
                disabled={preset !== "custom"}
                className="w-full cursor-pointer bg-transparent text-foreground outline-none disabled:cursor-not-allowed disabled:text-muted-foreground"
              />
            </label>
            <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
              <CalendarRange className="h-4 w-4" />
              <input
                type="date"
                value={customTo}
                onChange={(event) => setCustomTo(event.target.value)}
                disabled={preset !== "custom"}
                className="w-full cursor-pointer bg-transparent text-foreground outline-none disabled:cursor-not-allowed disabled:text-muted-foreground"
              />
            </label>
            <select
              value={granularity}
              onChange={(event) => setGranularity(event.target.value as "day" | "week")}
              className="cursor-pointer rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
            >
              <option value="day">Daily view</option>
              <option value="week">Weekly view</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedPlatforms([])}
              className={`cursor-pointer rounded-full border px-3 py-1.5 text-sm ${
                selectedPlatforms.length === 0
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
            >
              All stores
            </button>
            {(visibleStatusData?.integrations ?? []).map((integration) => (
              <button
                key={integration.platform}
                type="button"
                onClick={() => togglePlatform(integration.platform)}
                className={`cursor-pointer rounded-full border px-3 py-1.5 text-sm ${
                  selectedPlatforms.includes(integration.platform)
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                {integration.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {banner ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          {banner}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <div>{error}</div>
          <div className="mt-2 text-xs text-red-100/90">
            Debug JSON: <a href={revenueDebugUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{revenueDebugUrl}</a>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="flex min-h-[40vh] items-center justify-center rounded-xl border border-border bg-card">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : null}

      {!loading && !data && visibleStatusData ? (
        <>
          {visibleStatusData.notes.length > 0 ? (
            <div className="space-y-2">
              {visibleStatusData.notes.map((note) => (
                <div key={note} className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  {note}
                </div>
              ))}
            </div>
          ) : null}

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">Refresh Status</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Analytics are not available yet, but live sync status is still available here.
                </p>
              </div>
              <a
                href={revenueDebugUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/60"
              >
                Open Debug JSON
              </a>
            </div>

            <div className="mt-4 space-y-3">
              {visibleStatusData.syncSummary.jobs.map((job) => (
                <div key={job.id} className="rounded-lg border border-border bg-background px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-foreground">{job.label}</p>
                      <p className="text-xs text-muted-foreground">{PLATFORM_FULL[job.platform]}</p>
                    </div>
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase ${
                      job.status === "COMPLETED"
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        : job.status === "FAILED"
                          ? "border-red-500/30 bg-red-500/10 text-red-200"
                          : "border-amber-500/30 bg-amber-500/10 text-amber-200"
                    }`}>
                      {job.status === "RUNNING" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      {job.status}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {job.ordersProcessed.toLocaleString()} orders • {job.linesProcessed.toLocaleString()} lines • {formatDateTime(job.completedAt)}
                  </p>
                  {job.errorSummary ? (
                    <p className="mt-2 text-xs text-red-200">{job.errorSummary}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {!loading && data && kpis ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" data-tour="revenue-summary">
            <KpiCard label="Gross Revenue" metric={kpis.grossRevenue} />
            <KpiCard label="Net Revenue" metric={kpis.netRevenue} detail={kpiShareDetails.netRevenue} />
            <KpiCard label="Total Marketplace Fees" metric={kpis.marketplaceFees} detail={kpiShareDetails.marketplaceFees} />
            <KpiCard label="Total Advertising Fees" metric={kpis.advertisingFees} detail={kpiShareDetails.advertisingFees} />
            <KpiCard label="Total Selling Costs" metric={kpis.totalSellingCosts} detail={kpiShareDetails.totalSellingCosts} />
            <KpiCard label="Tax Collected" metric={kpis.taxCollected} detail={kpiShareDetails.taxCollected} />
            <KpiCard label="Shipping Collected" metric={kpis.shippingCollected} />
            {data.mode === "ebay_exact" ? (
              <>
                <KpiCard label="Shipping Labels" metric={kpis.shippingLabels} />
                <KpiCard label="Account-Level Fees" metric={kpis.accountLevelFees} />
              </>
            ) : null}
            <KpiCard label="Orders" metric={kpis.orderCount} />
            <KpiCard label="Unique Buyers" metric={kpis.buyerCount} />
            <KpiCard label="Units Sold" metric={kpis.unitsSold} />
            <KpiCard label="Average Order Value" metric={kpis.averageOrderValue} />
          </div>

          {data.mode === "ebay_exact" && data.sourceSummary ? (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/8 px-4 py-3 text-sm text-emerald-100">
              Seller Hub style summary: gross {formatCurrency(data.sourceSummary.grossRevenue)}, taxes {formatCurrency(data.sourceSummary.taxCollected)}, selling costs {formatCurrency(data.sourceSummary.sellingCosts)}, net {formatCurrency(data.sourceSummary.netRevenue)}.
            </div>
          ) : null}

          {data.notes.length > 0 ? (
            <div className="space-y-2">
              {data.notes.map((note) => (
                <div key={note} className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  {note}
                </div>
              ))}
            </div>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-2" data-tour="revenue-charts">
            <div className="rounded-xl border border-border bg-card p-4">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {data.mode === "ebay_exact" ? "Gross vs Net Trend (eBay Exact)" : "Gross vs Net Trend"}
              </h2>
              {hasTrendData ? (
                <div className="mt-4 h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data.trend}>
                      <CartesianGrid stroke="rgba(148,163,184,0.12)" strokeDasharray="3 3" />
                      <XAxis dataKey="bucketLabel" stroke="#94a3b8" tick={{ fontSize: 12 }} />
                      <YAxis stroke="#94a3b8" tickFormatter={(value) => formatCurrencyCompact(value)} tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(value: number) => formatCurrency(value)} />
                      <Legend />
                      <Area type="monotone" dataKey="grossRevenue" name="Gross" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.18} />
                      <Area type="monotone" dataKey="netRevenue" name="Net" stroke="#22c55e" fill="#22c55e" fillOpacity={0.12} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="mt-4 flex h-80 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                  No revenue trend data yet for the selected overview range.
                </div>
              )}
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {data.mode === "ebay_exact" ? "Store Revenue Mix (eBay Exact)" : "Store Revenue Mix"}
              </h2>
              {hasStoreChartData ? (
                <div className="mt-4 h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.storeBreakdown}>
                      <CartesianGrid stroke="rgba(148,163,184,0.12)" strokeDasharray="3 3" />
                      <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 12 }} />
                      <YAxis stroke="#94a3b8" tickFormatter={(value) => formatCurrencyCompact(value)} tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(value: number) => formatCurrency(value)} />
                      <Legend />
                      <Bar dataKey="grossRevenue" name="Gross" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="marketplaceFees" name="Marketplace Fees" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="advertisingFees" name="Ad Fees" fill="#22c55e" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="netRevenue" name="Net" fill="#38bdf8" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="mt-4 flex h-80 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                  No store revenue data yet for the selected overview range.
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-border bg-card p-4">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Fee Breakdown
              </h2>
              {hasFeeChartData ? (
                <div className="mt-4 h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={data.feeBreakdown} dataKey="amount" nameKey="label" outerRadius={96}>
                        {data.feeBreakdown.map((entry, index) => (
                          <Cell key={entry.key} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value: number) => formatCurrency(value)} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="mt-4 flex h-72 items-center justify-center rounded-lg border border-dashed border-border px-6 text-center text-sm text-muted-foreground">
                  Fee charts appear when the selected stores return exact fee detail. eBay should populate this once the finance pull succeeds.
                </div>
              )}
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Revenue Share by Store
              </h2>
              {hasShareData ? (
                <div className="mt-4 h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={data.revenueShare} dataKey="grossRevenue" nameKey="label" outerRadius={96}>
                        {data.revenueShare.map((entry, index) => (
                          <Cell key={entry.platform} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value: number) => formatCurrency(value)} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="mt-4 flex h-72 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                  No store share data yet for the selected overview range.
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2" data-tour="revenue-buyers">
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">Top Buyers</h2>
                <div className="flex flex-col gap-2 md:items-end">
                  <div className="flex flex-wrap items-center gap-2">
                    {(["3d", "7d", "15d", "30d"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setBuyerWindow(value)}
                        className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${
                          buyerWindow === value
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                        }`}
                      >
                        {value.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setTopBuyerPlatforms([])}
                      className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${
                        topBuyerPlatforms.length === 0
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      }`}
                    >
                      All marketplaces
                    </button>
                    {availableTopTablePlatforms.map((platform) => (
                      <button
                        key={`buyer-filter-${platform}`}
                        type="button"
                        onClick={() => toggleTopBuyerPlatform(platform)}
                        className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${
                          topBuyerPlatforms.includes(platform)
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                        }`}
                      >
                        {formatMarketplaceBubbleLabel(platform)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    <tr>
                      <th className="pb-3 pr-4">Buyer</th>
                      <th className="pb-3 pr-4">Stores</th>
                      <th className="pb-3 pr-4">Orders</th>
                      <th className="pb-3 pr-4">Gross</th>
                      <th className="pb-3">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTopBuyers.map((buyer) => (
                      <tr key={buyer.buyerKey} className="border-t border-border/70">
                        <td className="py-3 pr-4">
                          <div className="font-medium text-foreground">{buyer.buyerName ?? buyer.buyerLabel}</div>
                          {buyer.buyerIdentifier !== buyer.buyerEmail ? (
                            <div className="text-xs text-muted-foreground">Buyer ID: {buyer.buyerIdentifier}</div>
                          ) : null}
                          <div className="text-xs text-muted-foreground">{buyer.buyerEmail ?? "No email provided"}</div>
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground">
                          <div className="flex flex-wrap items-center gap-2">
                            {buyer.platformBreakdown.map((entry) => (
                              <span key={`${buyer.buyerKey}-${entry.platform}`} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
                                <PlatformIcon platform={entry.platform} size={14} />
                                {formatMarketplaceBubbleLabel(entry.platform)}
                                <span className={`font-semibold ${marketplaceCountClassName(entry.platform)}`}>
                                  {entry.orderCount}
                                </span>
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground">{buyer.orderCount.toLocaleString()}</td>
                        <td className="py-3 pr-4 text-foreground">{formatCurrency(buyer.grossRevenue)}</td>
                        <td className="py-3 text-foreground">{formatCurrency(buyer.netRevenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {tablesLoading && visibleTopBuyers.length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">Loading buyer rankings...</div>
                ) : null}
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">Top Items Sold</h2>
                <div className="flex flex-col gap-2 md:items-end">
                  <div className="flex flex-wrap items-center gap-2">
                    {(["3d", "7d", "15d", "30d"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setItemWindow(value)}
                        className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${
                          itemWindow === value
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                        }`}
                      >
                        {value.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setTopItemPlatforms([])}
                      className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${
                        topItemPlatforms.length === 0
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      }`}
                    >
                      All marketplaces
                    </button>
                    {availableTopTablePlatforms.map((platform) => (
                      <button
                        key={`item-filter-${platform}`}
                        type="button"
                        onClick={() => toggleTopItemPlatform(platform)}
                        className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${
                          topItemPlatforms.includes(platform)
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                        }`}
                      >
                        {formatMarketplaceBubbleLabel(platform)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    <tr>
                      <th className="pb-3 pr-4">SKU / Title</th>
                      <th className="pb-3 pr-4">Stores</th>
                      <th className="pb-3 pr-4">Units</th>
                      <th className="pb-3 pr-4">Gross</th>
                      <th className="pb-3">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTopItems.map((item) => (
                      <tr key={item.sku} className="border-t border-border/70">
                        <td className="py-3 pr-4">
                          <div className="font-medium text-foreground">{item.sku}</div>
                          <div className="text-xs text-muted-foreground">{item.title ?? "Untitled item"}</div>
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground">
                          <div className="flex flex-wrap items-center gap-2">
                            {item.platformBreakdown.map((entry) => (
                              <span key={`${item.sku}-${entry.platform}`} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
                                <PlatformIcon platform={entry.platform} size={14} />
                                {formatMarketplaceBubbleLabel(entry.platform)}
                                <span className={`font-semibold ${marketplaceCountClassName(entry.platform)}`}>
                                  {entry.unitsSold}
                                </span>
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground">{item.unitsSold.toLocaleString()}</td>
                        <td className="py-3 pr-4 text-foreground">{formatCurrency(item.grossRevenue)}</td>
                        <td className="py-3 text-foreground">{formatCurrency(item.netRevenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {tablesLoading && visibleTopItems.length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">Loading item rankings...</div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
            <div className="rounded-xl border border-border bg-card p-4">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">Store Breakdown</h2>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    <tr>
                      <th className="pb-3 pr-4">Store</th>
                      <th className="pb-3 pr-4">Gross</th>
                      <th className="pb-3 pr-4">Orders</th>
                      <th className="pb-3 pr-4">AOV</th>
                      <th className="pb-3 pr-4">Fee Rate</th>
                      <th className="pb-3">Ad Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.storeBreakdown.map((store) => (
                      <tr key={store.platform} className="border-t border-border/70">
                        <td className="py-3 pr-4">
                          <div className="font-medium text-foreground">{store.label}</div>
                        </td>
                        <td className="py-3 pr-4 text-foreground">{formatCurrency(store.grossRevenue)}</td>
                        <td className="py-3 pr-4 text-muted-foreground">{store.orderCount.toLocaleString()}</td>
                        <td className="py-3 pr-4 text-foreground">{formatCurrency(store.averageOrderValue)}</td>
                        <td className="py-3 pr-4 text-muted-foreground">{formatPlainPercent(store.feeRatePercent)}</td>
                        <td className="py-3 text-muted-foreground">{formatPlainPercent(store.advertisingRatePercent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">Refresh Status</h2>
              <div className="mt-4 space-y-3">
                {data.syncSummary.jobs.map((job) => (
                  <div key={job.id} className="rounded-lg border border-border bg-background px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-foreground">{job.label}</p>
                        <p className="text-xs text-muted-foreground">{PLATFORM_FULL[job.platform]}</p>
                      </div>
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase ${
                        job.status === "COMPLETED"
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                          : job.status === "FAILED"
                            ? "border-red-500/30 bg-red-500/10 text-red-200"
                            : "border-amber-500/30 bg-amber-500/10 text-amber-200"
                      }`}>
                        {job.status === "RUNNING" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        {job.status}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {job.ordersProcessed.toLocaleString()} orders • {job.linesProcessed.toLocaleString()} lines • {formatDateTime(job.completedAt)}
                    </p>
                    {job.status === "RUNNING" ? (
                      <p className="mt-2 text-xs text-amber-200">Refresh in progress. Revenue is still being pulled for this store.</p>
                    ) : null}
                    {job.errorSummary ? (
                      <p className="mt-2 text-xs text-red-200">{job.errorSummary}</p>
                    ) : null}
                    {job.sourceSummary ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Gross {formatCurrency(job.sourceSummary.grossRevenue)} and net {formatCurrency(job.sourceSummary.netRevenue)}.
                      </p>
                    ) : null}
                    {job.syncStages.length > 0 ? (
                      <div className="mt-3 space-y-2">
                        {job.syncStages.map((stage) => (
                          <div key={`${job.id}-${stage.key}`} className="rounded-md border border-border/70 bg-card px-2.5 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-medium text-foreground">{stage.label}</p>
                              <span
                                className={`text-[10px] font-semibold uppercase ${
                                  stage.status === "COMPLETED"
                                    ? "text-emerald-300"
                                    : stage.status === "FAILED"
                                      ? "text-red-200"
                                      : "text-amber-200"
                                }`}
                              >
                                {stage.status}
                              </span>
                            </div>
                            {stage.detail ? (
                              <p className="mt-1 text-[11px] text-muted-foreground">{stage.detail}</p>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
