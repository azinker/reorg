"use client";

import { useState, useEffect } from "react";
import {
  Activity,
  FileText,
  Shield,
  RefreshCw,
  Send,
  ScrollText,
  Terminal,
  CheckCircle,
  XCircle,
  Loader2,
  Clock,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "sync-jobs", label: "Sync Jobs", icon: RefreshCw },
  { id: "push-queue", label: "Push Queue", icon: Send },
  { id: "change-log", label: "Change Log", icon: ScrollText },
  { id: "raw-events", label: "Raw Events", icon: Terminal },
] as const;

type TabId = (typeof TABS)[number]["id"];

type SyncJobRow = {
  id: string;
  platform: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  source: "manual" | "scheduler";
  items: number;
  started: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  errors: string[];
};

type PushQueueRow = {
  id: string;
  sku: string;
  field: string;
  oldValue: string;
  newValue: string;
  platform: string;
  status: "queued";
  editedBy: string;
};

type ChangeLogRow = {
  timestamp: string;
  user: string;
  action: string;
  sku: string;
  detail: string;
};

type RawEventRow = { time: string; entry: string };

type EngineRoomData = {
  syncJobs: SyncJobRow[];
  pushQueue: PushQueueRow[];
  changeLog: ChangeLogRow[];
  rawEvents: RawEventRow[];
  summary: {
    activeSyncs: number;
    queuedPushes: number;
    recentErrors: number;
    recentErrorDetail: string | null;
    writeLockOn: boolean;
    schedulerEnabled: boolean;
    schedulerLastTickAt: string | null;
    schedulerLastOutcome: "dry_run" | "completed" | "failed" | null;
    schedulerLastDueCount: number;
    schedulerLastDispatchedCount: number;
    schedulerLastError: string | null;
    schedulerActiveJobs: number;
  };
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { icon: typeof CheckCircle; cls: string; label: string }> = {
    completed: { icon: CheckCircle, cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", label: "Completed" },
    in_progress: { icon: Loader2, cls: "bg-blue-500/15 text-blue-400 border-blue-500/30", label: "In Progress" },
    failed: { icon: XCircle, cls: "bg-red-500/15 text-red-400 border-red-500/30", label: "Failed" },
    queued: { icon: Clock, cls: "bg-amber-500/15 text-amber-400 border-amber-500/30", label: "Queued" },
    pending_review: { icon: FileText, cls: "bg-purple-500/15 text-purple-400 border-purple-500/30", label: "Pending Review" },
  };
  const c = config[status] ?? config.completed;
  const Icon = c.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium", c.cls)}>
      <Icon className={cn("h-3 w-3 shrink-0", status === "in_progress" && "animate-spin")} aria-hidden />
      {c.label}
    </span>
  );
}

