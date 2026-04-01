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
import { PLATFORM_FULL, PLATFORM_SHORT } from "@/lib/grid-types";
import type {
  RevenueKpiMetric,
  RevenuePageData,
  RevenueRangePreset,
  RevenueSimpleWindow,
} from "@/lib/revenue";
import { PlatformIcon } from "@/components/grid/platform-icon";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";

const PIE_COLORS = ["#8b5cf6", "#22c55e", "#f59e0b", "#38bdf8"];

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

async function parseJson<T>(response: Response) {
  const json = (await response.json()) as { error?: string; data?: T };
  if (!response.ok) {
    throw new Error(json.error ?? "Request failed");
  }
  return json.data as T;
}

function KpiCard(props: { label: string; metric: RevenueKpiMetric }) {
  const { label, metric } = props;
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
          <p className="mt-2 text-2xl font-semibold text-foreground">
            {label === "Orders" ? (metric.value ?? 0).toLocaleString() : formatCurrency(metric.value)}
          </p>
        </div>
        <span
          className={`rounded-full border px-2 py-1 text-[10px] font-semibold uppercase ${
            metric.exact
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border-amber-500/30 bg-amber-500/10 text-amber-200"
          }`}
        >
          {metric.exact ? "Exact" : "Partial"}
        </span>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {metric.deltaPercent == null ? "No prior comparison" : `${formatPercent(metric.deltaPercent)} vs prior period`}
      </p>
      {metric.unavailableReason ? (
        <p className="mt-2 text-xs text-amber-200">{metric.unavailableReason}</p>
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
  const [data, setData] = useState<RevenuePageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [banner, setBanner] = useState<string>("");
  const requestIdRef = useRef(0);

  const queryRange = useMemo(() => {
    const fallback = rangeFromPreset(preset === "custom" ? "30d" : preset);
    const fromDate = new Date(`${(preset === "custom" ? customFrom : fallback.from) || fallback.from}T00:00:00`);
    const toDate = new Date(`${(preset === "custom" ? customTo : fallback.to) || fallback.to}T23:59:59`);
    return { fromDate, toDate };
  }, [customFrom, customTo, preset]);

  const load = useCallback(async (options?: { silent?: boolean }) => {
    const requestId = ++requestIdRef.current;
    if (!options?.silent) {
      setLoading(true);
    }
    setError("");

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
      const response = await fetch(`/api/revenue?${params.toString()}`, { cache: "no-store" });
      const nextData = await parseJson<RevenuePageData>(response);
      if (requestId !== requestIdRef.current) return;
      setData(nextData);
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load revenue");
      setData(null);
    } finally {
      if (requestId === requestIdRef.current && !options?.silent) {
        setLoading(false);
      }
    }
  }, [buyerWindow, granularity, itemWindow, preset, queryRange.fromDate, queryRange.toDate, selectedPlatforms]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!syncing) return undefined;
    const timer = window.setInterval(() => {
      void load({ silent: true });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [load, syncing]);

  async function handleManualRefresh() {
    setSyncing(true);
    setBanner("Refreshing revenue data. This can take a few minutes for eBay. Watch Refresh Status below for live job updates.");
    setError("");

    try {
      const platforms =
        selectedPlatforms.length > 0
          ? selectedPlatforms
          : data?.integrations.map((integration) => integration.platform) ?? [];
      const response = await fetch("/api/revenue/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: queryRange.fromDate.toISOString(),
          to: queryRange.toDate.toISOString(),
          platforms,
        }),
      });
      const result = await parseJson<{ warnings: string[] }>(response);
      setBanner(
        result.warnings.length > 0
          ? `Revenue refresh finished with notes: ${result.warnings[0]}`
          : "Revenue data refreshed.",
      );
      await load();
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

  const kpis = data?.kpis;
  const hasTrendData = Boolean(data?.trend.some((point) => point.grossRevenue > 0));
  const hasStoreChartData = Boolean(data?.storeBreakdown.some((row) => row.grossRevenue > 0));
  const hasFeeChartData = Boolean(data?.feeBreakdown.some((row) => row.amount > 0));
  const hasShareData = Boolean(data?.revenueShare.some((row) => row.grossRevenue > 0));

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
          {data ? (
            <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  data.mode === "ebay_exact" ? "bg-emerald-400" : "bg-amber-300"
                }`}
              />
              {data.mode === "ebay_exact" ? "eBay Exact Mode" : "Normalized Operational Mode"}
            </div>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            Last refresh: {formatDateTime(data?.syncSummary.latestCompletedAt ?? null)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleManualRefresh()}
          disabled={syncing}
          className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
        >
          {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {syncing ? "Refreshing Revenue Data..." : "Refresh Revenue Data"}
        </button>
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
            {data?.integrations.map((integration) => (
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
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex min-h-[40vh] items-center justify-center rounded-xl border border-border bg-card">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : null}

      {!loading && data && kpis ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" data-tour="revenue-summary">
            <KpiCard label="Gross Revenue" metric={kpis.grossRevenue} />
            <KpiCard label="Net Revenue" metric={kpis.netRevenue} />
            <KpiCard label="Marketplace Fees" metric={kpis.marketplaceFees} />
            <KpiCard label="Advertising Fees" metric={kpis.advertisingFees} />
            <KpiCard label="Tax Collected" metric={kpis.taxCollected} />
            <KpiCard label="Shipping Collected" metric={kpis.shippingCollected} />
            {data.mode === "ebay_exact" ? (
              <>
                <KpiCard label="Shipping Labels" metric={kpis.shippingLabels} />
                <KpiCard label="Account-Level Fees" metric={kpis.accountLevelFees} />
              </>
            ) : null}
            <KpiCard label="Orders" metric={kpis.orderCount} />
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
                    {data.topBuyers.map((buyer) => (
                      <tr key={buyer.buyerKey} className="border-t border-border/70">
                        <td className="py-3 pr-4">
                          <div className="font-medium text-foreground">{buyer.buyerName ?? buyer.buyerLabel}</div>
                          <div className="text-xs text-muted-foreground">Buyer ID: {buyer.buyerIdentifier}</div>
                          <div className="text-xs text-muted-foreground">{buyer.buyerEmail ?? "No email provided"}</div>
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground">
                          <div className="flex flex-wrap items-center gap-2">
                            {buyer.platforms.map((platform) => (
                              <span key={`${buyer.buyerKey}-${platform}`} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
                                <PlatformIcon platform={platform} size={14} />
                                {PLATFORM_SHORT[platform]}
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
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">Top Items Sold</h2>
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
                    {data.topItems.map((item) => (
                      <tr key={item.sku} className="border-t border-border/70">
                        <td className="py-3 pr-4">
                          <div className="font-medium text-foreground">{item.sku}</div>
                          <div className="text-xs text-muted-foreground">{item.title ?? "Untitled item"}</div>
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground">
                          <div className="flex flex-wrap items-center gap-2">
                            {item.platforms.map((platform) => (
                              <span key={`${item.sku}-${platform}`} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
                                <PlatformIcon platform={platform} size={14} />
                                {PLATFORM_SHORT[platform]}
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
                          <div className="text-xs text-muted-foreground">{store.exactFeeCoverage ? "Exact fee coverage" : "Partial fee coverage"}</div>
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
