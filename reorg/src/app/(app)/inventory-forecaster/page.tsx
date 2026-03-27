"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  Download,
  Info,
  Loader2,
  PackagePlus,
  Save,
  Sparkles,
  Truck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";
import type {
  ForecastLineResult,
  ForecastResult,
  SupplierOrderSummary,
} from "@/lib/inventory-forecast/types";

type BootstrapData = {
  recentRuns: Array<{
    id: string;
    createdAt: string;
    lookbackDays: number;
    forecastBucket: "DAILY" | "WEEKLY";
    transitDays: number;
    desiredCoverageDays: number;
    lineCount: number;
  }>;
  recentOrders: SupplierOrderSummary[];
  inventorySource: "MASTER_TPP_LIVE";
  confidenceLegend: Record<"HIGH" | "MEDIUM" | "LOW", string>;
};

type ForecastControlsState = {
  lookbackDaysPreset: "90" | "180" | "365" | "custom";
  customLookbackDays: string;
  forecastBucket: "WEEKLY" | "DAILY";
  transitDays: string;
  desiredCoverageDays: string;
  useOpenInTransit: boolean;
  reorderRelevantOnly: boolean;
};

const DEFAULT_CONTROLS: ForecastControlsState = {
  lookbackDaysPreset: "90",
  customLookbackDays: "90",
  forecastBucket: "WEEKLY",
  transitDays: "45",
  desiredCoverageDays: "120",
  useOpenInTransit: true,
  reorderRelevantOnly: true,
};

