"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Brush,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";

const CHANNEL_KEYS = [
  "CLIENT_API_RESPONSE",
  "MARKETPLACE_INBOUND",
  "SYNC_JOB",
  "FORECAST",
  "OTHER",
] as const;

const CHANNEL_LABEL: Record<(typeof CHANNEL_KEYS)[number], string> = {
  CLIENT_API_RESPONSE: "API responses (e.g. grid JSON, Chrome extension zip, lookup-item)",
  MARKETPLACE_INBOUND: "Marketplace HTTP (eBay response bodies, sync)",
  /** One category for all pull-sync telemetry; each row’s Label + Result say completed vs failed. */
  SYNC_JOB: "Pull sync jobs",
  FORECAST: "Inventory Forecaster (page load, runs, Excel, saves, order export)",
  OTHER: "Other",
};

/** Shorter legend text (Recharts legend is narrow). */
const CHANNEL_LEGEND_LABEL: Record<(typeof CHANNEL_KEYS)[number], string> = {
  CLIENT_API_RESPONSE: "API responses (grid, extension)",
  MARKETPLACE_INBOUND: "Marketplace HTTP (eBay)",
  SYNC_JOB: "Pull syncs",
  FORECAST: "Forecaster",
  OTHER: "Other",
};

function syncResultFromMetadata(
  channel: string,
  meta: unknown,
): "Completed" | "Failed" | null {
  if (channel !== "SYNC_JOB") return null;
  if (!meta || typeof meta !== "object") return null;
  const st = (meta as Record<string, unknown>).status;
  if (st === "COMPLETED") return "Completed";
  if (st === "FAILED") return "Failed";
  return null;
}

const CHANNEL_STROKE: Record<(typeof CHANNEL_KEYS)[number], string> = {
  CLIENT_API_RESPONSE: "hsl(262, 83%, 68%)",
  MARKETPLACE_INBOUND: "hsl(199, 89%, 48%)",
  SYNC_JOB: "hsl(142, 71%, 45%)",
  FORECAST: "hsl(38, 92%, 50%)",
  OTHER: "hsl(215, 20%, 55%)",
};

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatNyTime(iso: string, bucket: "hour" | "day"): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    ...(bucket === "hour"
      ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", year: "numeric" }),
  }).format(d);
}

/** Recharts default Brush traveller draws white lines on a stroke-colored rect — theme-aware handles. */
function NetworkBrushTraveller(props: { x: number; y: number; width: number; height: number }) {
  const { x, y, width, height } = props;
  const lineY = Math.floor(y + height / 2) - 1;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill="var(--card)"
        stroke="var(--border)"
        strokeWidth={1}
        rx={3}
      />
      <line
        x1={x + 2}
        y1={lineY}
        x2={x + width - 2}
        y2={lineY}
        stroke="var(--muted-foreground)"
        strokeWidth={1.5}
      />
      <line
        x1={x + 2}
        y1={lineY + 2}
        x2={x + width - 2}
        y2={lineY + 2}
        stroke="var(--muted-foreground)"
        strokeWidth={1.5}
      />
    </g>
  );
}

type RangePreset = "24h" | "7d" | "30d";

type ApiPayload = {
  retentionDays: number;
  prunedCount: number;
  range: { from: string; to: string; bucket: "hour" | "day" };
  chartSeries: Record<string, string | number>[];
  totalsByChannel: { channel: string; eventCount: number; bytesSum: number }[];
  samples: {
    id: string;
    createdAt: string;
    channel: string;
    label: string;
    bytesEstimate: number | null;
    durationMs: number | null;
    metadata: unknown;
    integration: { id: string; platform: string; label: string } | null;
  }[];
  pagination: { page: number; totalPages: number };
};

