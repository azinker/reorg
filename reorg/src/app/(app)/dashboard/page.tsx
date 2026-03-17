"use client";

import { useEffect, useRef, useState } from "react";
import { DataGrid } from "@/components/grid/data-grid";
import type { GridRow } from "@/lib/grid-types";
import { MOCK_ROWS } from "@/lib/mock-data";
import { Loader2, RefreshCw } from "lucide-react";

const GRID_VERSION_POLL_MS = 60_000;

interface GridPayload {
  rows: GridRow[];
  source: "db" | "mock";
  error: string | null;
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

export default function DashboardPage() {
  const [rows, setRows] = useState<GridRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"db" | "mock" | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const versionRef = useRef<string | null>(null);
  const sourceRef = useRef<"db" | "mock" | null>(null);
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function loadInitial() {
      const [gridData, version] = await Promise.all([
        fetchGridData(),
        fetchGridVersion().catch(() => null),
      ]);
      if (cancelled) return;

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
      }
    }

    void loadInitial();

    const intervalId = window.setInterval(() => {
      void refreshGridIfChanged();
    }, GRID_VERSION_POLL_MS);

    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
    };
  }, []);

  if (!rows) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center overflow-hidden">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">Loading grid data...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {isRefreshing && source === "db" && (
        <div className="flex items-center gap-2 border-b border-blue-500/20 bg-blue-500/5 px-4 py-1.5">
          <RefreshCw className="h-3.5 w-3.5 animate-spin text-blue-400" />
          <span className="text-xs text-blue-400">
            Refreshing live marketplace values in the background...
          </span>
        </div>
      )}
      {source === "mock" && (
        <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-4 py-1.5">
          <span className="text-xs text-amber-400">
            {error
              ? "Database connection failed — showing mock data."
              : "No products in database yet — showing mock data. Run seed to populate."}
          </span>
        </div>
      )}
      {source === "db" && (
        <div className="flex items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/5 px-4 py-1.5">
          <span className="text-xs text-emerald-400">
            Connected to database — {rows.length} products loaded.
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <DataGrid rows={rows} />
      </div>
    </div>
  );
}
