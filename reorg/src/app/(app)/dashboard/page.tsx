"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DataGrid } from "@/components/grid/data-grid";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";
import { useDashboardConnection } from "@/contexts/dashboard-connection-context";
import type { GridRow, Platform } from "@/lib/grid-types";
import { usePageVisibility } from "@/lib/use-page-visibility";
import { Loader2, RefreshCw } from "lucide-react";

const VALID_DEEP_LINK_PLATFORMS = new Set<string>(["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"]);

function DashboardGridArea({ rows }: { rows: GridRow[] }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const itemId = searchParams.get("itemId") ?? searchParams.get("platformItemId");
  const platformRaw = searchParams.get("platform");
  const deepLinkPlatform =
    platformRaw && VALID_DEEP_LINK_PLATFORMS.has(platformRaw) ? (platformRaw as Platform) : null;

  const onDeepLinkConsumed = useCallback(() => {
    router.replace("/dashboard", { scroll: false });
  }, [router]);

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
      <DataGrid
        rows={rows}
        deepLinkItemId={itemId}
        deepLinkPlatform={deepLinkPlatform}
        onDeepLinkConsumed={onDeepLinkConsumed}
      />
    </div>
  );
}

const GRID_VERSION_POLL_MS = 60_000;
const SCHEDULER_HEALTH_POLL_MS = 120_000;

interface GridPayload {
  rows: GridRow[];
  source: "db" | "error";
  error: string | null;
}

interface SchedulerHealthPayload {
  healthSummary?: {
    status: "healthy" | "delayed" | "attention";
    headline: string;
    detail: string;
    recommendedAction: string;
    affectedLabels: string[];
    missingWebhookCount: number;
  };
}

/**
 * All three of these fetchers accept an optional AbortSignal. The dashboard
 * grid endpoint can return tens of thousands of rows and historically took
 * 10-30 s on cold Vercel instances; without a signal the request kept running
 * after the user navigated away (e.g. to /help-desk), continued to log a
 * misleading "Failed to load grid data" error to the console of the new
 * page, and held a network slot that competed with the help-desk's own
 * fetches. Passing a signal lets the dashboard's cleanup effect cancel
 * the request the instant the user leaves the page.
 */
async function fetchGridData(signal?: AbortSignal): Promise<GridPayload> {
  try {
    const res = await fetch("/api/grid", { cache: "no-store", signal });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const json = await res.json();
    const dbRows: GridRow[] = json.data?.rows ?? [];
    if (dbRows.length > 0) {
      return { rows: dbRows, source: "db", error: null };
    }

    return {
      rows: [],
      source: "error",
      error: "Live grid returned zero rows.",
    };
  } catch (err) {
    // Treat anything that looks like an abort/navigation as expected and
    // don't spam the console. Chrome reports an aborted fetch as either:
    //   - DOMException name=AbortError (when AbortController.abort() ran
    //     BEFORE the request started)
    //   - TypeError "Failed to fetch" (when the page is mid-navigation
    //     while the request is in flight — happens when user logs in to
    //     /dashboard then immediately clicks the sidebar to /help-desk;
    //     /api/grid is a 10-30 s call and almost always still pending
    //     when navigation happens)
    const aborted =
      signal?.aborted ||
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof TypeError && /failed to fetch/i.test(err.message));
    if (aborted) {
      return { rows: [], source: "error", error: "aborted" };
    }
    console.error("Failed to load grid data from API:", err);
    return { rows: [], source: "error", error: String(err) };
  }
}

async function fetchGridVersion(signal?: AbortSignal): Promise<string | null> {
  const res = await fetch("/api/grid/version", { cache: "no-store", signal }).catch(
    () => null,
  );
  if (!res) {
    return null;
  }
  if (!res.ok) {
    return null;
  }
  const json = await res.json().catch(() => null);
  return typeof json.data?.version === "string" ? json.data.version : null;
}

async function fetchSchedulerHealth(
  signal?: AbortSignal,
): Promise<SchedulerHealthPayload["healthSummary"] | null> {
  const res = await fetch("/api/scheduler/status", { cache: "no-store", signal });
  if (!res.ok) {
    throw new Error(`Scheduler status API returned ${res.status}`);
  }
  const json = await res.json();
  return (json.data?.healthSummary ?? null) as SchedulerHealthPayload["healthSummary"] | null;
}

