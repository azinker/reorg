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
import {
  ArrowDownWideNarrow,
  ChevronDown,
  ChevronRight,
  Database,
  Globe,
  LifeBuoy,
  Loader2,
  RefreshCw,
  Server,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";

const CHANNEL_KEYS = [
  "CLIENT_API_RESPONSE",
  "MARKETPLACE_INBOUND",
  "MARKETPLACE_OUTBOUND",
  "SYNC_JOB",
  "FORECAST",
  "AUTO_RESPONDER",
  "DATABASE_IO",
  "WEBHOOK_INBOUND",
  "HELPDESK",
  "OTHER",
] as const;

type ChannelKey = (typeof CHANNEL_KEYS)[number];

const CHANNEL_LABEL: Record<ChannelKey, string> = {
  CLIENT_API_RESPONSE: "App API Responses",
  MARKETPLACE_INBOUND: "Marketplace HTTP Inbound",
  MARKETPLACE_OUTBOUND: "Marketplace HTTP Outbound",
  SYNC_JOB: "Pull Sync Jobs",
  FORECAST: "Inventory Forecaster",
  AUTO_RESPONDER: "Auto Responder",
  DATABASE_IO: "Database I/O (Neon)",
  WEBHOOK_INBOUND: "Webhook Inbound",
  HELPDESK: "Help Desk",
  OTHER: "Other",
};

const CHANNEL_DESCRIPTION: Record<ChannelKey, string> = {
  CLIENT_API_RESPONSE: "JSON responses, file downloads, image proxy, exports served to the browser",
  MARKETPLACE_INBOUND: "HTTP response bodies from eBay, BigCommerce, Shopify APIs during sync",
  MARKETPLACE_OUTBOUND: "HTTP request bodies sent to marketplace APIs (push operations)",
  SYNC_JOB: "Pull sync job telemetry (timing and item counts)",
  FORECAST: "Forecaster page loads, runs, Excel exports, saves, order data",
  AUTO_RESPONDER: "Message sends, previews, reconciliation, test messages",
  DATABASE_IO: "Prisma query round-trips to Neon PostgreSQL",
  WEBHOOK_INBOUND: "Incoming webhook payloads from eBay, BigCommerce, Shopify",
  HELPDESK: "Help Desk eBay sync (member messages pull, send, mark read, etc.)",
  OTHER: "Uncategorized network transfer events",
};

const CHANNEL_ICON: Record<ChannelKey, typeof Globe> = {
  CLIENT_API_RESPONSE: Globe,
  MARKETPLACE_INBOUND: Server,
  MARKETPLACE_OUTBOUND: Server,
  SYNC_JOB: RefreshCw,
  FORECAST: ArrowDownWideNarrow,
  AUTO_RESPONDER: Zap,
  DATABASE_IO: Database,
  WEBHOOK_INBOUND: Server,
  HELPDESK: LifeBuoy,
  OTHER: Globe,
};

const CHANNEL_STROKE: Record<ChannelKey, string> = {
  CLIENT_API_RESPONSE: "hsl(262, 83%, 68%)",
  MARKETPLACE_INBOUND: "hsl(199, 89%, 48%)",
  MARKETPLACE_OUTBOUND: "hsl(170, 70%, 45%)",
  SYNC_JOB: "hsl(142, 71%, 45%)",
  FORECAST: "hsl(38, 92%, 50%)",
  AUTO_RESPONDER: "hsl(300, 70%, 60%)",
  DATABASE_IO: "hsl(0, 75%, 55%)",
  WEBHOOK_INBOUND: "hsl(220, 70%, 55%)",
  HELPDESK: "hsl(15, 85%, 55%)",
  OTHER: "hsl(215, 20%, 55%)",
};

const CHANNEL_LEGEND_LABEL: Record<ChannelKey, string> = {
  CLIENT_API_RESPONSE: "App Responses",
  MARKETPLACE_INBOUND: "Marketplace In",
  MARKETPLACE_OUTBOUND: "Marketplace Out",
  SYNC_JOB: "Pull Syncs",
  FORECAST: "Forecaster",
  AUTO_RESPONDER: "Auto Responder",
  DATABASE_IO: "Database I/O",
  WEBHOOK_INBOUND: "Webhooks",
  HELPDESK: "Help Desk",
  OTHER: "Other",
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

function NetworkBrushTraveller(props: { x: number; y: number; width: number; height: number }) {
  const { x, y, width, height } = props;
  const lineY = Math.floor(y + height / 2) - 1;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill="var(--card)" stroke="var(--border)" strokeWidth={1} rx={3} />
      <line x1={x + 2} y1={lineY} x2={x + width - 2} y2={lineY} stroke="var(--muted-foreground)" strokeWidth={1.5} />
      <line x1={x + 2} y1={lineY + 2} x2={x + width - 2} y2={lineY + 2} stroke="var(--muted-foreground)" strokeWidth={1.5} />
    </g>
  );
}

type RangePreset = "24h" | "7d" | "30d";

type TopCostDriver = {
  label: string;
  channel: ChannelKey;
  eventCount: number;
  bytesSum: number;
  avgBytesPerEvent: number;
};

type ApiPayload = {
  retentionDays: number;
  prunedCount: number;
  rolledUpCount?: number;
  range: { from: string; to: string; bucket: "hour" | "day" };
  chartSeries: Record<string, string | number>[];
  totalsByChannel: { channel: string; eventCount: number; bytesSum: number }[];
  topCostDrivers: TopCostDriver[];
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
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set());

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

  const totalBytes = useMemo(() => {
    if (!data?.totalsByChannel) return 0;
    return data.totalsByChannel.reduce((sum, t) => sum + t.bytesSum, 0);
  }, [data?.totalsByChannel]);

  const sortedTotals = useMemo(() => {
    if (!data?.totalsByChannel) return [];
    return [...data.totalsByChannel].sort((a, b) => b.bytesSum - a.bytesSum);
  }, [data?.totalsByChannel]);

  const groupedSamples = useMemo(() => {
    const groups: Record<string, typeof filteredSamples> = {};
    for (const s of filteredSamples) {
      const ch = s.channel;
      if (!groups[ch]) groups[ch] = [];
      groups[ch].push(s);
    }
    return groups;
  }, [filteredSamples]);

  const toggleChannel = (ch: string) => {
    setExpandedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(ch)) next.delete(ch);
      else next.add(ch);
      return next;
    });
  };

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

      {/* Header */}
      <div className="flex flex-col gap-2 border-b border-border pb-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">
            Public Network Transfer
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Comprehensive telemetry across all network channels.
            Estimates from reorG — actual Neon billing may differ.
            Samples older than {data?.retentionDays ?? 10} days are rolled up into daily summaries, then pruned.
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

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Controls */}
      <div data-tour="network-transfer-controls" className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground">Range:</span>
        {(["24h", "7d", "30d"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => { setPreset(p); setPage(1); }}
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
          Channel
          <select
            value={channelFilter}
            onChange={(e) => { setChannelFilter(e.target.value); setPage(1); }}
            className="cursor-pointer rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
          >
            <option value="">All channels</option>
            {CHANNEL_KEYS.map((k) => (
              <option key={k} value={k}>{CHANNEL_LABEL[k]}</option>
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
          {/* Section 1: Cost Overview Cards */}
          {data && sortedTotals.length > 0 && (
            <div data-tour="network-transfer-overview">
              <div className="mb-3 flex items-baseline gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Cost Overview
                </h2>
                <span className="text-lg font-bold text-foreground">{formatBytes(totalBytes)}</span>
                <span className="text-xs text-muted-foreground">total estimated transfer</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {sortedTotals.map((t) => {
                  const ch = t.channel as ChannelKey;
                  const Icon = CHANNEL_ICON[ch] ?? Globe;
                  const pct = totalBytes > 0 ? ((t.bytesSum / totalBytes) * 100).toFixed(1) : "0.0";
                  const color = CHANNEL_STROKE[ch] ?? "hsl(215, 20%, 55%)";
                  return (
                    <div
                      key={t.channel}
                      className="relative overflow-hidden rounded-lg border border-border bg-card px-4 py-3 shadow-sm"
                    >
                      <div
                        className="absolute inset-y-0 left-0 w-1"
                        style={{ backgroundColor: color }}
                      />
                      <div className="flex items-start gap-2">
                        <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color }} />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-muted-foreground">
                            {CHANNEL_LABEL[ch] ?? ch}
                          </div>
                          <div className="mt-1 font-mono text-lg font-semibold text-foreground">
                            {formatBytes(t.bytesSum)}
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{t.eventCount} events</span>
                            <span className="font-medium" style={{ color }}>{pct}%</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Section 2: Stacked Area Chart */}
          <div data-tour="network-transfer-chart" className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Transfer by Channel Over Time
            </h2>
            <p className="mb-4 text-xs text-muted-foreground">
              {chartData.length >= 2
                ? "Stacked areas — drag the range bar below the chart to zoom. Hover points for details."
                : "Only one time bucket so far — the chart fills in as more activity is recorded."}
            </p>
            <div className="h-[400px] w-full min-w-0 [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-legend-item-text]:fill-muted-foreground">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 8, right: 16, left: 4, bottom: chartData.length >= 2 ? 4 : 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" strokeOpacity={0.45} vertical={false} />
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
                                  <span style={{ color: CHANNEL_STROKE[k] }}>{CHANNEL_LEGEND_LABEL[k]}</span>
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
                    formatter={(value) => CHANNEL_LEGEND_LABEL[value as ChannelKey] ?? value}
                  />
                  {CHANNEL_KEYS.map((k, i) => (
                    <Area
                      key={k}
                      type="monotone"
                      dataKey={k}
                      stackId="1"
                      stroke={CHANNEL_STROKE[k]}
                      fill={CHANNEL_STROKE[k]}
                      fillOpacity={0.35 - i * 0.03}
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

          {/* Section 3: Top Cost Drivers */}
          {data && data.topCostDrivers && data.topCostDrivers.length > 0 && (
            <div className="rounded-xl border border-border bg-card shadow-sm">
              <div className="border-b border-border p-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Top Cost Drivers
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Routes and operations ranked by total estimated bytes. Focus optimization here.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">#</th>
                      <th className="px-3 py-2 font-medium">Route / Label</th>
                      <th className="px-3 py-2 font-medium">Channel</th>
                      <th className="px-3 py-2 font-medium text-right">Total Bytes</th>
                      <th className="px-3 py-2 font-medium text-right">Events</th>
                      <th className="px-3 py-2 font-medium text-right">Avg / Event</th>
                      <th className="px-3 py-2 font-medium text-right">% of Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topCostDrivers.map((d, i) => {
                      const pct = totalBytes > 0 ? ((d.bytesSum / totalBytes) * 100).toFixed(1) : "0.0";
                      const color = CHANNEL_STROKE[d.channel] ?? "hsl(215, 20%, 55%)";
                      return (
                        <tr key={`${d.channel}-${d.label}`} className="border-b border-border/80 hover:bg-muted/20">
                          <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                          <td className="max-w-[300px] truncate px-3 py-2 font-mono text-xs text-foreground" title={d.label}>
                            {d.label}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            <span
                              className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
                              style={{ backgroundColor: `${color}20`, color }}
                            >
                              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
                              {CHANNEL_LEGEND_LABEL[d.channel] ?? d.channel}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-foreground">
                            {formatBytes(d.bytesSum)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right text-muted-foreground">
                            {d.eventCount.toLocaleString()}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                            {formatBytes(d.avgBytesPerEvent)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right font-medium" style={{ color }}>
                            {pct}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Section 4: Event Log (grouped by channel, collapsible) */}
          <div data-tour="network-transfer-table" className="min-h-0 flex-1 rounded-xl border border-border bg-card shadow-sm">
            <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Event Log
              </h2>
              <input
                type="search"
                placeholder="Filter by label..."
                value={searchLabel}
                onChange={(e) => setSearchLabel(e.target.value)}
                className="w-full max-w-xs rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground sm:w-72"
              />
            </div>

            {Object.keys(groupedSamples).length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">No events in this range.</p>
            ) : (
              <div>
                {CHANNEL_KEYS.filter((ch) => groupedSamples[ch]?.length).map((ch) => {
                  const samples = groupedSamples[ch]!;
                  const isExpanded = expandedChannels.has(ch);
                  const color = CHANNEL_STROKE[ch];
                  return (
                    <div key={ch} className="border-b border-border/60 last:border-b-0">
                      <button
                        type="button"
                        onClick={() => toggleChannel(ch)}
                        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-muted/20"
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                        <span className="text-sm font-medium text-foreground">{CHANNEL_LABEL[ch]}</span>
                        <span className="text-xs text-muted-foreground">({samples.length} events)</span>
                      </button>
                      {isExpanded && (
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                            <thead>
                              <tr className="border-b border-border bg-muted/20 text-xs uppercase tracking-wide text-muted-foreground">
                                <th className="px-3 py-1.5 font-medium">Time (NY)</th>
                                <th className="px-3 py-1.5 font-medium">Label</th>
                                <th className="px-3 py-1.5 font-medium">Bytes</th>
                                <th className="px-3 py-1.5 font-medium">Duration</th>
                                <th className="px-3 py-1.5 font-medium">Store</th>
                              </tr>
                            </thead>
                            <tbody>
                              {samples.map((s) => (
                                <tr key={s.id} className="border-b border-border/50 hover:bg-muted/10">
                                  <td className="whitespace-nowrap px-3 py-2 text-foreground">
                                    {formatNyTime(s.createdAt, "hour")}
                                  </td>
                                  <td className="max-w-[300px] truncate px-3 py-2 text-foreground" title={s.label}>
                                    {s.label}
                                  </td>
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
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

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