export default function PublicNetworkTransferPage() {
  const [preset, setPreset] = useState<RangePreset>("7d");
  const [channelFilter, setChannelFilter] = useState<string>("");
  const [searchLabel, setSearchLabel] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [data, setData] = useState<ApiPayload | null>(null);

  const rangeParams = useMemo(() => {
    const to = new Date();
    const from = new Date(to);
    if (preset === "24h") from.setHours(from.getHours() - 24);
    else if (preset === "7d") from.setDate(from.getDate() - 7);
    else from.setDate(from.getDate() - 30);
    const bucket: "hour" | "day" = preset === "30d" ? "day" : "hour";
    return { from: from.toISOString(), to: to.toISOString(), bucket };
  }, [preset]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const qs = new URLSearchParams({
        from: rangeParams.from,
        to: rangeParams.to,
        bucket: rangeParams.bucket,
        page: String(page),
      });
      if (channelFilter) qs.set("channel", channelFilter);
      const res = await fetch(`/api/network-transfer?${qs.toString()}`, { cache: "no-store" });
      if (res.status === 403) {
        setForbidden(true);
        setData(null);
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(typeof j.error === "string" ? j.error : "Failed to load");
      }
      const json = await res.json();
      setData(json.data as ApiPayload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [rangeParams.from, rangeParams.to, rangeParams.bucket, page, channelFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredSamples = useMemo(() => {
    if (!data?.samples) return [];
    const q = searchLabel.trim().toLowerCase();
    if (!q) return data.samples;
    return data.samples.filter((s) => s.label.toLowerCase().includes(q));
  }, [data?.samples, searchLabel]);

  const chartData = useMemo(() => {
    if (!data?.chartSeries) return [];
    return data.chartSeries.map((row) => ({
      ...row,
      labelNy: formatNyTime(String(row.bucketStart), data.range.bucket),
    }));
  }, [data?.chartSeries, data?.range.bucket]);

  if (forbidden) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg font-medium text-foreground">Admins only</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Public Network Transfer shows operational telemetry. Ask an admin if you need access.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-4 md:p-6" data-tour="network-transfer-root">
      <PageTour page="publicNetworkTransfer" steps={PAGE_TOUR_STEPS.publicNetworkTransfer} />

      <div className="flex flex-col gap-2 border-b border-border pb-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">
            Public Network Transfer
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            App-measured activity that correlates with database and API traffic — not Neon’s billing meter.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </button>
      </div>

      <div
        data-tour="network-transfer-disclaimer"
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-foreground"
      >
        <strong className="font-semibold">How to read this page:</strong> These are{" "}
        <strong>estimates</strong> from reorG (JSON and binary response sizes — grid, Chrome extension zip,
        lookup-item, etc. — eBay HTTP bodies during sync, plus{" "}
        <strong>pull sync job</strong> rows for timing and item counts). Neon’s invoice uses its own
        network accounting — numbers here will not match exactly.{" "}
        <strong>Pull sync jobs</strong> do not carry a byte estimate (they show “—” and 0 B on the chart)
        because we record duration and processed counts, not total download size. The{" "}
        <strong>Result</strong> column shows Completed vs Failed; successful BigCommerce/eBay/Shopify syncs
        still appear under Pull sync jobs — that category means “a sync run was recorded,” not “something
        failed.” If you still see an older channel name like “Sync jobs completed / failed,” refresh after
        deploy — that wording grouped both outcomes in one bucket; it did not mean every row failed.{" "}
        <strong>Inventory Forecaster</strong> rows appear when you open the forecaster, run a forecast,
        export or save, or load supplier-order Excel data — read the <strong>Label</strong> column for the
        exact action. Samples older than {data?.retentionDays ?? 10} days are pruned automatically.
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div
        data-tour="network-transfer-controls"
        className="flex flex-wrap items-center gap-3 text-sm"
      >
        <span className="text-muted-foreground">Range:</span>
        {(["24h", "7d", "30d"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              setPreset(p);
              setPage(1);
            }}
            className={cn(
              "cursor-pointer rounded-md px-3 py-1.5 font-medium transition-colors",
              preset === p
                ? "bg-primary text-primary-foreground"
                : "bg-muted/60 text-muted-foreground hover:text-foreground",
            )}
          >
            {p === "24h" ? "24 hours" : p === "7d" ? "7 days" : "30 days"}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-2 text-muted-foreground">
          Log channel
          <select
            value={channelFilter}
            onChange={(e) => {
              setChannelFilter(e.target.value);
              setPage(1);
            }}
            className="cursor-pointer rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
          >
            <option value="">All</option>
            {CHANNEL_KEYS.map((k) => (
              <option key={k} value={k}>
                {CHANNEL_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading && !data ? (
        <div className="flex flex-1 items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div
            data-tour="network-transfer-chart"
            className="rounded-xl border border-border bg-card p-4 shadow-sm"
          >
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Estimated bytes by time bucket
            </h2>
            <p className="mb-4 text-xs text-muted-foreground">
              {chartData.length >= 2
                ? "Stacked areas — use the slim range bar under the chart to zoom (theme-colored, not white). Hover points for details."
                : "Only one time bucket in this range so far — the chart will fill in as more activity is recorded. Hover the point for details."}
            </p>
            <div className="h-[400px] w-full min-w-0 [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-legend-item-text]:fill-muted-foreground">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={chartData}
                  margin={{ top: 8, right: 16, left: 4, bottom: chartData.length >= 2 ? 4 : 8 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--border)"
                    strokeOpacity={0.45}
                    vertical={false}
                  />
                  <XAxis
                    dataKey="labelNy"
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    interval="preserveStartEnd"
                    minTickGap={28}
                    padding={{ left: 24, right: 24 }}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickFormatter={(v) => formatBytes(Number(v))}
                    width={72}
                  />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const row = payload[0]?.payload as Record<string, unknown>;
                      const iso = row?.bucketStart;
                      return (
                        <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
                          <div className="font-semibold text-popover-foreground">{String(label)}</div>
                          {typeof iso === "string" && (
                            <div className="text-muted-foreground">UTC: {iso}</div>
                          )}
                          <ul className="mt-2 space-y-1">
                            {CHANNEL_KEYS.map((k) => {
                              const v = Number(row[k] ?? 0);
                              if (v <= 0) return null;
                              return (
                                <li key={k} className="flex justify-between gap-4">
                                  <span style={{ color: CHANNEL_STROKE[k] }}>{CHANNEL_LABEL[k]}</span>
                                  <span className="font-mono">{formatBytes(v)}</span>
                                </li>
                              );
                            })}
                            <li className="flex justify-between gap-4 border-t border-border pt-1 font-semibold">
                              <span>Total</span>
                              <span className="font-mono">{formatBytes(Number(row.totalBytes ?? 0))}</span>
                            </li>
                          </ul>
                        </div>
                      );
                    }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11, color: "var(--muted-foreground)" }}
                    formatter={(value) =>
                      CHANNEL_LEGEND_LABEL[value as (typeof CHANNEL_KEYS)[number]] ?? value
                    }
                  />
                  {CHANNEL_KEYS.map((k, i) => (
                    <Area
                      key={k}
                      type="monotone"
                      dataKey={k}
                      stackId="1"
                      stroke={CHANNEL_STROKE[k]}
                      fill={CHANNEL_STROKE[k]}
                      fillOpacity={0.35 - i * 0.04}
                      name={k}
                      isAnimationActive={chartData.length < 80 && chartData.length > 1}
                      dot={
                        chartData.length <= 8
                          ? { r: 3, strokeWidth: 1, stroke: CHANNEL_STROKE[k], fill: CHANNEL_STROKE[k] }
                          : false
                      }
                      activeDot={{ r: 5 }}
                    />
                  ))}
                  {chartData.length >= 2 ? (
                    <Brush
                      dataKey="labelNy"
                      height={22}
                      stroke="var(--primary)"
                      fill="var(--muted)"
                      travellerWidth={9}
                      traveller={NetworkBrushTraveller}
                      tickFormatter={() => ""}
                      ariaLabel="Zoom chart time range"
                    />
                  ) : null}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {data && data.totalsByChannel.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.totalsByChannel.map((t) => (
                <div
                  key={t.channel}
                  className="rounded-lg border border-border bg-card px-4 py-3 text-sm shadow-sm"
                >
                  <div className="text-muted-foreground">
                    {CHANNEL_LABEL[t.channel as (typeof CHANNEL_KEYS)[number]] ?? t.channel}
                  </div>
                  <div className="mt-1 font-mono text-lg font-semibold text-foreground">
                    {formatBytes(t.bytesSum)}
                  </div>
                  {t.channel === "SYNC_JOB" && t.bytesSum === 0 ? (
                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                      No byte estimate for this channel — open the log for duration and item counts.
                    </p>
                  ) : null}
                  <div className="text-xs text-muted-foreground">{t.eventCount} events</div>
                </div>
              ))}
            </div>
          )}

          <div
            data-tour="network-transfer-table"
            className="min-h-0 flex-1 rounded-xl border border-border bg-card shadow-sm"
          >
            <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Event log
              </h2>
              <input
                type="search"
                placeholder="Filter by label…"
                value={searchLabel}
                onChange={(e) => setSearchLabel(e.target.value)}
                className="w-full max-w-xs rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground sm:w-72"
              />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Time (NY)</th>
                    <th className="px-3 py-2 font-medium">UTC ISO</th>
                    <th className="px-3 py-2 font-medium">Channel</th>
                    <th className="px-3 py-2 font-medium">Result</th>
                    <th className="px-3 py-2 font-medium">Label</th>
                    <th className="px-3 py-2 font-medium">Bytes (est.)</th>
                    <th className="px-3 py-2 font-medium">Duration</th>
                    <th className="px-3 py-2 font-medium">Store</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSamples.map((s) => (
                    <tr key={s.id} className="border-b border-border/80 hover:bg-muted/20">
                      <td className="whitespace-nowrap px-3 py-2 text-foreground">
                        {formatNyTime(s.createdAt, "hour")}
                      </td>
                      <td className="max-w-[200px] truncate px-3 py-2 font-mono text-xs text-muted-foreground">
                        {s.createdAt}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">
                        {CHANNEL_LABEL[s.channel as (typeof CHANNEL_KEYS)[number]] ?? s.channel}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">
                        {(() => {
                          const r = syncResultFromMetadata(s.channel, s.metadata);
                          if (!r) return <span className="text-muted-foreground">—</span>;
                          return (
                            <span
                              className={cn(
                                "font-medium",
                                r === "Failed" ? "text-destructive" : "text-emerald-500 dark:text-emerald-400",
                              )}
                            >
                              {r}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="max-w-[280px] px-3 py-2 text-foreground">{s.label}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                        {s.bytesEstimate != null ? formatBytes(s.bytesEstimate) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                        {s.durationMs != null ? `${s.durationMs} ms` : "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                        {s.integration?.label ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredSamples.length === 0 && (
                <p className="p-6 text-center text-sm text-muted-foreground">No events in this range.</p>
              )}
            </div>
            {data && data.pagination.totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 border-t border-border p-3 text-sm">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="cursor-pointer rounded-md border border-border px-3 py-1 disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-muted-foreground">
                  Page {data.pagination.page} / {data.pagination.totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= data.pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="cursor-pointer rounded-md border border-border px-3 py-1 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
