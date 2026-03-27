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
  if (flag === "SUSPECTED_STOCKOUT") return "Suspected stockout-distorted history";
  if (flag === "LIMITED_HISTORY") return "New item / limited history";
  if (flag === "IN_TRANSIT_EXISTS") return "In-transit already exists";
  if (flag === "EBAY_HISTORY_TRUNCATED") return "eBay history still building";
  return "No sales history";
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
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
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
        setStatusMessage(
          error instanceof Error ? error.message : "Failed to load Inventory Forecaster.",
        );
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
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Failed to run forecast");
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
      setStatusMessage(
        `Forecast ready for ${forecast.lines.length} SKU${forecast.lines.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to run Inventory Forecast.",
      );
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
      setStatusMessage(`Forecast run saved with ${payload.lines.length} lines.`);
      return runId;
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to save run.");
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
      setStatusMessage(`Supplier order ${json.data.id} created with ${json.data.lineCount} lines.`);

      const refresh = await fetch("/api/inventory-forecaster", { cache: "no-store" });
      const refreshJson = await refresh.json();
      if (refresh.ok) {
        setRecentOrders((refreshJson.data as BootstrapData).recentOrders ?? []);
      }
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to create supplier order.",
      );
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
      setStatusMessage("Forecast workbook exported.");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to export workbook.",
      );
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
      setStatusMessage(`Supplier order ${orderId} updated.`);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to update supplier order.",
      );
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
            Read-only marketplace demand planning across eBay TPP, eBay TT, Shopify, and
            BigCommerce using one deduped live master inventory quantity per SKU.
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
              <label className="mb-2 block text-sm font-medium text-foreground">
                Lookback Window
              </label>
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
                <label className="mb-2 block text-sm font-medium text-foreground">
                  Forecast Bucket
                </label>
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
                <label className="mb-2 block text-sm font-medium text-foreground">
                  Supplier Transit Days
                </label>
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
              <label className="mb-2 block text-sm font-medium text-foreground">
                Desired Inventory Days After Arrival
              </label>
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
                  Count incoming supplier orders that are already on the way
                  <InfoBlurb text="Turn this on to subtract internal supplier orders that are already marked Ordered or In Transit. Example: if the forecast says you need 40 units, and 15 units are already on the way with an ETA that arrives in time, the new recommendation becomes about 25 instead of 40." />
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  Prevents double-ordering by counting units already expected to arrive soon.
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
                  Only show SKUs that need attention right now
                  <InfoBlurb text="Turn this on to hide SKUs that are already covered. A SKU is usually considered 'no action needed' when projected stock on arrival, plus any qualifying inbound units, already covers expected demand and safety buffer, so required quantity stays at 0. Example: if 2,000 SKUs exist but only 85 need action, this keeps the table focused on those 85." />
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  Hides fully-covered SKUs whose projected stock after arrival already meets demand.
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
                    Estimated progress
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
                  <span>Typical run: {formatDuration(estimatedSeconds)}</span>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-5" data-tour="inventory-forecaster-summary">
          <div className="mb-4 flex items-center gap-2">
            <Boxes className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Run Summary
            </h2>
          </div>

          {statusMessage && (
            <div className="mb-4 rounded-xl border border-border bg-background/70 px-4 py-3 text-sm text-muted-foreground">
              {statusMessage}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Inventory Source
              </div>
              <div className="mt-2 text-lg font-semibold text-emerald-400">
                Live TPP master inventory
              </div>
              <div className="mt-2 text-xs leading-5 text-muted-foreground">
                Uses the live on-hand quantity from The Perfect Part eBay master rows as the base inventory number for each SKU.
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-medium text-emerald-300">
                  Base stock: TPP eBay live
                </span>
                <span className="rounded-full border border-border bg-card px-2.5 py-1 font-medium text-muted-foreground">
                  Sales: eBay TPP
                </span>
                <span className="rounded-full border border-border bg-card px-2.5 py-1 font-medium text-muted-foreground">
                  Sales: eBay TT
                </span>
                <span className="rounded-full border border-border bg-card px-2.5 py-1 font-medium text-muted-foreground">
                  Sales: Shopify
                </span>
                <span className="rounded-full border border-border bg-card px-2.5 py-1 font-medium text-muted-foreground">
                  Sales: BigCommerce
                </span>
              </div>
              <div className="mt-3 text-xs leading-5 text-muted-foreground">
                Internal label:{" "}
                <span className="font-medium text-foreground">
                  {bootstrap?.inventorySource ?? "MASTER_TPP_LIVE"}
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Sales Coverage
              </div>
              <div
                className={cn(
                  "mt-2 text-sm font-medium",
                  result?.salesSync.earliestCoveredAt ? "text-emerald-400" : "text-foreground",
                )}
              >
                {result?.salesSync.earliestCoveredAt
                  ? `${shortDate(result.salesSync.earliestCoveredAt)} to ${shortDate(result.salesSync.latestCoveredAt)}`
                  : "Run forecast to calculate"}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Recent Saved Runs
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
                Saved runs are snapshots only.
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Open Internal Orders
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
                currently affect forecast math.
              </div>
            </div>
          </div>

          {result?.salesSync.issues.length ? (
            <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-300">
                <AlertTriangle className="h-4 w-4" />
                Sales sync notes
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
            <div className="mb-2 font-semibold text-foreground">Confidence guide</div>
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
                      {["Order", "Supplier", "Status", "ETA", "Units", "Lines", "Forecast Run", "Created", "Notes"].map((label) => (
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
                        <td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">
                          No internal supplier orders yet.
                        </td>
                      </tr>
                    ) : (
                      recentOrders.map((order) => (
                        <tr key={order.id} className="border-b border-border/60 align-top">
                          <td className="px-3 py-3 text-sm font-medium text-foreground">{order.id}</td>
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
                          <td className="px-3 py-3 text-sm text-muted-foreground">{order.forecastRunId ?? "-"}</td>
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
              One row per SKU. Required Quantity to Order uses the final effective quantity:
              override if present, otherwise system recommendation.
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

        <div className="mb-5 rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-4 text-sm text-muted-foreground">
          <div className="mb-2 font-semibold text-emerald-300">How saved runs and incoming orders work</div>
          <p>
            <span className="font-medium text-foreground">Save Run</span> stores a forecast snapshot for reference only.
            It does <span className="font-medium text-foreground">not</span> create inbound inventory.
          </p>
          <p className="mt-2">
            <span className="font-medium text-emerald-300">Create Order</span> creates an internal supplier order. Future
            forecasts subtract those units only when the order status is{" "}
            <span className="font-medium text-foreground">Ordered</span> or{" "}
            <span className="font-medium text-foreground">In Transit</span> and the ETA is inside the arrival window.
          </p>
          <p className="mt-2">
            If an order should stop counting, change it to{" "}
            <span className="font-medium text-foreground">Cancelled</span> or{" "}
            <span className="font-medium text-foreground">Received</span>. Those stay in history but no longer count as inbound.
          </p>
        </div>

        <div className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="grid gap-4">
            <div className="rounded-2xl border border-border bg-background/60 p-4 text-sm text-muted-foreground">
              <div className="mb-2 font-semibold text-emerald-300">Open in-transit supplier order info</div>
              The forecaster subtracts open internal supplier orders only when they are marked
              <span className="font-medium text-foreground"> Ordered</span> or
              <span className="font-medium text-foreground"> In Transit</span> and the ETA lands on or before the arrival window.
            </div>
            <div className="rounded-2xl border border-border bg-background/60 p-4 text-sm text-muted-foreground">
              <div className="mb-3 font-semibold text-emerald-300">What these controls do</div>
              <div className="grid gap-3 lg:grid-cols-3">
                <div className="rounded-xl border border-border bg-card/70 p-3">
                  <div className="text-sm font-semibold text-foreground">Forecast Bucket</div>
                  <p className="mt-2 text-xs leading-5">
                    <span className="font-medium text-foreground">Weekly</span> groups demand into week-sized chunks.
                    Best for most purchasing decisions because it smooths noisy day-to-day spikes.
                  </p>
                  <p className="mt-2 text-xs leading-5">
                    <span className="font-medium text-foreground">Daily</span> looks at day-level demand.
                    Best when you want tighter timing on fast movers or short lead-time items.
                  </p>
                  <p className="mt-2 text-xs leading-5">
                    Example: if a SKU sells 28 units in 4 weeks, weekly sees about 7 per week. Daily sees about 1 per day.
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-card/70 p-3">
                  <div className="text-sm font-semibold text-foreground">
                    Use open in-transit supplier orders in calculations
                  </div>
                  <p className="mt-2 text-xs leading-5">
                    When this is on, the forecaster subtracts incoming units that are already on the way, so it does not over-order.
                  </p>
                  <p className="mt-2 text-xs leading-5">
                    Example: if you need 40 units and already have 15 marked{" "}
                    <span className="font-medium text-emerald-300">Ordered</span> or{" "}
                    <span className="font-medium text-emerald-300">In Transit</span>, the new recommendation drops to about 25.
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-card/70 p-3">
                  <div className="text-sm font-semibold text-foreground">
                    Show only reorder-relevant SKUs
                  </div>
                  <p className="mt-2 text-xs leading-5">
                    When this is on, you only see SKUs that need attention now, such as items with a positive required quantity or important warnings.
                  </p>
                  <p className="mt-2 text-xs leading-5">
                    Example: if 2,000 SKUs are fine and only 85 need action, this keeps the list focused on the 85.
                  </p>
                </div>
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-background/60 p-4">
            <div className="mb-3 flex items-center gap-2">
              <Truck className="h-4 w-4 text-primary" />
              <div className="text-sm font-semibold text-foreground">Internal Supplier Order Draft</div>
            </div>
            <div className="space-y-3">
              <input
                value={supplier}
                onChange={(event) => setSupplier(event.target.value)}
                placeholder="Supplier name"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none"
              />
              <input
                type="date"
                value={orderEta}
                onChange={(event) => setOrderEta(event.target.value)}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none"
              />
              <textarea
                value={orderNotes}
                onChange={(event) => setOrderNotes(event.target.value)}
                placeholder="Internal notes"
                rows={3}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none"
              />
              <div className="text-xs text-muted-foreground">
                Draft orders stay visible here, but only{" "}
                <span className="font-medium text-emerald-300">Ordered</span> and{" "}
                <span className="font-medium text-emerald-300">In Transit</span> subtract from future forecasts.
              </div>
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-border bg-background/50">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1800px]">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left">
                  {[
                    "Title",
                    "SKU",
                    "Current Stock",
                    "Sales Summary",
                    "Transit Demand",
                    "Post-Arrival Demand",
                    "Safety Buffer",
                    "Gross Need",
                    "Inbound",
                    "Projected On Arrival",
                    "Recommended",
                    "Override",
                    "Required Qty",
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
                    <td colSpan={17} className="px-4 py-12 text-center text-muted-foreground">
                      <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                    </td>
                  </tr>
                ) : !result ? (
                  <tr>
                    <td colSpan={17} className="px-4 py-12 text-center text-muted-foreground">
                      Run a forecast to see replenishment recommendations.
                    </td>
                  </tr>
                ) : effectiveLines.length === 0 ? (
                  <tr>
                    <td colSpan={17} className="px-4 py-12 text-center text-muted-foreground">
                      No SKUs matched the current filter set.
                    </td>
                  </tr>
                ) : (
                  effectiveLines.map((line) => {
                    const inboundNote = noteForWarnings(line);
                    return (
                      <tr key={line.masterRowId} className="border-b border-border/60 align-top">
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
                            className="w-24 rounded-lg border border-input bg-background px-2 py-1.5 text-sm text-foreground outline-none"
                          />
                        </td>
                        <td
                          className={cn(
                            "px-3 py-3 text-sm font-semibold",
                            line.finalQty > 0 ? "text-emerald-400" : "text-primary",
                          )}
                        >
                          {formatNumber(line.finalQty)}
                        </td>
                        <td className="px-3 py-3 text-sm text-foreground">
                          {line.demandPattern.replace(/_/g, " ")}
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