function summarizeGrid(rows: GridRow[]) {
  const variationParents = rows.filter((row) => row.isParent).length;
  const standaloneRows = rows.filter((row) => !row.isParent).length;
  const childRows = rows.reduce((sum, row) => sum + (row.childRows?.length ?? 0), 0);
  const actualProducts = standaloneRows + childRows;
  const listingCounts = new Map<Platform, Set<string>>();

  function collectProductRow(productRow: GridRow) {
    for (const item of productRow.itemNumbers) {
      if (!listingCounts.has(item.platform)) {
        listingCounts.set(item.platform, new Set());
      }
      listingCounts.get(item.platform)!.add(`${item.platform}:${item.listingId}:${item.variantId ?? ""}`);
    }
  }

  for (const row of rows) {
    if (row.isParent && row.childRows) {
      for (const child of row.childRows) {
        collectProductRow(child);
      }
      continue;
    }
    collectProductRow(row);
  }

  return {
    masterGroups: rows.length,
    variationParents,
    standaloneRows,
    childRows,
    actualProducts,
    listingCounts,
  };
}

export default function DashboardPage() {
  const isPageVisible = usePageVisibility();
  const [rows, setRows] = useState<GridRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"db" | "error" | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [schedulerHealth, setSchedulerHealth] = useState<SchedulerHealthPayload["healthSummary"] | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(8);
  const versionRef = useRef<string | null>(null);
  const sourceRef = useRef<"db" | "error" | null>(null);
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Single AbortController for ALL in-flight fetches owned by the
    // dashboard mount. When the user navigates away (e.g. to /help-desk),
    // cleanup aborts the controller and any pending /api/grid request
    // unwinds immediately instead of continuing to consume a network slot
    // and the main thread on the next page.
    const ac = new AbortController();

    async function loadInitial() {
      setLoadingProgress(14);
      const [gridData, version] = await Promise.all([
        fetchGridData(ac.signal),
        fetchGridVersion(ac.signal).catch(() => null),
      ]);
      void fetchSchedulerHealth(ac.signal)
        .then((health) => {
          if (!cancelled) setSchedulerHealth(health);
        })
        .catch(() => {
          if (!cancelled) setSchedulerHealth(null);
        });
      if (cancelled) return;

      setLoadingProgress(100);
      setRows(gridData.rows);
      setSource(gridData.source);
      setError(gridData.error);
      sourceRef.current = gridData.source;
      versionRef.current = version;
    }

    async function refreshGridIfChanged(force = false) {
      if (refreshInFlightRef.current) return;

      try {
        const nextVersion = await fetchGridVersion(ac.signal);
        const shouldRefresh =
          force ||
          sourceRef.current !== "db" ||
          (nextVersion != null &&
            versionRef.current != null &&
            nextVersion !== versionRef.current);

        if (!shouldRefresh) {
          if (nextVersion != null) {
            versionRef.current = nextVersion;
          }
          return;
        }

        refreshInFlightRef.current = true;
        setIsRefreshing(true);
        const gridData = await fetchGridData(ac.signal);
        if (cancelled) return;

        if (gridData.source === "error" && sourceRef.current === "db") {
          console.warn("[dashboard] Background grid refresh failed, keeping existing data:", gridData.error);
          return;
        }

        setRows(gridData.rows);
        setSource(gridData.source);
        setError(gridData.error);
        sourceRef.current = gridData.source;
        versionRef.current = nextVersion;
      } catch (err) {
        void err;
      } finally {
        refreshInFlightRef.current = false;
        if (!cancelled) {
          setIsRefreshing(false);
        }
      }
    }

    function handleVisibilityOrFocus() {
      if (document.visibilityState === "visible") {
        void refreshGridIfChanged();
        void fetchSchedulerHealth(ac.signal)
          .then((health) => {
            if (!cancelled) setSchedulerHealth(health);
          })
          .catch(() => {
            if (!cancelled) setSchedulerHealth(null);
          });
      }
    }

    void loadInitial();

    const progressTimer = window.setInterval(() => {
      setLoadingProgress((current) => {
        if (current >= 92) return current;
        const next = current + Math.max(2, Math.round((100 - current) / 8));
        return Math.min(next, 92);
      });
    }, 180);

    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshGridIfChanged();
    }, GRID_VERSION_POLL_MS);
    const schedulerHealthTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetchSchedulerHealth(ac.signal)
        .then((health) => {
          if (!cancelled) setSchedulerHealth(health);
        })
        .catch(() => {
          if (!cancelled) setSchedulerHealth(null);
        });
    }, SCHEDULER_HEALTH_POLL_MS);

    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);

    return () => {
      cancelled = true;
      ac.abort();
      window.clearInterval(progressTimer);
      window.clearInterval(intervalId);
      window.clearInterval(schedulerHealthTimer);
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
    };
  }, []);

  useEffect(() => {
    if (!isPageVisible) return;
    const ac = new AbortController();
    void fetchSchedulerHealth(ac.signal)
      .then((health) => {
        if (!ac.signal.aborted) setSchedulerHealth(health);
      })
      .catch(() => {
        if (!ac.signal.aborted) setSchedulerHealth(null);
      });
    return () => ac.abort();
  }, [isPageVisible]);

  const summary = useMemo(() => (rows ? summarizeGrid(rows) : null), [rows]);
  const { setConnectionInfo } = useDashboardConnection();

  useEffect(() => {
    if (rows == null || source == null) {
      setConnectionInfo(null);
      return;
    }
    setConnectionInfo({
      source,
      error,
      summary,
    });
    return () => setConnectionInfo(null);
  }, [rows, source, error, summary, setConnectionInfo]);

  if (!rows) {
    return (
      <div className="flex h-full min-h-0 min-w-0 items-center justify-center overflow-hidden">
        <div className="w-full max-w-md px-6">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="text-sm text-muted-foreground">Loading grid data...</span>
          </div>
          <div className="mt-5 overflow-hidden rounded-full border border-purple-500/30 bg-purple-500/10 p-1 shadow-[0_0_18px_rgba(168,85,247,0.14)]">
            <div
              className="h-3 rounded-full bg-gradient-to-r from-fuchsia-500 via-violet-500 to-purple-400 shadow-[0_0_20px_rgba(168,85,247,0.45)] transition-[width] duration-300 ease-out"
              style={{ width: `${loadingProgress}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-purple-300/80">
            <span>Connecting to live grid data</span>
            <span>{loadingProgress}%</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {schedulerHealth && schedulerHealth.status !== "healthy" && source === "db" && (
        <div
          data-tour="dashboard-health-banner"
          className={
            schedulerHealth.status === "attention"
              ? "border-b border-red-500/20 bg-red-500/5 px-4 py-2"
              : "border-b border-amber-500/20 bg-amber-500/5 px-4 py-2"
          }
        >
          <div
            className={
              schedulerHealth.status === "attention"
                ? "text-xs text-red-300"
                : "text-xs text-amber-300"
            }
          >
            <div className="font-semibold">
              Store update health: {schedulerHealth.headline}
            </div>
            {schedulerHealth.affectedLabels.length > 0 ? (
              <div className="mt-0.5">
                Affected stores: {schedulerHealth.affectedLabels.join(", ")}
              </div>
            ) : null}
            <div className="mt-0.5">{schedulerHealth.detail}</div>
            <div className="mt-1 opacity-90">
              Next step: {schedulerHealth.recommendedAction}
            </div>
          </div>
        </div>
      )}
      {isRefreshing && source === "db" && (
        <div className="flex items-center gap-2 border-b border-blue-500/20 bg-blue-500/5 px-4 py-1.5">
          <RefreshCw className="h-3.5 w-3.5 animate-spin text-blue-400" />
          <span className="text-xs text-blue-400">
            Refreshing live marketplace values in the background...
          </span>
        </div>
      )}
      {source === "error" && (
        <div className="border-b border-red-500/20 bg-red-500/5 px-4 py-2">
          <div className="text-xs text-red-300">
            <div className="font-semibold">Dashboard connection issue</div>
            <div className="mt-0.5">
              The live dashboard data could not be loaded, so reorG is not showing sample rows
              here anymore.
            </div>
            {error ? <div className="mt-1 opacity-90">Detail: {error}</div> : null}
          </div>
        </div>
      )}
      <Suspense
        fallback={
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <DataGrid rows={rows} />
          </div>
        }
      >
        <DashboardGridArea rows={rows} />
      </Suspense>
      <Suspense fallback={null}>
        <PageTour page="dashboard" steps={PAGE_TOUR_STEPS.dashboard} ready />
      </Suspense>
    </div>
  );
}