function formatDateTime(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortDate(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function formatNumber(value: number | null | undefined) {
  if (value == null) return "-";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatQty(value: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function getLookbackDays(controls: ForecastControlsState) {
  if (controls.lookbackDaysPreset === "custom") {
    return Math.max(1, Number(controls.customLookbackDays) || 90);
  }
  return Number(controls.lookbackDaysPreset);
}

function warningChip(flag: ForecastLineResult["warningFlags"][number]) {
  if (flag === "LOW_CONFIDENCE") return "Low confidence";
  if (flag === "SUSPECTED_STOCKOUT") return "Possible stockout distortion";
  if (flag === "LIMITED_HISTORY") return "Limited sales history";
  if (flag === "IN_TRANSIT_EXISTS") return "Order already on the way";
  if (flag === "EBAY_HISTORY_TRUNCATED") return "eBay history still building";
  return "No sales found";
}

function noteForWarnings(line: ForecastLineResult) {
  if (line.openInTransitQty > 0 && line.openInTransitEta) {
    return `${line.openInTransitQty} inbound, ETA ${shortDate(line.openInTransitEta)}`;
  }
  return null;
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function estimateForecastDurationMs(controls: ForecastControlsState) {
  const lookbackDays = getLookbackDays(controls);
  let estimateMs = 25000;

  if (lookbackDays > 30) estimateMs = 35000;
  if (lookbackDays > 90) estimateMs = 50000;
  if (lookbackDays > 180) estimateMs = 65000;
  if (controls.forecastBucket === "DAILY") estimateMs += 8000;
  if (!controls.reorderRelevantOnly) estimateMs += 5000;

  return estimateMs;
}

function patternLabel(pattern: string) {
  switch (pattern) {
    case "STABLE": return "Steady";
    case "TRENDING": return "Trending";
    case "SEASONAL": return "Seasonal";
    case "INTERMITTENT": return "Sporadic";
    case "SLOW_MOVER": return "Slow mover";
    case "NEW_ITEM": return "New item";
    default: return pattern.replace(/_/g, " ");
  }
}

function confidenceTone(level: keyof BootstrapData["confidenceLegend"]) {
  if (level === "HIGH") return "text-emerald-400";
  if (level === "MEDIUM") return "text-amber-300";
  return "text-muted-foreground";
}

function orderStatusBadgeClass(status: SupplierOrderSummary["status"]) {
  if (status === "ORDERED" || status === "IN_TRANSIT" || status === "RECEIVED") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  }
  if (status === "CANCELLED") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  }
  return "border-border bg-background text-muted-foreground";
}

function InfoBlurb({ text }: { text: string }) {
  const [show, setShow] = useState(false);

  return (
    <span className="relative inline-flex">
      <span
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
        className="inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/15 hover:text-emerald-200"
        tabIndex={0}
        role="img"
        aria-label="More information"
      >
        <Info className="h-2.5 w-2.5" />
      </span>
      {show ? (
        <div className="absolute left-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-3rem)] rounded-xl border border-border bg-popover p-3 text-left text-[11px] leading-5 text-popover-foreground shadow-2xl">
          {text}
        </div>
      ) : null}
    </span>
  );
}

export default function InventoryForecasterPage() {
  const [controls, setControls] = useState<ForecastControlsState>(DEFAULT_CONTROLS);
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [result, setResult] = useState<ForecastResult | null>(null);
  const [overrideMap, setOverrideMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [savingRun, setSavingRun] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: "success" | "error" | "info" } | null>(null);
  const [savedRunId, setSavedRunId] = useState<string | null>(null);
  const [supplier, setSupplier] = useState("");
  const [orderEta, setOrderEta] = useState("");
  const [orderNotes, setOrderNotes] = useState("");
  const [recentOrders, setRecentOrders] = useState<SupplierOrderSummary[]>([]);
  const [patchingOrderId, setPatchingOrderId] = useState<string | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runElapsedMs, setRunElapsedMs] = useState(0);

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch("/api/inventory-forecaster", { cache: "no-store" });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "Failed to load forecaster");
        const data = json.data as BootstrapData;
        setBootstrap(data);
        setRecentOrders(data.recentOrders ?? []);
      } catch (error) {
        setStatusMessage({
          text: error instanceof Error ? error.message : "Failed to load Inventory Forecaster.",
          type: "error",
        });
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  useEffect(() => {
    if (!running || runStartedAt == null) {
      setRunElapsedMs(0);
      return undefined;
    }

    setRunElapsedMs(Date.now() - runStartedAt);
    const interval = window.setInterval(() => {
      setRunElapsedMs(Date.now() - runStartedAt);
    }, 250);

    return () => window.clearInterval(interval);
  }, [runStartedAt, running]);

  useEffect(() => {
    if (!statusMessage) return undefined;
    const timer = window.setTimeout(() => setStatusMessage(null), 8000);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  const effectiveLines = useMemo(() => {
    if (!result) return [];
    return result.lines.map((line) => {
      const overrideText = overrideMap[line.masterRowId];
      const overrideQty =
        overrideText == null || overrideText.trim() === ""
          ? line.overrideQty
          : Math.max(0, Math.round(Number(overrideText) || 0));
      return {
        ...line,
        overrideQty,
        finalQty: overrideQty == null ? line.recommendedQty : overrideQty,
      };
    });
  }, [overrideMap, result]);

  async function runForecast() {
    setRunning(true);
    setRunStartedAt(Date.now());
    setStatusMessage(null);
    setSavedRunId(null);

    try {
      const response = await fetch("/api/inventory-forecaster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lookbackDays: getLookbackDays(controls),
          forecastBucket: controls.forecastBucket,
          transitDays: Number(controls.transitDays) || 0,
          desiredCoverageDays: Number(controls.desiredCoverageDays) || 0,
          useOpenInTransit: controls.useOpenInTransit,
          reorderRelevantOnly: controls.reorderRelevantOnly,
        }),
      });
      const text = await response.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(
          response.status === 504
            ? "The forecast timed out. Try reducing the lookback period or try again."
            : `Server returned an unexpected response (${response.status}).`,
        );
      }
      if (!response.ok) throw new Error((json.error as string) ?? "Failed to run forecast");
      const forecast = json.data as ForecastResult;
      setResult(forecast);
      setOverrideMap(
        Object.fromEntries(
          forecast.lines.map((line) => [line.masterRowId, line.overrideQty?.toString() ?? ""]),
        ),
      );
      setOrderEta(
        new Date(
          Date.now() + (Number(controls.transitDays) || 0) * 24 * 60 * 60 * 1000,
        )
          .toISOString()
          .slice(0, 10),
      );
      setStatusMessage({
        text: `Forecast complete — ${forecast.lines.length} SKU${forecast.lines.length === 1 ? "" : "s"} analyzed.`,
        type: "success",
      });
    } catch (error) {
      setStatusMessage({
        text: error instanceof Error ? error.message : "Failed to run Inventory Forecast.",
        type: "error",
      });
    } finally {
      setRunning(false);
      setRunStartedAt(null);
    }
  }

  function buildResultForActions(): ForecastResult | null {
    if (!result) return null;
    return {
      ...result,
      lines: effectiveLines,
    };
  }

  async function saveRunIfNeeded(force = false) {
    const payload = buildResultForActions();
    if (!payload) return null;
    if (!force && savedRunId) return savedRunId;

    setSavingRun(true);
    try {
      const response = await fetch("/api/inventory-forecaster/save-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result: payload }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Failed to save run");
      const runId = String(json.data.id);
      setSavedRunId(runId);
      setStatusMessage({ text: `Run saved — ${payload.lines.length} SKUs.`, type: "success" });
      return runId;
    } catch (error) {
      setStatusMessage({ text: error instanceof Error ? error.message : "Failed to save run.", type: "error" });
      return null;
    } finally {
      setSavingRun(false);
    }
  }

  async function createOrder() {
    const payload = buildResultForActions();
    if (!payload) return;
    setCreatingOrder(true);
    try {
      const runId = await saveRunIfNeeded();
      const response = await fetch("/api/inventory-forecaster/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forecastRunId: runId,
          supplier: supplier.trim() || null,
          eta: orderEta ? new Date(orderEta).toISOString() : null,
          notes: orderNotes.trim() || null,
          transitDays: payload.controls.transitDays,
          lines: payload.lines,
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Failed to create supplier order");
      setStatusMessage({ text: `Order created with ${json.data.lineCount} lines.`, type: "success" });

      const refresh = await fetch("/api/inventory-forecaster", { cache: "no-store" });
      const refreshJson = await refresh.json();
      if (refresh.ok) {
        setRecentOrders((refreshJson.data as BootstrapData).recentOrders ?? []);
      }
    } catch (error) {
      setStatusMessage({
        text: error instanceof Error ? error.message : "Failed to create supplier order.",
        type: "error",
      });
    } finally {
      setCreatingOrder(false);
    }
  }

  async function exportWorkbook() {
    const payload = buildResultForActions();
    if (!payload) return;
    setExporting(true);
    try {
      const response = await fetch("/api/inventory-forecaster/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result: payload }),
      });
      if (!response.ok) {
        const text = await response.text();
        let errorMsg = "Failed to export workbook";
        try { errorMsg = (JSON.parse(text) as { error?: string }).error ?? errorMsg; } catch { /* non-JSON response */ }
        throw new Error(errorMsg);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename=\"([^\"]+)\"/);
      anchor.download = match?.[1] ?? "Inventory_Forecast.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setStatusMessage({ text: "Spreadsheet downloaded.", type: "success" });
    } catch (error) {
      setStatusMessage({
        text: error instanceof Error ? error.message : "Failed to export workbook.",
        type: "error",
      });
    } finally {
      setExporting(false);
    }
  }

  async function patchOrder(
    orderId: string,
    patch: Partial<Pick<SupplierOrderSummary, "status" | "supplier" | "notes">> & { eta?: string },
  ) {
    setPatchingOrderId(orderId);
    try {
      const response = await fetch(`/api/inventory-forecaster/order/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Failed to update order");
      setRecentOrders((prev) =>
        prev.map((order) =>
          order.id === orderId
            ? {
                ...order,
                status: json.data.status,
                eta: json.data.eta,
                supplier: json.data.supplier,
                notes: json.data.notes,
              }
            : order,
        ),
      );
      setStatusMessage({ text: "Order updated.", type: "info" });
    } catch (error) {
      setStatusMessage({
        text: error instanceof Error ? error.message : "Failed to update supplier order.",
        type: "error",
      });
    } finally {
      setPatchingOrderId(null);
    }
  }

  const headlineStats = useMemo(() => {
    const reorderCount = effectiveLines.filter((line) => line.finalQty > 0).length;
    const totalSuggested = effectiveLines.reduce((total, line) => total + line.finalQty, 0);
    const stockoutWarnings = effectiveLines.filter((line) => line.suspectedStockout).length;
    return { reorderCount, totalSuggested, stockoutWarnings };
  }, [effectiveLines]);

  const openOrderCount = recentOrders.filter((order) =>
    ["DRAFT", "ORDERED", "IN_TRANSIT"].includes(order.status),
  ).length;
  const inboundCountedOrderCount = recentOrders.filter((order) =>
    ["ORDERED", "IN_TRANSIT"].includes(order.status),
  ).length;
  const savedRunCount = bootstrap?.recentRuns.length ?? 0;
  const estimatedRunMs = estimateForecastDurationMs(controls);
  const clampedProgress = (() => {
    if (!running) return 0;
    if (runElapsedMs <= estimatedRunMs) {
      return Math.min(runElapsedMs / estimatedRunMs, 0.92);
    }
    const overtimeMs = runElapsedMs - estimatedRunMs;
    const overtimeWindow = Math.max(estimatedRunMs * 0.75, 15000);
    return Math.min(0.92 + overtimeMs / overtimeWindow / 10, 0.99);
  })();
  const progressPercent = Math.max(6, Math.round(clampedProgress * 100));
  const elapsedSeconds = Math.max(1, Math.round(runElapsedMs / 1000));
  const estimatedSeconds = Math.max(1, Math.round(estimatedRunMs / 1000));
  const remainingSeconds = Math.max(0, estimatedSeconds - elapsedSeconds);

  return (
    <div className="p-6">
      <div
        className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"
        data-tour="inventory-forecaster-header"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Inventory Forecaster
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            See what needs reordering based on real sales across all your stores.
            Adjust the controls, run a forecast, then export or create a supplier order.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3" data-tour="inventory-forecaster-stats">
          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Reorder SKUs
            </div>
            <div
              className={cn(
                "mt-2 text-2xl font-semibold",
                headlineStats.reorderCount > 0 ? "text-emerald-400" : "text-foreground",
              )}
            >
              {headlineStats.reorderCount}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Units Suggested
            </div>
            <div
              className={cn(
                "mt-2 text-2xl font-semibold",
                headlineStats.totalSuggested > 0 ? "text-emerald-400" : "text-foreground",
              )}
            >
              {formatNumber(headlineStats.totalSuggested)}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Stockout Warnings
            </div>
            <div className="mt-2 text-2xl font-semibold text-foreground">
              {headlineStats.stockoutWarnings}
            </div>
          </div>
        </div>
      </div>

      <div className="mb-6 grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <section
          className="rounded-2xl border border-border bg-card p-5"
          data-tour="inventory-forecaster-controls"
        >
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Forecast Controls
            </h2>
          </div>

          <div className="space-y-5">
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">
                Sales History
              </label>
              <p className="mb-2 text-xs text-muted-foreground">How many days of past sales to analyze</p>
              <div className="grid grid-cols-4 gap-2">
                {(["90", "180", "365", "custom"] as const).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() =>
                      setControls((prev) => ({
                        ...prev,
                        lookbackDaysPreset: preset,
                        customLookbackDays:
                          preset === "custom" ? prev.customLookbackDays : preset,
                      }))
                    }
                    className={cn(
                      "rounded-lg border px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                      controls.lookbackDaysPreset === preset
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {preset === "custom" ? "Custom" : `${preset}d`}
                  </button>
                ))}
              </div>
              {controls.lookbackDaysPreset === "custom" && (
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={controls.customLookbackDays}
                  onChange={(event) =>
                    setControls((prev) => ({ ...prev, customLookbackDays: event.target.value }))
                  }
                  className="mt-2 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none"
                />
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">
                  Grouping
                </label>
                <p className="mb-2 text-xs text-muted-foreground">How to group sales data</p>
                <select
                  value={controls.forecastBucket}
                  onChange={(event) =>
                    setControls((prev) => ({
                      ...prev,
                      forecastBucket: event.target.value as "WEEKLY" | "DAILY",
                    }))
                  }
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none"
                >
                  <option value="WEEKLY">Weekly</option>
                  <option value="DAILY">Daily</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">
                  Shipping Time
                </label>
                <p className="mb-2 text-xs text-muted-foreground">Days for supplier to deliver</p>
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={controls.transitDays}
                  onChange={(event) =>
                    setControls((prev) => ({ ...prev, transitDays: event.target.value }))
                  }
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">
                Stock Coverage Goal
              </label>
              <p className="mb-2 text-xs text-muted-foreground">How many days of stock you want after the order arrives</p>
              <input
                type="number"
                min={0}
                max={730}
                value={controls.desiredCoverageDays}
                onChange={(event) =>
                  setControls((prev) => ({
                    ...prev,
                    desiredCoverageDays: event.target.value,
                  }))
                }
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none"
              />
            </div>

            <label className="flex items-start gap-3 rounded-xl border border-border bg-background/60 px-3 py-3 text-sm">
              <input
                type="checkbox"
                checked={controls.useOpenInTransit}
                onChange={(event) =>
                  setControls((prev) => ({
                    ...prev,
                    useOpenInTransit: event.target.checked,
                  }))
                }
                className="h-4 w-4"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2 font-medium text-foreground">
                  Subtract orders already on the way
                  <InfoBlurb text="When on, the forecast subtracts units from existing orders that are marked Ordered or In Transit. For example, if you need 40 units but 15 are already coming, the suggestion drops to about 25." />
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  Prevents double-ordering.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 rounded-xl border border-border bg-background/60 px-3 py-3 text-sm">
              <input
                type="checkbox"
                checked={controls.reorderRelevantOnly}
                onChange={(event) =>
                  setControls((prev) => ({
                    ...prev,
                    reorderRelevantOnly: event.target.checked,
                  }))
                }
                className="h-4 w-4"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2 font-medium text-foreground">
                  Only show SKUs that need attention
                  <InfoBlurb text="When on, SKUs that already have enough stock are hidden from the results. For example, if 2,000 SKUs exist but only 85 need reordering, you'll only see those 85." />
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  Hides well-stocked SKUs to keep the list focused.
                </span>
              </span>
            </label>

            <button
              type="button"
              onClick={() => void runForecast()}
              disabled={running}
              className={cn(
                "inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors cursor-pointer",
                "hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {running ? "Running Forecast..." : "Run Forecast"}
            </button>

            {running ? (
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-3">
                <div className="mb-2 flex items-center justify-between gap-3 text-[11px]">
                  <span className="font-medium text-emerald-300">
                    Crunching the numbers…
                  </span>
                  <span className="text-muted-foreground">
                    {remainingSeconds > 0
                      ? `About ${formatDuration(remainingSeconds)} left`
                      : "Wrapping up..."}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-background/80">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-primary via-primary to-emerald-400 transition-[width] duration-300 ease-out"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                  <span>{formatDuration(elapsedSeconds)} elapsed</span>
                  <span>Usually takes about {formatDuration(estimatedSeconds)}</span>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-5" data-tour="inventory-forecaster-summary">
          <div className="mb-4 flex items-center gap-2">
            <Boxes className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Overview
            </h2>
          </div>

          {statusMessage && (
            <div
              className={cn(
                "mb-4 rounded-xl border px-4 py-3 text-sm",
                statusMessage.type === "error"
                  ? "border-red-500/30 bg-red-500/10 text-red-300"
                  : statusMessage.type === "success"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-border bg-background/70 text-muted-foreground",
              )}
            >
              {statusMessage.text}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Where Data Comes From
              </div>
              <div className="mt-2 text-sm font-semibold text-emerald-400">
                Live TPP inventory + sales from all stores
              </div>
              <div className="mt-2 text-xs leading-5 text-muted-foreground">
                Current stock is pulled from The Perfect Part eBay. Sales data comes from all connected stores.
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-medium text-emerald-300">
                  Stock: TPP eBay
                </span>
                <span className="rounded-full border border-border bg-card px-2.5 py-1 font-medium text-muted-foreground">
                  eBay TPP
                </span>
                <span className="rounded-full border border-border bg-card px-2.5 py-1 font-medium text-muted-foreground">
                  eBay TT
                </span>
                <span className="rounded-full border border-border bg-card px-2.5 py-1 font-medium text-muted-foreground">
                  Shopify
                </span>
                <span className="rounded-full border border-border bg-card px-2.5 py-1 font-medium text-muted-foreground">
                  BigCommerce
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Sales Data Range
              </div>
              <div
                className={cn(
                  "mt-2 text-sm font-medium",
                  result?.salesSync.earliestCoveredAt ? "text-emerald-400" : "text-foreground",
                )}
              >
                {result?.salesSync.earliestCoveredAt
                  ? `${shortDate(result.salesSync.earliestCoveredAt)} — ${shortDate(result.salesSync.latestCoveredAt)}`
                  : "Run a forecast to see"}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Saved Runs
              </div>
              <div
                className={cn(
                  "mt-2 text-sm font-medium",
                  savedRunCount > 0 ? "text-emerald-400" : "text-foreground",
                )}
              >
                {savedRunCount}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                For reference only
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Open Orders
              </div>
              <div
                className={cn(
                  "mt-2 text-sm font-medium",
                  openOrderCount > 0 ? "text-emerald-400" : "text-foreground",
                )}
              >
                {openOrderCount}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                <span className="font-medium text-emerald-300">
                  {inboundCountedOrderCount}
                </span>{" "}
                counted as inbound in the forecast
              </div>
            </div>
          </div>

          {result?.salesSync.issues.length ? (
            <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-300">
                <AlertTriangle className="h-4 w-4" />
                Heads up
              </div>
              <div className="space-y-2 text-sm text-amber-100/90">
                {result.salesSync.issues.map((issue, index) => (
                  <p key={`${issue.platform}:${index}`}>
                    <span className="font-semibold">{issue.platform}</span>: {issue.message}
                  </p>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-4 rounded-2xl border border-border bg-background/60 p-4 text-sm text-muted-foreground">
            <div className="mb-2 font-semibold text-foreground">What the confidence levels mean</div>
            <div className="grid gap-2 md:grid-cols-3">
              {bootstrap?.confidenceLegend &&
                Object.entries(bootstrap.confidenceLegend).map(([level, text]) => (
                  <div key={level} className="rounded-xl border border-border bg-card px-3 py-3">
                    <div
                      className={cn(
                        "text-xs font-semibold uppercase tracking-[0.18em]",
                        confidenceTone(level as keyof BootstrapData["confidenceLegend"]),
                      )}
                    >
                      {level}
                    </div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">{text}</p>
                  </div>
                ))}
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-border bg-background/60 p-4">
            <div className="mb-4 flex items-center gap-2">
              <PackagePlus className="h-4 w-4 text-emerald-400" />
              <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Recent Internal Supplier Orders
              </h3>
            </div>
            <div className="overflow-hidden rounded-2xl border border-border bg-background/50">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[960px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left">
                      {["Order #", "Supplier", "Status", "Expected Arrival", "Units", "Lines", "From Run", "Created", "Notes"].map((label) => (
                        <th
                          key={label}
                          className="px-3 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground"
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {recentOrders.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-4 py-10 text-center">
                          <PackagePlus className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" />
                          <p className="text-sm text-muted-foreground">
                            No orders yet — run a forecast and click <span className="font-medium text-emerald-300">Create Order</span> to get started.
                          </p>
                        </td>
                      </tr>
                    ) : (
                      recentOrders.map((order) => (
                        <tr key={order.id} className="border-b border-border/60 align-top">
                          <td className="px-3 py-3 text-sm font-medium text-foreground" title={order.id}>
                            {order.id.length > 8 ? `…${order.id.slice(-8)}` : order.id}
                          </td>
                          <td className="px-3 py-3 text-sm text-foreground">
                            <input
                              key={`supplier-${order.id}-${order.supplier ?? ""}`}
                              defaultValue={order.supplier ?? ""}
                              onBlur={(event) => {
                                if (event.target.value !== (order.supplier ?? "")) {
                                  void patchOrder(order.id, { supplier: event.target.value || null });
                                }
                              }}
                              className="w-full rounded-lg border border-input bg-background px-2 py-1.5 text-sm text-foreground outline-none"
                            />
                          </td>
                          <td className="px-3 py-3">
                            <div
                              className={cn(
                                "mb-2 inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em]",
                                orderStatusBadgeClass(order.status),
                              )}
                            >
                              {order.status.replace(/_/g, " ")}
                            </div>
                            <select
                              value={order.status}
                              disabled={patchingOrderId === order.id}
                              onChange={(event) =>
                                void patchOrder(order.id, {
                                  status: event.target.value as SupplierOrderSummary["status"],
                                })
                              }
                              className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm text-foreground outline-none"
                            >
                              <option value="DRAFT">Draft</option>
                              <option value="ORDERED">Ordered</option>
                              <option value="IN_TRANSIT">In Transit</option>
                              <option value="RECEIVED">Received</option>
                              <option value="CANCELLED">Cancelled</option>
                            </select>
                          </td>
                          <td className="px-3 py-3 text-sm text-foreground">
                            <input
                              type="date"
                              key={`eta-${order.id}-${order.eta ?? ""}`}
                              defaultValue={order.eta ? order.eta.slice(0, 10) : ""}
                              onBlur={(event) => {
                                const currentEta = order.eta ? order.eta.slice(0, 10) : "";
                                if (event.target.value && event.target.value !== currentEta) {
                                  void patchOrder(order.id, {
                                    eta: new Date(event.target.value).toISOString(),
                                  });
                                }
                              }}
                              className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm text-foreground outline-none"
                            />
                          </td>
                          <td className="px-3 py-3 text-sm text-foreground">{formatNumber(order.totalUnits)}</td>
                          <td className="px-3 py-3 text-sm text-foreground">{formatNumber(order.lineCount)}</td>
                          <td className="px-3 py-3 text-sm text-muted-foreground" title={order.forecastRunId ?? undefined}>
                            {order.forecastRunId
                              ? order.forecastRunId.length > 8
                                ? `…${order.forecastRunId.slice(-8)}`
                                : order.forecastRunId
                              : "-"}
                          </td>
                          <td className="px-3 py-3 text-sm text-muted-foreground">{formatDateTime(order.createdAt)}</td>
                          <td className="px-3 py-3 text-sm text-muted-foreground">{order.notes ?? "-"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      </div>

      <section
        className="rounded-2xl border border-border bg-card p-5"
        data-tour="inventory-forecaster-results"
      >
        <div className="mb-4 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Forecast Results</h2>
            <p className="text-sm text-muted-foreground">
              One row per SKU. You can override any quantity — the Order Qty column always shows the number that will be used.
            </p>
          </div>
          <div className="flex flex-wrap gap-2" data-tour="inventory-forecaster-actions">
            <button
              type="button"
              onClick={() => void saveRunIfNeeded(true)}
              disabled={!result || savingRun}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {savingRun ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Run
            </button>
            <button
              type="button"
              onClick={() => void createOrder()}
              disabled={!result || creatingOrder}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creatingOrder ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <PackagePlus className="h-4 w-4" />
              )}
              Create Order
            </button>
            <button
              type="button"
              onClick={() => void exportWorkbook()}
              disabled={!result || exporting}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Export Excel
            </button>
          </div>
        </div>

        <div className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-4 text-sm text-muted-foreground">
            <div className="mb-2 flex items-center gap-2 font-semibold text-emerald-300">
              <Info className="h-3.5 w-3.5" />
              Quick guide
            </div>
            <ul className="space-y-2 text-xs leading-5">
              <li>
                <span className="font-medium text-foreground">Save Run</span> — saves a snapshot for reference. Does not create any orders.
              </li>
              <li>
                <span className="font-medium text-emerald-300">Create Order</span> — creates an internal supplier order using the draft info on the right.
                Future forecasts automatically subtract these units when the order is marked{" "}
                <span className="font-medium text-foreground">Ordered</span> or{" "}
                <span className="font-medium text-foreground">In Transit</span>.
              </li>
              <li>
                <span className="font-medium text-foreground">Export Excel</span> — downloads the full forecast as a spreadsheet with barcodes and images.
              </li>
              <li>
                To stop an order from counting as inbound, change its status to{" "}
                <span className="font-medium text-foreground">Received</span> or{" "}
                <span className="font-medium text-foreground">Cancelled</span>.
              </li>
            </ul>
          </div>
          <div className="rounded-2xl border border-border bg-background/60 p-4">
            <div className="mb-3 flex items-center gap-2">
              <Truck className="h-4 w-4 text-primary" />
              <div className="text-sm font-semibold text-foreground">Order Details</div>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              Fill this in before clicking Create Order above.
            </p>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Supplier Name</label>
                <input
                  value={supplier}
                  onChange={(event) => setSupplier(event.target.value)}
                  placeholder="e.g. Main warehouse, AliExpress, etc."
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Expected Arrival Date</label>
                <input
                  type="date"
                  value={orderEta}
                  onChange={(event) => setOrderEta(event.target.value)}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Notes (optional)</label>
                <textarea
                  value={orderNotes}
                  onChange={(event) => setOrderNotes(event.target.value)}
                  placeholder="Any internal notes about this order…"
                  rows={2}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-border bg-background/50">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1860px]">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left">
                  {[
                    "",
                    "Title",
                    "SKU",
                    "In Stock",
                    "Sales Summary",
                    "Needed While Shipping",
                    "Needed After Arrival",
                    "Safety Buffer",
                    "Total Need",
                    "Already Coming",
                    "Est. Stock on Arrival",
                    "Suggested",
                    "Your Override",
                    "Order Qty",
                    "Pattern",
                    "Model",
                    "Confidence",
                    "Warnings",
                  ].map((label) => (
                    <th
                      key={label}
                      className="px-3 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground"
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={18} className="px-4 py-12 text-center text-muted-foreground">
                      <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                    </td>
                  </tr>
                ) : !result ? (
                  <tr>
                    <td colSpan={18} className="px-4 py-16 text-center">
                      <Sparkles className="mx-auto mb-3 h-6 w-6 text-primary/50" />
                      <p className="text-sm font-medium text-foreground">No forecast yet</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Adjust the controls on the left, then click <span className="font-medium text-primary">Run Forecast</span> to see what needs reordering.
                      </p>
                    </td>
                  </tr>
                ) : effectiveLines.length === 0 ? (
                  <tr>
                    <td colSpan={18} className="px-4 py-16 text-center">
                      <Boxes className="mx-auto mb-3 h-6 w-6 text-emerald-400/50" />
                      <p className="text-sm font-medium text-foreground">All SKUs are well-stocked</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Nothing needs reordering right now. Uncheck &quot;Only show SKUs that need attention&quot; to see all SKUs.
                      </p>
                    </td>
                  </tr>
                ) : (
                  effectiveLines.map((line) => {
                    const inboundNote = noteForWarnings(line);
                    return (
                      <tr key={line.masterRowId} className="border-b border-border/60 align-top">
                        <td className="w-12 px-2 py-3">
                          {line.imageUrl ? (
                            <img
                              src={`/api/image-proxy?url=${encodeURIComponent(line.imageUrl)}`}
                              alt=""
                              className="h-10 w-10 rounded-lg border border-border object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-muted/30 text-xs text-muted-foreground">
                              —
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-medium text-foreground">{line.title}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{line.upc ?? "No UPC"}</div>
                        </td>
                        <td className="px-3 py-3 text-sm text-foreground">{line.sku}</td>
                        <td className="px-3 py-3 text-sm text-foreground">{formatNumber(line.currentInventory)}</td>
                        <td className="px-3 py-3 text-sm text-muted-foreground">{line.salesHistorySummary}</td>
                        <td className="px-3 py-3 text-sm text-foreground">{formatQty(line.transitDemand)}</td>
                        <td className="px-3 py-3 text-sm text-foreground">{formatQty(line.postArrivalDemand)}</td>
                        <td className="px-3 py-3 text-sm text-foreground">{formatQty(line.safetyBuffer)}</td>
                        <td className="px-3 py-3 text-sm text-foreground">{formatQty(line.grossRequiredQty)}</td>
                        <td className="px-3 py-3">
                          <div className="text-sm text-foreground">{formatNumber(line.openInTransitQty)}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {line.openInTransitEta ? shortDate(line.openInTransitEta) : "-"}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-sm text-foreground">
                          {formatQty(line.projectedStockOnArrival)}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-3 text-sm font-medium",
                            line.recommendedQty > 0 ? "text-emerald-300" : "text-foreground",
                          )}
                        >
                          {formatNumber(line.recommendedQty)}
                        </td>
                        <td className="px-3 py-3">
                          <input
                            type="number"
                            min={0}
                            value={overrideMap[line.masterRowId] ?? ""}
                            onChange={(event) =>
                              setOverrideMap((prev) => {
                                setSavedRunId(null);
                                return {
                                  ...prev,
                                  [line.masterRowId]: event.target.value,
                                };
                              })
                            }
                            placeholder="-"
                            className={cn(
                              "w-24 rounded-lg border px-2 py-1.5 text-sm text-foreground outline-none",
                              line.overrideQty != null
                                ? "border-violet-500/50 bg-violet-500/10"
                                : "border-input bg-background",
                            )}
                          />
                        </td>
                        <td className="px-3 py-3">
                          <div
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-semibold",
                              line.overrideQty != null
                                ? "border border-violet-500/30 bg-violet-500/10 text-violet-300"
                                : line.finalQty > 0
                                  ? "text-emerald-400"
                                  : "text-primary",
                            )}
                          >
                            {formatNumber(line.finalQty)}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-sm text-foreground">
                          {patternLabel(line.demandPattern)}
                        </td>
                        <td className="px-3 py-3 text-sm text-foreground">{line.modelUsed}</td>
                        <td className="px-3 py-3">
                          <div className="rounded-lg border border-border bg-background px-2 py-2 text-sm text-foreground">
                            <div className="font-semibold">{line.confidence}</div>
                            <div className="mt-1 text-xs text-muted-foreground">{line.confidenceNote}</div>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-2">
                            {line.warningFlags.map((flag) => (
                              <span
                                key={flag}
                                className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-200"
                              >
                                {warningChip(flag)}
                              </span>
                            ))}
                          </div>
                          {inboundNote ? (
                            <div className="mt-2 text-xs font-medium text-emerald-300">
                              {inboundNote}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <PageTour page="inventoryForecaster" steps={PAGE_TOUR_STEPS.inventoryForecaster} ready />
    </div>
  );
}
