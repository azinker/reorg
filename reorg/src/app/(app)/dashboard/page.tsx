"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { DataGrid } from "@/components/grid/data-grid";
import { DashboardTour } from "@/components/onboarding/dashboard-tour";
import { useDashboardConnection } from "@/contexts/dashboard-connection-context";
import type { GridRow, Platform } from "@/lib/grid-types";
import { MOCK_ROWS } from "@/lib/mock-data";
import { Loader2, RefreshCw } from "lucide-react";

const GRID_VERSION_POLL_MS = 60_000;
const SCHEDULER_HEALTH_POLL_MS = 120_000;

interface GridPayload {
  rows: GridRow[];
  source: "db" | "mock";
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

async function fetchGridData(): Promise<GridPayload> {
  try {
    const res = await fetch("/api/grid", { cache: "no-store" });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const json = await res.json();
    const dbRows: GridRow[] = json.data?.rows ?? [];
    if (dbRows.length > 0) {
      return { rows: dbRows, source: "db", error: null };
    }
    return { rows: MOCK_ROWS, source: "mock", error: null };
  } catch (err) {
    console.error("Failed to load grid data from API, falling back to mock:", err);
    return { rows: MOCK_ROWS, source: "mock", error: String(err) };
  }
}

async function fetchGridVersion(): Promise<string | null> {
  const res = await fetch("/api/grid/version", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Version API returned ${res.status}`);
  }
  const json = await res.json();
  return typeof json.data?.version === "string" ? json.data.version : null;
}

async function fetchSchedulerHealth(): Promise<SchedulerHealthPayload["healthSummary"] | null> {
  const res = await fetch("/api/scheduler/status", { cache: "no-store" });
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
  const [rows, setRows] = useState<GridRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"db" | "mock" | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [schedulerHealth, setSchedulerHealth] = useState<SchedulerHealthPayload["healthSummary"] | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(8);
  const versionRef = useRef<string | null>(null);
  const sourceRef = useRef<"db" | "mock" | null>(null);
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function loadInitial() {
      setLoadingProgress(14);
      const [gridData, version] = await Promise.all([
        fetchGridData(),
        fetchGridVersion().catch(() => null),
      ]);
      void fetchSchedulerHealth()
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
        const nextVersion = await fetchGridVersion();
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
        const gridData = await fetchGridData();
        if (cancelled) return;

        setRows(gridData.rows);
        setSource(gridData.source);
        setError(gridData.error);
        sourceRef.current = gridData.source;
        versionRef.current = nextVersion;
      } catch (err) {
        if (!cancelled) {
          console.error("[dashboard] background refresh failed", err);
        }
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
        void fetchSchedulerHealth()
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
      void refreshGridIfChanged();
    }, GRID_VERSION_POLL_MS);
    const schedulerHealthTimer = window.setInterval(() => {
      void fetchSchedulerHealth()
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
      window.clearInterval(progressTimer);
      window.clearInterval(intervalId);
      window.clearInterval(schedulerHealthTimer);
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
    };
  }, []);

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
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <DataGrid rows={rows} />
      </div>
      <Suspense fallback={null}>
        <DashboardTour gridReady />
      </Suspense>
    </div>
  );
}
