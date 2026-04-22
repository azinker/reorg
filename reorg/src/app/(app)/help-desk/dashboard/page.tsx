"use client";

/**
 * Help Desk operational dashboard. Read-only metrics for Admins / Team Leads:
 *   - SLA snapshot, status mix, inbound/outbound trend
 *   - Per-agent resolved tickets (last N days)
 *   - 7x24 inbound heatmap (when buyers actually message us)
 *
 * Polls /api/helpdesk/dashboard every 60s. No writes.
 */

import { useEffect, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Users,
  Mail,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";

type SlaBucket = "GREEN" | "AMBER" | "RED" | "MET" | "NA";

interface Dashboard {
  windowDays: number;
  openByStatus: Record<string, number>;
  openByKind: Record<string, number>;
  slaSnapshot: Record<SlaBucket, number>;
  perAgent: { userId: string | null; name: string | null; email: string | null; resolved: number }[];
  inboundPerDay: { date: string; count: number }[];
  outboundPerDay: { date: string; count: number }[];
  heatmap: number[][]; // 7x24
}

export default function HelpdeskDashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(14);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch(`/api/helpdesk/dashboard?days=${days}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`Dashboard ${res.status}`);
        const j = (await res.json()) as { data: Dashboard };
        if (!alive) return;
        setData(j.data);
        setError(null);
      } catch (e: unknown) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [days]);

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            Help Desk · Dashboard
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Last {data?.windowDays ?? days} days · refreshes every 60s
          </p>
        </div>
        <div className="flex items-center justify-end gap-3">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="h-8 rounded-md border border-hairline bg-card px-2 text-xs text-foreground"
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
          </select>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="text-sm text-muted-foreground">Loading…</div>
      )}

      {data && (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi
              icon={Activity}
              label="Open"
              value={
                (data.openByStatus.NEW ?? 0) +
                (data.openByStatus.TO_DO ?? 0) +
                (data.openByStatus.WAITING ?? 0)
              }
            />
            <Kpi
              icon={Clock}
              label="Awaiting reply"
              value={data.openByStatus.NEW ?? 0}
              tone="amber"
            />
            <Kpi
              icon={AlertTriangle}
              label="SLA breached"
              value={data.slaSnapshot.RED}
              tone="red"
            />
            <Kpi
              icon={CheckCircle2}
              label={`Resolved (last ${data.windowDays}d)`}
              value={data.perAgent.reduce((s, p) => s + p.resolved, 0)}
              tone="emerald"
            />
          </section>

          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="SLA snapshot (open tickets)">
              <SlaBreakdown snap={data.slaSnapshot} />
            </Card>
            <Card title="Status mix">
              <StatusMix mix={data.openByStatus} />
            </Card>
          </section>

          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card
              title="Inbound vs Outbound (per day)"
              icon={<Mail className="h-3 w-3" />}
            >
              <DualSpark
                a={data.inboundPerDay}
                b={data.outboundPerDay}
                aLabel="Inbound"
                bLabel="Outbound"
              />
            </Card>
            <Card title="Heatmap · inbound by hour" icon={<Send className="h-3 w-3" />}>
              <Heatmap matrix={data.heatmap} />
            </Card>
          </section>

          <Card title="Per-agent resolved" icon={<Users className="h-3 w-3" />}>
            <table className="w-full text-xs">
              <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-2 py-1">Agent</th>
                  <th className="px-2 py-1 text-right">Resolved</th>
                </tr>
              </thead>
              <tbody>
                {data.perAgent.length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-2 py-3 text-center text-muted-foreground">
                      No tickets resolved in this window.
                    </td>
                  </tr>
                )}
                {data.perAgent
                  .slice()
                  .sort((a, b) => b.resolved - a.resolved)
                  .map((p) => (
                    <tr key={p.userId ?? "unknown"} className="border-t border-hairline">
                      <td className="px-2 py-1 text-foreground/90">
                        {p.name ?? p.email ?? p.userId ?? "Unknown"}
                      </td>
                      <td className="px-2 py-1 text-right font-medium text-foreground">
                        {p.resolved}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

// ----- Subcomponents -----

function Kpi({
  icon: Icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  tone?: "neutral" | "red" | "amber" | "emerald";
}) {
  const palette = {
    neutral: "text-foreground",
    red: "text-red-700 dark:text-red-300",
    amber: "text-amber-700 dark:text-amber-300",
    emerald: "text-emerald-700 dark:text-emerald-300",
  }[tone];
  return (
    <div className="rounded-lg border border-hairline bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className={cn("mt-1 text-2xl font-semibold", palette)}>{value}</div>
    </div>
  );
}

function Card({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-hairline bg-card p-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function SlaBreakdown({ snap }: { snap: Dashboard["slaSnapshot"] }) {
  const total = snap.GREEN + snap.AMBER + snap.RED;
  if (total === 0)
    return <p className="text-xs text-muted-foreground">No open tickets.</p>;
  return (
    <div className="space-y-2 text-xs">
      <Bar
        label="Green (<12h)"
        value={snap.GREEN}
        total={total}
        color="bg-emerald-500"
      />
      <Bar
        label="Amber (12-24h)"
        value={snap.AMBER}
        total={total}
        color="bg-amber-500"
      />
      <Bar
        label="Red (≥24h)"
        value={snap.RED}
        total={total}
        color="bg-red-500"
      />
    </div>
  );
}

function StatusMix({ mix }: { mix: Record<string, number> }) {
  const entries = Object.entries(mix).filter(
    ([s]) => !["ARCHIVED", "SPAM"].includes(s),
  );
  const total = entries.reduce((s, [, c]) => s + c, 0);
  if (total === 0)
    return <p className="text-xs text-muted-foreground">No tickets.</p>;
  const colors: Record<string, string> = {
    NEW: "bg-blue-500",
    TO_DO: "bg-amber-500",
    WAITING: "bg-purple-500",
    RESOLVED: "bg-emerald-500",
  };
  return (
    <div className="space-y-2 text-xs">
      {entries.map(([s, c]) => (
        <Bar
          key={s}
          label={s.replace("_", " ")}
          value={c}
          total={total}
          color={colors[s] ?? "bg-muted"}
        />
      ))}
    </div>
  );
}

function Bar({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground/90">
          {value} <span className="text-muted-foreground">({pct}%)</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className={cn("h-full", color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function DualSpark({
  a,
  b,
  aLabel,
  bLabel,
}: {
  a: { date: string; count: number }[];
  b: { date: string; count: number }[];
  aLabel: string;
  bLabel: string;
}) {
  const max = Math.max(
    1,
    ...a.map((x) => x.count),
    ...b.map((x) => x.count),
  );
  return (
    <div>
      <div className="flex items-end gap-1 h-24">
        {a.map((row, i) => {
          const ha = (row.count / max) * 100;
          const hb = ((b[i]?.count ?? 0) / max) * 100;
          return (
            <div
              key={row.date}
              className="flex-1 flex flex-col items-center justify-end gap-0.5"
              title={`${row.date}\n${aLabel}: ${row.count}\n${bLabel}: ${b[i]?.count ?? 0}`}
            >
              <div
                className="w-full bg-blue-500/60 rounded-t-sm"
                style={{ height: `${ha}%` }}
              />
              <div
                className="w-full bg-emerald-500/60"
                style={{ height: `${hb}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-blue-500/60" />
          {aLabel}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-emerald-500/60" />
          {bLabel}
        </span>
      </div>
    </div>
  );
}

function Heatmap({ matrix }: { matrix: number[][] }) {
  const max = Math.max(1, ...matrix.flat());
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (
    <div className="overflow-x-auto">
      <table className="text-[9px]">
        <thead>
          <tr>
            <th />
            {Array.from({ length: 24 }, (_, h) => (
              <th key={h} className="px-0.5 text-muted-foreground">
                {h % 3 === 0 ? h : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.map((row, dow) => (
            <tr key={dow}>
              <td className="pr-1 text-right text-muted-foreground">
                {days[dow]}
              </td>
              {row.map((v, h) => {
                const intensity = v / max;
                return (
                  <td key={h} className="p-0.5" title={`${days[dow]} ${h}:00 — ${v}`}>
                    <div
                      className="h-3.5 w-3.5 rounded-sm"
                      style={
                        v === 0
                          ? { backgroundColor: "var(--surface-2)" }
                          : {
                              backgroundColor: "var(--brand)",
                              opacity: 0.2 + intensity * 0.8,
                            }
                      }
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