function SyncJobsPanel({ jobs }: { jobs: SyncJobRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <th className="pb-3 pr-4">ID</th>
            <th className="pb-3 pr-4">Platform</th>
            <th className="pb-3 pr-4">Source</th>
            <th className="pb-3 pr-4">Status</th>
            <th className="pb-3 pr-4 text-right">Items Synced</th>
            <th className="pb-3 pr-4">Started</th>
            <th className="pb-3 pr-4 text-right">Duration</th>
            <th className="pb-3">Error</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {jobs.map((job) => (
            <tr key={job.id} className="text-foreground">
              <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">{job.id.slice(0, 8)}</td>
              <td className="py-3 pr-4">{job.platform}</td>
              <td className="py-3 pr-4">
                <span className={cn(
                  "inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium",
                  job.source === "scheduler"
                    ? "border-blue-500/30 bg-blue-500/10 text-blue-400"
                    : "border-border bg-muted/50 text-muted-foreground"
                )}>
                  {job.source === "scheduler" ? "Scheduler" : "Manual"}
                </span>
              </td>
              <td className="py-3 pr-4"><StatusBadge status={job.status} /></td>
              <td className="py-3 pr-4 text-right tabular-nums">{job.items.toLocaleString()}</td>
              <td className="py-3 pr-4 text-muted-foreground">{formatDateTime(job.started)}</td>
              <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">{formatDuration(job.durationSeconds)}</td>
              <td className="py-3 max-w-[200px] truncate text-xs text-muted-foreground" title={job.errors?.[0] ?? ""}>
                {job.status === "failed" && job.errors?.length ? job.errors[0] : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {jobs.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">No sync jobs yet.</p>
      )}
    </div>
  );
}

function PushQueuePanel({ items }: { items: PushQueueRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <th className="pb-3 pr-4">ID</th>
            <th className="pb-3 pr-4">SKU</th>
            <th className="pb-3 pr-4">Field</th>
            <th className="pb-3 pr-4">Old Value</th>
            <th className="pb-3 pr-4">New Value</th>
            <th className="pb-3 pr-4">Platform</th>
            <th className="pb-3 pr-4">Edited By</th>
            <th className="pb-3">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {items.map((item) => (
            <tr key={item.id} className="text-foreground">
              <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">{item.id.slice(0, 8)}</td>
              <td className="py-3 pr-4 font-mono text-xs">{item.sku}</td>
              <td className="py-3 pr-4">{item.field}</td>
              <td className="py-3 pr-4 text-muted-foreground line-through">{item.oldValue}</td>
              <td className="py-3 pr-4 font-medium text-emerald-400">{item.newValue}</td>
              <td className="py-3 pr-4">{item.platform}</td>
              <td className="py-3 pr-4 text-xs text-muted-foreground">{item.editedBy}</td>
              <td className="py-3"><StatusBadge status={item.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">Push queue is empty.</p>
      )}
    </div>
  );
}

function ChangeLogPanel({ entries }: { entries: ChangeLogRow[] }) {
  return (
    <div className="space-y-0 divide-y divide-border/50">
      {entries.map((entry, i) => (
        <div key={i} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3 text-sm">
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDateTime(entry.timestamp)}</span>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <User className="h-3 w-3" aria-hidden />
            {entry.user}
          </span>
          <span className="font-medium text-foreground">{entry.action}</span>
          {entry.sku !== "—" && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{entry.sku}</span>
          )}
          <span className="text-muted-foreground">{entry.detail}</span>
        </div>
      ))}
      {entries.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">No audit entries yet.</p>
      )}
    </div>
  );
}

function RawEventsPanel({ events }: { events: RawEventRow[] }) {
  return (
    <div className="rounded-md border border-border bg-zinc-950 p-4 font-mono text-xs leading-relaxed">
      {events.map((event, i) => {
        const isError = event.entry.includes("fail") || event.entry.includes("error") || event.entry.includes("429") || event.entry.includes("500") || event.entry.includes("503");
        return (
          <div key={i} className={cn("whitespace-pre", isError ? "text-red-400" : "text-emerald-400/80")}>
            <span className="text-zinc-500">{event.time}</span>{"  "}{event.entry}
          </div>
        );
      })}
      {events.length === 0 && (
        <p className="py-4 text-center text-zinc-500">No raw events.</p>
      )}
    </div>
  );
}

export default function EngineRoomPage() {
  const [activeTab, setActiveTab] = useState<TabId>("sync-jobs");
  const [data, setData] = useState<EngineRoomData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/engine-room")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to load"))))
      .then((json) => {
        setData(json.data ?? null);
        setError(null);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Failed to load engine room data");
      })
      .finally(() => setLoading(false));
  }, []);

  const summary = data?.summary ?? {
    activeSyncs: 0,
    queuedPushes: 0,
    recentErrors: 0,
    recentErrorDetail: null as string | null,
    writeLockOn: false,
    schedulerEnabled: false,
    schedulerLastTickAt: null as string | null,
    schedulerLastOutcome: null as "dry_run" | "completed" | "failed" | null,
    schedulerLastDueCount: 0,
    schedulerLastDispatchedCount: 0,
    schedulerLastError: null as string | null,
    schedulerActiveJobs: 0,
  };

  function renderPanel() {
    if (!data) {
      return loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          Loading…
        </div>
      ) : error ? (
        <div className="py-12 text-center text-destructive">{error}</div>
      ) : (
        <div className="py-12 text-center text-muted-foreground">No data.</div>
      );
    }
    switch (activeTab) {
      case "sync-jobs":
        return <SyncJobsPanel jobs={data.syncJobs} />;
      case "push-queue":
        return <PushQueuePanel items={data.pushQueue} />;
      case "change-log":
        return <ChangeLogPanel entries={data.changeLog} />;
      case "raw-events":
        return <RawEventsPanel events={data.rawEvents} />;
      default:
        return null;
    }
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Engine Room
        </h1>
        <p className="text-sm text-muted-foreground">
          Operations control center — sync jobs, push queue, audit trail
        </p>
      </div>

      {/* Summary cards */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article
          className={cn(
            "rounded-lg border border-border bg-card p-4 transition-colors duration-200",
            "ring-1 ring-border/50",
            "hover:border-border/80 hover:bg-card/95"
          )}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
                "bg-blue-500/15 text-blue-400"
              )}
            >
              <Activity className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-foreground">
                {loading ? "—" : summary.activeSyncs}
              </p>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Active Syncs
              </p>
            </div>
          </div>
        </article>

        <article
          className={cn(
            "rounded-lg border border-border bg-card p-4 transition-colors duration-200",
            "ring-1 ring-border/50",
            "hover:border-border/80 hover:bg-card/95"
          )}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
                "bg-amber-500/15 text-amber-400"
              )}
            >
              <Send className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-foreground">
                {loading ? "—" : summary.queuedPushes}
              </p>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Queued Pushes
              </p>
            </div>
          </div>
        </article>

        <article
          className={cn(
            "rounded-lg border border-border bg-card p-4 transition-colors duration-200",
            "ring-1 ring-border/50",
            "hover:border-border/80 hover:bg-card/95"
          )}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
                "bg-red-500/15 text-red-400"
              )}
            >
              <FileText className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-foreground">
                {loading ? "—" : summary.recentErrors}
              </p>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Recent Errors
              </p>
              {!loading && summary.recentErrors > 0 && summary.recentErrorDetail && (
                <p className="mt-1 max-w-full truncate text-xs text-red-400/90" title={summary.recentErrorDetail}>
                  {summary.recentErrorDetail}
                </p>
              )}
            </div>
          </div>
        </article>

        <article
          className={cn(
            "rounded-lg border border-amber-500/30 bg-card p-4 transition-colors duration-200",
            "ring-1 ring-amber-500/20",
            "hover:border-amber-500/40 hover:bg-card/95"
          )}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
                "bg-amber-500/15 text-amber-500 dark:text-amber-400"
              )}
            >
              <Shield className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                {loading ? "—" : summary.writeLockOn ? "ON" : "OFF"}
              </p>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Write Lock Status
              </p>
            </div>
          </div>
        </article>

        <article
          className={cn(
            "rounded-lg border border-border bg-card p-4 transition-colors duration-200 sm:col-span-2 lg:col-span-4",
            "ring-1 ring-border/50",
            "hover:border-border/80 hover:bg-card/95"
          )}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <RefreshCw className={cn(
                  "h-4 w-4",
                  summary.schedulerActiveJobs > 0 && "animate-spin text-blue-400"
                )} />
                <span className="text-sm font-semibold text-foreground">Scheduler Health</span>
                <span className={cn(
                  "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium",
                  summary.schedulerEnabled
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-400"
                )}>
                  {summary.schedulerEnabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Last tick: {formatDateTime(summary.schedulerLastTickAt)}
                {summary.schedulerLastOutcome ? ` • Result: ${summary.schedulerLastOutcome}` : ""}
                {summary.schedulerActiveJobs > 0 ? ` • ${summary.schedulerActiveJobs} scheduled sync(s) running` : ""}
              </p>
            </div>
            <div className="grid min-w-[260px] grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <div className="rounded border border-border bg-muted/40 px-3 py-2">
                <div className="text-muted-foreground">Due</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">
                  {summary.schedulerLastDueCount}
                </div>
              </div>
              <div className="rounded border border-border bg-muted/40 px-3 py-2">
                <div className="text-muted-foreground">Dispatched</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">
                  {summary.schedulerLastDispatchedCount}
                </div>
              </div>
              <div className="rounded border border-border bg-muted/40 px-3 py-2">
                <div className="text-muted-foreground">Active</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">
                  {summary.schedulerActiveJobs}
                </div>
              </div>
              <div className="rounded border border-border bg-muted/40 px-3 py-2">
                <div className="text-muted-foreground">Mode</div>
                <div className="mt-1 text-sm font-semibold text-foreground">
                  {summary.schedulerLastOutcome ?? "—"}
                </div>
              </div>
            </div>
          </div>
          {summary.schedulerLastError && (
            <div className="mt-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              Last scheduler error: {summary.schedulerLastError}
            </div>
          )}
        </article>
      </div>

      {/* Tabbed section */}
      <div
        className={cn(
          "rounded-lg border border-border bg-card",
          "ring-1 ring-border/30"
        )}
      >
        {/* Tab bar */}
        <div className="flex border-b border-border">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-5 py-3 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  isActive
                    ? "border-b-2 border-primary text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}
                aria-selected={isActive}
                aria-controls={`panel-${tab.id}`}
                id={`tab-${tab.id}`}
                role="tab"
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab panels */}
        <div
          id={`panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`tab-${activeTab}`}
          className="min-h-[280px] p-6"
        >
          {renderPanel()}
        </div>
      </div>
    </div>
  );
}
