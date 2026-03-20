"use client";

import { useState, useEffect, useCallback } from "react";
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
  RotateCcw,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";
import {
  PushConfirmModal,
  type PushApiData,
  type PushItem,
} from "@/components/push/push-confirm-modal";

const TABS = [
  { id: "sync-jobs", label: "Sync Jobs", icon: RefreshCw },
  { id: "automation", label: "Automation", icon: Activity },
  { id: "push-jobs", label: "Push Jobs", icon: Send },
  { id: "push-queue", label: "Push Queue", icon: Send },
  { id: "change-log", label: "Change Log", icon: ScrollText },
  { id: "raw-events", label: "Raw Events", icon: Terminal },
] as const;

type TabId = (typeof TABS)[number]["id"];

type SyncJobRow = {
  id: string;
  platform: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  source: "manual" | "scheduler" | "webhook" | "push";
  mode: string;
  triggerKey: string | null;
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

type PushJobRow = {
  id: string;
  createdAt: string;
  completedAt: string | null;
  user: string;
  dryRun: boolean;
  status: "dry_run" | "executing" | "completed" | "partial" | "failed" | "blocked";
  totalChanges: number;
  distinctListings: number;
  successfulChanges: number;
  failedChanges: number;
  backupStatus: string | null;
  refreshStatus: string | null;
  refreshDetail: string | null;
  retryableFailedChanges: number;
  blockedReason: string | null;
  changes: Array<{
    stagedChangeId: string | null;
    masterRowId: string | null;
    marketplaceListingId: string | null;
    platformVariantId: string | null;
    platform: string;
    platformLabel: string;
    listingId: string;
    field: "salePrice" | "adRate";
    oldValue: number | null;
    newValue: number;
    sku: string;
    title: string;
    success: boolean | null;
    error: string | null;
    failureCategory: string | null;
    failureSummary: string | null;
    recommendedAction: string | null;
  }>;
};

type ChangeLogRow = {
  timestamp: string;
  user: string;
  action: string;
  sku: string;
  detail: string;
};

type RawEventRow = { time: string; entry: string };

type AutomationFeedRow = {
  id: string;
  type: "scheduler_tick" | "webhook" | "stale_job";
  status: "completed" | "dry_run" | "failed" | "warning" | "ignored" | "debounced" | "running" | "started" | "unknown";
  title: string;
  platform: string | null;
  detail: string;
  time: string;
};

type DueQueueRow = {
  integrationId: string;
  label: string;
  platform: string;
  due: boolean;
  running: boolean;
  effectiveMode: string;
  intervalMinutes: number;
  nextDueAt: string | null;
  lastScheduledSyncAt: string | null;
  minutesUntilDue: number | null;
  reason: string;
  fallbackReason: string | null;
};

type EngineRoomData = {
  syncJobs: SyncJobRow[];
  pushJobs: PushJobRow[];
  pushQueue: PushQueueRow[];
  changeLog: ChangeLogRow[];
  rawEvents: RawEventRow[];
  automationFeed: AutomationFeedRow[];
  dueQueue: DueQueueRow[];
  integrationHealth: Array<{
    integrationId: string;
    label: string;
    platform: string;
    status: "healthy" | "delayed" | "attention";
    combinedStatus: "healthy" | "delayed" | "attention";
    syncMessage: string;
    lastSyncAt: string | null;
    running: boolean;
    due: boolean;
    nextDueAt: string | null;
    webhookExpected: boolean;
    lastWebhookAt: string | null;
    recentWebhookCount24h: number;
    lastWebhookTopic: string | null;
    lastWebhookMessage: string | null;
    lastWebhookEventStatus: string | null;
    webhookMessage: string;
    webhookProofStatus: "none" | "before_last_pull" | "after_last_pull";
    webhookProofMessage: string;
    recommendedAction: string;
    pendingBacklogCount: number;
    pendingBacklogWindowEndedAt: string | null;
    rateLimits: {
      fetchedAt: string;
      methods: Array<{
        name: string;
        count: number;
        limit: number;
        remaining: number;
        reset: string | null;
        timeWindowSeconds: number | null;
        status: "healthy" | "tight" | "exhausted";
      }>;
      exhaustedMethods: string[];
      nextResetAt: string | null;
    } | null;
  }>;
  summary: {
    activeSyncs: number;
    queuedPushes: number;
    recentErrors: number;
    recentErrorDetail: string | null;
    recentErrorAt: string | null;
    recentErrorStore: string | null;
    writeLockOn: boolean;
    schedulerEnabled: boolean;
    schedulerLastTickAt: string | null;
    schedulerLastOutcome: "dry_run" | "completed" | "failed" | null;
    schedulerLastDueCount: number;
    schedulerLastDispatchedCount: number;
    schedulerLastError: string | null;
    schedulerActiveJobs: number;
    schedulerDueNow: number;
    recentWebhookCount: number;
    automationHealthStatus: "healthy" | "delayed" | "attention";
    automationHealthHeadline: string;
    automationHealthDetail: string;
    automationHealthAction: string;
    delayedStores: number;
    attentionStores: number;
  };
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
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
  if (seconds == null) return "-";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function formatMode(mode: string): string {
  if (mode === "incremental") return "Incremental";
  if (mode === "full") return "Full";
  if (!mode || mode === "unknown") return "Unknown";
  return mode
    .split(":")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatPushField(field: string) {
  if (field === "salePrice") return "Sale Price";
  if (field === "adRate") return "Promoted General Ad Rate";
  return field;
}

function formatPushValue(field: string, value: number | null) {
  if (value == null) return "-";
  if (field === "adRate") return `${(value * 100).toFixed(1)}%`;
  return `$${value.toFixed(2)}`;
}

function formatDueWindow(item: DueQueueRow): string {
  if (item.running) return "Running now";
  if (item.due) return "Due now";
  if (item.minutesUntilDue == null) return "Not scheduled";
  if (item.minutesUntilDue === 0) return "Due within 1m";
  if (item.minutesUntilDue < 60) return `Due in ${item.minutesUntilDue}m`;
  const hours = Math.floor(item.minutesUntilDue / 60);
  const minutes = item.minutesUntilDue % 60;
  return minutes > 0 ? `Due in ${hours}h ${minutes}m` : `Due in ${hours}h`;
}

function getAutomationStatusClasses(status: AutomationFeedRow["status"]) {
  if (status === "failed") return "border-red-500/30 bg-red-500/10 text-red-400";
  if (status === "warning") return "border-amber-500/30 bg-amber-500/10 text-amber-400";
  if (status === "dry_run") return "border-blue-500/30 bg-blue-500/10 text-blue-400";
  if (status === "started" || status === "running") {
    return "border-violet-500/30 bg-violet-500/10 text-violet-400";
  }
  if (status === "debounced" || status === "ignored") {
    return "border-border bg-muted/50 text-muted-foreground";
  }
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-400";
}

function getHealthClasses(status: "healthy" | "delayed" | "attention") {
  if (status === "attention") return "border-red-500/30 bg-red-500/10 text-red-400";
  if (status === "delayed") return "border-amber-500/30 bg-amber-500/10 text-amber-400";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-400";
}

function getWebhookProofClasses(
  status: "none" | "before_last_pull" | "after_last_pull",
) {
  if (status === "after_last_pull") {
    return "border-blue-500/20 bg-blue-500/5 text-blue-300";
  }
  return "border-border bg-muted/40 text-muted-foreground";
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
  const [sourceFilter, setSourceFilter] = useState<"all" | SyncJobRow["source"]>("all");
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const [hideTinyWebhookJobs, setHideTinyWebhookJobs] = useState(true);

  const platformOptions = Array.from(new Set(jobs.map((job) => job.platform))).sort((a, b) =>
    a.localeCompare(b),
  );

  const filteredJobs = jobs.filter((job) => {
    if (sourceFilter !== "all" && job.source !== sourceFilter) return false;
    if (platformFilter !== "all" && job.platform !== platformFilter) return false;
    if (hideTinyWebhookJobs && job.source === "webhook" && job.items <= 1) return false;
    return true;
  });

  const hiddenTinyWebhookCount = jobs.filter(
    (job) => job.source === "webhook" && job.items <= 1,
  ).length;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/20 p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">Filter Sync Activity</h3>
            <p className="max-w-3xl text-xs text-muted-foreground">
              This table logs every real pull job across all connected stores. Use these filters to focus on the type
              of sync work you care about.
            </p>
          </div>
          <div className="rounded border border-border bg-background/60 px-3 py-2 text-xs text-muted-foreground">
            Showing {filteredJobs.length.toLocaleString()} of {jobs.length.toLocaleString()} sync jobs
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,220px)_minmax(0,220px)_1fr]">
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Source</span>
            <select
              value={sourceFilter}
              onChange={(event) => setSourceFilter(event.target.value as "all" | SyncJobRow["source"])}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
            >
              <option value="all">All activity</option>
              <option value="webhook">Webhook updates</option>
              <option value="scheduler">Scheduled pulls</option>
              <option value="manual">Manual pulls</option>
              <option value="push">Push follow-up refreshes</option>
            </select>
            <p className="text-[11px] text-muted-foreground">
              Webhook updates are small marketplace change notices. Scheduled pulls are automatic cadence checks.
            </p>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Store</span>
            <select
              value={platformFilter}
              onChange={(event) => setPlatformFilter(event.target.value)}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
            >
              <option value="all">All stores</option>
              {platformOptions.map((platform) => (
                <option key={platform} value={platform}>
                  {platform}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              Use this when you want to isolate one marketplace like Shopify, BigCommerce, or one eBay store.
            </p>
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background/60 px-3 py-3">
            <input
              type="checkbox"
              checked={hideTinyWebhookJobs}
              onChange={(event) => setHideTinyWebhookJobs(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-border bg-background text-primary focus:ring-ring"
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium text-foreground">Hide tiny webhook refreshes</span>
              <span className="block text-[11px] text-muted-foreground">
                Turns off the noisy 1-item webhook jobs that happen when Shopify or BigCommerce tells reorG a single
                product changed. This only changes the view, not the sync behavior.
              </span>
              {hiddenTinyWebhookCount > 0 ? (
                <span className="block text-[11px] text-muted-foreground">
                  {hiddenTinyWebhookCount.toLocaleString()} tiny webhook job
                  {hiddenTinyWebhookCount === 1 ? "" : "s"} currently match this rule.
                </span>
              ) : null}
            </span>
          </label>
        </div>

        <div className="mt-4 grid gap-2 text-[11px] text-muted-foreground md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded border border-border bg-background/40 px-3 py-2">
            <span className="font-medium text-foreground">Webhook updates</span> are small targeted refreshes after a
            marketplace notice. Many Shopify rows with 1 item synced are normal here.
          </div>
          <div className="rounded border border-border bg-background/40 px-3 py-2">
            <span className="font-medium text-foreground">Scheduled pulls</span> are the automatic background checks
            that run on the store cadence.
          </div>
          <div className="rounded border border-border bg-background/40 px-3 py-2">
            <span className="font-medium text-foreground">Manual pulls</span> are jobs started by a user from Sync or
            another control surface.
          </div>
          <div className="rounded border border-border bg-background/40 px-3 py-2">
            <span className="font-medium text-foreground">Push follow-up refreshes</span> are targeted read-backs
            after a confirmed marketplace push.
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <th className="pb-3 pr-4">ID</th>
            <th className="pb-3 pr-4">Platform</th>
            <th className="pb-3 pr-4">Source</th>
            <th className="pb-3 pr-4">Mode</th>
            <th className="pb-3 pr-4">Status</th>
            <th className="pb-3 pr-4 text-right">Items Synced</th>
            <th className="pb-3 pr-4">Started</th>
            <th className="pb-3 pr-4 text-right">Duration</th>
            <th className="pb-3">Error</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {filteredJobs.map((job) => (
            <tr key={job.id} className="text-foreground">
              <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">{job.id.slice(0, 8)}</td>
              <td className="py-3 pr-4">{job.platform}</td>
              <td className="py-3 pr-4">
                <span className={cn(
                  "inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium",
                  job.source === "scheduler"
                    ? "border-blue-500/30 bg-blue-500/10 text-blue-400"
                    : job.source === "webhook"
                      ? "border-violet-500/30 bg-violet-500/10 text-violet-400"
                    : job.source === "push"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                    : "border-border bg-muted/50 text-muted-foreground"
                )}>
                  {job.source === "scheduler"
                    ? "Scheduler"
                    : job.source === "webhook"
                      ? "Webhook"
                      : job.source === "push"
                        ? "Push"
                      : "Manual"}
                </span>
              </td>
              <td className="py-3 pr-4">
                <span className="inline-flex items-center rounded border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-foreground/80">
                  {formatMode(job.mode)}
                </span>
              </td>
              <td className="py-3 pr-4"><StatusBadge status={job.status} /></td>
              <td className="py-3 pr-4 text-right tabular-nums">{job.items.toLocaleString()}</td>
              <td className="py-3 pr-4 text-muted-foreground">{formatDateTime(job.started)}</td>
              <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">{formatDuration(job.durationSeconds)}</td>
              <td className="py-3 max-w-[200px] truncate text-xs text-muted-foreground" title={job.errors?.[0] ?? ""}>
                {job.status === "failed" && job.errors?.length ? job.errors[0] : "-"}
              </td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>
      {jobs.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">No sync jobs yet.</p>
      )}
      {jobs.length > 0 && filteredJobs.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No sync jobs match the current filters. Try switching back to <span className="font-medium text-foreground">All activity</span> or turning off <span className="font-medium text-foreground">Hide tiny webhook refreshes</span>.
        </p>
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

function PushJobsPanel({
  jobs,
  onRefresh,
}: {
  jobs: PushJobRow[];
  onRefresh?: () => void;
}) {
  const [selectedJob, setSelectedJob] = useState<PushJobRow | null>(null);
  const [retryItems, setRetryItems] = useState<PushItem[]>([]);
  const [retryModalOpen, setRetryModalOpen] = useState(false);

  function openRetryReview(items: PushItem[]) {
    if (items.length === 0) return;
    setRetryItems(items);
    setRetryModalOpen(true);
  }

  function buildRetryItems(job: PushJobRow, failedOnly: boolean) {
    return job.changes
      .filter((change) => !failedOnly || change.success === false)
      .map((change) => ({
        stagedChangeId: change.stagedChangeId ?? undefined,
        masterRowId: change.masterRowId ?? undefined,
        marketplaceListingId: change.marketplaceListingId ?? undefined,
        platformVariantId: change.platformVariantId ?? undefined,
        sku: change.sku,
        title: change.title,
        platform: change.platform as PushItem["platform"],
        listingId: change.listingId,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
      }));
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <th className="pb-3 pr-4">Job</th>
            <th className="pb-3 pr-4">Type</th>
            <th className="pb-3 pr-4">Status</th>
            <th className="pb-3 pr-4 text-right">Listings</th>
            <th className="pb-3 pr-4 text-right">Changes</th>
            <th className="pb-3 pr-4">Backup</th>
            <th className="pb-3 pr-4">Refresh</th>
            <th className="pb-3 pr-4">User</th>
            <th className="pb-3">Notes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {jobs.map((job) => (
            <tr key={job.id} className="text-foreground">
              <td className="py-3 pr-4">
                <div className="font-mono text-xs text-muted-foreground">{job.id.slice(0, 8)}</div>
                <div className="mt-1 text-xs text-muted-foreground">{formatDateTime(job.createdAt)}</div>
              </td>
              <td className="py-3 pr-4">
                <span className="inline-flex items-center rounded border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-foreground/80">
                  {job.dryRun ? "Dry Run" : "Live Push"}
                </span>
              </td>
              <td className="py-3 pr-4">
                <StatusBadge
                  status={
                    job.status === "dry_run"
                      ? "queued"
                      : job.status === "executing"
                        ? "in_progress"
                        : job.status === "completed"
                          ? "completed"
                          : job.status === "partial"
                            ? "pending_review"
                            : "failed"
                  }
                />
              </td>
              <td className="py-3 pr-4 text-right tabular-nums">{job.distinctListings.toLocaleString()}</td>
              <td className="py-3 pr-4 text-right">
                <button
                  type="button"
                  onClick={() => setSelectedJob(job)}
                  className="cursor-pointer rounded border border-border bg-background/50 px-2 py-1 text-right transition-colors hover:border-primary/40 hover:bg-primary/5"
                  title="View the actual changes in this push job"
                >
                  <div className="tabular-nums text-foreground">{job.totalChanges.toLocaleString()}</div>
                  <div className="text-[11px] text-muted-foreground">View changes</div>
                </button>
                <div className="text-xs text-muted-foreground">
                  {job.successfulChanges.toLocaleString()} ok / {job.failedChanges.toLocaleString()} failed
                </div>
              </td>
              <td className="py-3 pr-4 text-xs text-muted-foreground">{job.backupStatus ?? "-"}</td>
              <td className="py-3 pr-4 text-xs text-muted-foreground">{job.refreshStatus ?? "-"}</td>
              <td className="py-3 pr-4 text-xs text-muted-foreground">{job.user}</td>
              <td className="py-3 text-xs text-muted-foreground">
                {job.blockedReason
                  ? job.blockedReason
                  : job.retryableFailedChanges > 0
                    ? `${job.retryableFailedChanges} failed change${job.retryableFailedChanges === 1 ? "" : "s"} can be retried safely.`
                    : job.refreshDetail ?? "-"}
                {job.retryableFailedChanges > 0 ? (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => openRetryReview(buildRetryItems(job, true))}
                      className="inline-flex cursor-pointer items-center gap-1 rounded border border-border px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Retry Failed Only
                    </button>
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
        </table>
        {jobs.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No push jobs yet.</p>
        )}
      </div>

      <PushJobDetailsModal
        job={selectedJob}
        onClose={() => setSelectedJob(null)}
        onRetryFailedOnly={(job) => openRetryReview(buildRetryItems(job, true))}
        onRetrySingle={(job, changeKey) => {
          const item = buildRetryItems(job, false).find(
            (entry) => `${entry.platform}:${entry.listingId}:${entry.field}` === changeKey,
          );
          if (item) openRetryReview([item]);
        }}
      />

      <PushConfirmModal
        open={retryModalOpen}
        onClose={() => setRetryModalOpen(false)}
        onApplied={(_result: PushApiData) => {
          setRetryModalOpen(false);
          onRefresh?.();
        }}
        items={retryItems}
      />
    </>
  );
}

function PushJobDetailsModal({
  job,
  onClose,
  onRetryFailedOnly,
  onRetrySingle,
}: {
  job: PushJobRow | null;
  onClose: () => void;
  onRetryFailedOnly: (job: PushJobRow) => void;
  onRetrySingle: (job: PushJobRow, changeKey: string) => void;
}) {
  if (!job) return null;

  const failedChanges = job.changes.filter((change) => change.success === false);

  return (
    <>
      <div className="fixed inset-0 z-[300] bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-[301] w-[min(1100px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Push Job Details</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {job.user} ran this {job.dryRun ? "dry run" : "live push"} on {formatDateTime(job.createdAt)}.
              {job.completedAt ? ` Completed ${formatDateTime(job.completedAt)}.` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[75vh] overflow-y-auto px-6 py-5">
          <section className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Status</div>
              <div className="mt-2">
                <StatusBadge
                  status={
                    job.status === "dry_run"
                      ? "queued"
                      : job.status === "executing"
                        ? "in_progress"
                        : job.status === "completed"
                          ? "completed"
                          : job.status === "partial"
                            ? "pending_review"
                            : "failed"
                  }
                />
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Changes</div>
              <div className="mt-1 text-2xl font-semibold text-foreground">{job.totalChanges}</div>
            </div>
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Succeeded</div>
              <div className="mt-1 text-2xl font-semibold text-emerald-400">{job.successfulChanges}</div>
            </div>
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Failed</div>
              <div className="mt-1 text-2xl font-semibold text-red-400">{job.failedChanges}</div>
            </div>
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Refresh</div>
              <div className="mt-1 text-sm font-medium text-foreground">{job.refreshStatus ?? "-"}</div>
              <div className="mt-1 text-xs text-muted-foreground">{job.refreshDetail ?? "No refresh note recorded."}</div>
            </div>
          </section>

          {(job.blockedReason || job.backupStatus) ? (
            <section className="mb-5 grid gap-3 lg:grid-cols-2">
              {job.backupStatus ? (
                <div className="rounded-xl border border-border bg-background/50 p-4">
                  <div className="text-sm font-semibold text-foreground">Pre-Push Backup</div>
                  <div className="mt-2 text-xs text-muted-foreground">{job.backupStatus}</div>
                </div>
              ) : null}
              {job.blockedReason ? (
                <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
                  <div className="text-sm font-semibold text-red-300">Blocked Reason</div>
                  <div className="mt-2 text-xs text-red-200/90">{job.blockedReason}</div>
                </div>
              ) : null}
            </section>
          ) : null}

          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Actual Changes</h3>
                <p className="text-xs text-muted-foreground">
                  Review the exact SKU, field, old value, new value, and result for every change in this push job.
                </p>
              </div>
              {failedChanges.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onRetryFailedOnly(job)}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <RotateCcw className="h-4 w-4" />
                  Retry Failed Only
                </button>
              ) : null}
            </div>

            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/20 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-3">SKU</th>
                    <th className="px-3 py-3">Store</th>
                    <th className="px-3 py-3">Field</th>
                    <th className="px-3 py-3">From</th>
                    <th className="px-3 py-3">To</th>
                    <th className="px-3 py-3">Result</th>
                    <th className="px-3 py-3">Detail</th>
                    <th className="px-3 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {job.changes.map((change) => {
                    const changeKey = `${change.platform}:${change.listingId}:${change.field}`;
                    return (
                      <tr key={changeKey}>
                        <td className="px-3 py-3 align-top">
                          <div className="font-mono text-xs text-foreground">{change.sku}</div>
                          <div className="mt-1 max-w-[220px] truncate text-xs text-muted-foreground" title={change.title}>
                            {change.title}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="text-sm text-foreground">{change.platformLabel}</div>
                          <div className="mt-1 font-mono text-[11px] text-muted-foreground">{change.listingId}</div>
                        </td>
                        <td className="px-3 py-3 align-top text-sm text-foreground">{formatPushField(change.field)}</td>
                        <td className="px-3 py-3 align-top text-sm text-muted-foreground">{formatPushValue(change.field, change.oldValue)}</td>
                        <td className="px-3 py-3 align-top text-sm font-semibold text-foreground">{formatPushValue(change.field, change.newValue)}</td>
                        <td className="px-3 py-3 align-top">
                          {change.success === null ? (
                            <span className="text-xs text-muted-foreground">Planned</span>
                          ) : change.success ? (
                            <StatusBadge status="completed" />
                          ) : (
                            <StatusBadge status="failed" />
                          )}
                        </td>
                        <td className="px-3 py-3 align-top text-xs text-muted-foreground">
                          {change.success === false ? (
                            <div className="space-y-2">
                              {change.failureCategory ? (
                                <span className="inline-flex rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                                  {change.failureCategory.replace("-", " ")}
                                </span>
                              ) : null}
                              <div>{change.failureSummary ?? "Push failed."}</div>
                              {change.recommendedAction ? (
                                <div className="text-amber-100">Next step: {change.recommendedAction}</div>
                              ) : null}
                              <div className="text-red-200">{change.error ?? "No extra detail recorded."}</div>
                            </div>
                          ) : (
                            change.error ?? (change.success ? "Push completed." : "No extra detail recorded.")
                          )}
                        </td>
                        <td className="px-3 py-3 align-top text-right">
                          {change.success === false ? (
                            <button
                              type="button"
                              onClick={() => onRetrySingle(job, changeKey)}
                              className="inline-flex cursor-pointer items-center gap-1 rounded border border-border px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
                            >
                              <RotateCcw className="h-3 w-3" />
                              Retry
                            </button>
                          ) : (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </>
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
          {entry.sku !== "-" && (
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

function AutomationPanel({
  dueQueue,
  events,
}: {
  dueQueue: DueQueueRow[];
  events: AutomationFeedRow[];
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
      <section>
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-foreground">Due Queue</h3>
          <p className="text-xs text-muted-foreground">
            Stores that are due now, already running, or waiting for their next automatic pull window.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {dueQueue.slice(0, 6).map((item) => (
            <article
              key={item.integrationId}
              className="rounded-lg border border-border bg-muted/20 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-foreground">{item.label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {item.platform} | {formatMode(item.effectiveMode)} every {item.intervalMinutes}m
                  </div>
                </div>
                <span
                  className={cn(
                    "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium",
                    item.running
                      ? "border-blue-500/30 bg-blue-500/10 text-blue-400"
                      : item.due
                        ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                        : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
                  )}
                >
                  {item.running ? "Running" : item.due ? "Due now" : "Queued"}
                </span>
              </div>
              <div className="mt-3 rounded border border-border bg-background/40 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Next scheduler move
                </div>
                <div className="mt-1 text-sm font-semibold text-foreground">
                  {formatDueWindow(item)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {item.nextDueAt ? `Target: ${formatDateTime(item.nextDueAt)}` : item.reason}
                </div>
              </div>
              <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                <div>Last scheduled pull: {formatDateTime(item.lastScheduledSyncAt)}</div>
                <div>{item.reason}</div>
                {item.fallbackReason ? (
                  <div className="text-amber-400">Fallback: {item.fallbackReason}</div>
                ) : null}
              </div>
            </article>
          ))}
        </div>
        {dueQueue.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No scheduler queue data yet.
          </p>
        )}
      </section>

      <section>
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-foreground">Automation Feed</h3>
          <p className="text-xs text-muted-foreground">
            Recent cron ticks, webhook bursts, and automatic recovery actions.
          </p>
        </div>
        <div className="space-y-3">
          {events.slice(0, 10).map((event) => (
            <article
              key={event.id}
              className="rounded-lg border border-border bg-muted/20 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    {event.title}
                    {event.platform ? (
                      <span className="ml-2 text-xs font-medium text-muted-foreground">
                        {event.platform}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{event.detail}</div>
                </div>
                <span
                  className={cn(
                    "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium capitalize",
                    getAutomationStatusClasses(event.status),
                  )}
                >
                  {event.status.replace("_", " ")}
                </span>
              </div>
              <div className="mt-3 text-[11px] uppercase tracking-wide text-muted-foreground">
                {formatDateTime(event.time)}
              </div>
            </article>
          ))}
        </div>
        {events.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No automation events yet.
          </p>
        )}
      </section>
    </div>
  );
}

export default function EngineRoomPage() {
  const [activeTab, setActiveTab] = useState<TabId>("sync-jobs");
  const [data, setData] = useState<EngineRoomData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadEngineRoom = useCallback(async () => {
    const response = await fetch("/api/engine-room", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Failed to load");
    }
    const json = await response.json();
    return (json.data ?? null) as EngineRoomData | null;
  }, []);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const nextData = await loadEngineRoom();
        if (!active) return;
        setData(nextData);
        setError(null);
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Failed to load engine room data");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void load();
    function handleVisibilityRefresh() {
      if (document.visibilityState !== "visible") return;
      void load();
    }

    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load();
    }, 120_000);

    window.addEventListener("focus", handleVisibilityRefresh);
    document.addEventListener("visibilitychange", handleVisibilityRefresh);

    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", handleVisibilityRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityRefresh);
    };
  }, [loadEngineRoom]);

  const summary = data?.summary ?? {
    activeSyncs: 0,
    queuedPushes: 0,
    recentErrors: 0,
    recentErrorDetail: null as string | null,
    recentErrorAt: null as string | null,
    recentErrorStore: null as string | null,
    writeLockOn: false,
    schedulerEnabled: false,
    schedulerLastTickAt: null as string | null,
    schedulerLastOutcome: null as "dry_run" | "completed" | "failed" | null,
    schedulerLastDueCount: 0,
    schedulerLastDispatchedCount: 0,
    schedulerLastError: null as string | null,
    schedulerActiveJobs: 0,
    schedulerDueNow: 0,
    recentWebhookCount: 0,
    automationHealthStatus: "healthy" as const,
    automationHealthHeadline: "Healthy",
    automationHealthDetail: "All connected stores are refreshing within their expected window.",
    automationHealthAction: "No action needed.",
    delayedStores: 0,
    attentionStores: 0,
  };

  function renderPanel() {
    if (!data) {
      return loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          Loading...
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
      case "automation":
        return (
          <AutomationPanel
            dueQueue={data.dueQueue}
            events={data.automationFeed}
          />
        );
      case "push-jobs":
        return <PushJobsPanel jobs={data.pushJobs} onRefresh={() => void loadEngineRoom()} />;
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
      <div className="mb-6" data-tour="engine-header">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Engine Room
        </h1>
        <p className="text-sm text-muted-foreground">
          Operations control center - sync jobs, push queue, audit trail
        </p>
      </div>

      {/* Summary cards */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-tour="engine-summary">
        <article
          className={cn(
            "rounded-lg border border-border bg-card p-4 transition-colors duration-200",
            "ring-1 ring-border/50",
            "hover:border-border/80 hover:bg-card/95"
          )}
          data-tour="engine-recent-errors"
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
                {loading ? "-" : summary.activeSyncs}
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
                {loading ? "-" : summary.queuedPushes}
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
                {loading ? "-" : summary.recentErrors}
              </p>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Recent Failures (7d)
              </p>
              {!loading && summary.recentErrors > 0 && summary.recentErrorDetail && (
                <p
                  className="mt-1 max-w-full whitespace-normal break-words text-xs leading-relaxed text-red-400/90"
                  title={summary.recentErrorDetail}
                >
                  {summary.recentErrorDetail}
                </p>
              )}
              {!loading && summary.recentErrors > 0 && (
                <p className="mt-1 max-w-full text-[11px] text-muted-foreground">
                  Latest: {summary.recentErrorStore ?? "unknown store"} at {formatDateTime(summary.recentErrorAt)}
                </p>
              )}
            </div>
          </div>
        </article>

        <article
          className={cn(
            "rounded-lg border bg-card p-4 transition-colors duration-200",
            "ring-1",
            summary.automationHealthStatus === "attention"
              ? "border-red-500/30 ring-red-500/20 hover:border-red-500/40"
              : summary.automationHealthStatus === "delayed"
                ? "border-amber-500/30 ring-amber-500/20 hover:border-amber-500/40"
                : "border-emerald-500/30 ring-emerald-500/20 hover:border-emerald-500/40",
          )}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
                summary.automationHealthStatus === "attention"
                  ? "bg-red-500/15 text-red-400"
                  : summary.automationHealthStatus === "delayed"
                    ? "bg-amber-500/15 text-amber-400"
                    : "bg-emerald-500/15 text-emerald-400",
              )}
            >
              <Activity className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {loading ? "-" : summary.automationHealthHeadline}
              </p>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Store Update Health
              </p>
              {!loading && (
                <>
                  <p className="mt-1 max-w-full text-xs text-muted-foreground">
                    {summary.automationHealthDetail}
                  </p>
                  <p className="mt-1 max-w-full text-xs text-muted-foreground">
                    Next step: {summary.automationHealthAction}
                  </p>
                </>
              )}
            </div>
          </div>
          {!loading && (
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              <span>Delayed {summary.delayedStores}</span>
              <span>Attention {summary.attentionStores}</span>
            </div>
          )}
        </article>

        <article
          className={cn(
            "rounded-lg border border-amber-500/30 bg-card p-4 transition-colors duration-200",
            "ring-1 ring-amber-500/20",
            "hover:border-amber-500/40 hover:bg-card/95"
          )}
          data-tour="engine-write-lock"
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
                {loading ? "-" : summary.writeLockOn ? "ON" : "OFF"}
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
          data-tour="engine-scheduler"
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
                {summary.schedulerLastOutcome ? ` | Result: ${summary.schedulerLastOutcome}` : ""}
                {summary.schedulerActiveJobs > 0 ? ` | ${summary.schedulerActiveJobs} scheduled sync(s) running` : ""}
              </p>
            </div>
            <div className="grid min-w-[320px] grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
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
                  {summary.schedulerLastOutcome ?? "-"}
                </div>
              </div>
            </div>
          </div>
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded border border-border bg-muted/30 px-3 py-2">
              <div className="text-muted-foreground">Stores Due Right Now</div>
              <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">
                {summary.schedulerDueNow}
              </div>
            </div>
            <div className="rounded border border-border bg-muted/30 px-3 py-2">
              <div className="text-muted-foreground">Webhook Events In Last 24 Hours</div>
              <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">
                {summary.recentWebhookCount}
              </div>
            </div>
          </div>
          {summary.schedulerLastError && (
            <div className="mt-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              Last scheduler error: {summary.schedulerLastError}
            </div>
          )}
          {!!data?.integrationHealth?.length && (
            <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {data.integrationHealth.slice(0, 4).map((item) => (
                <div
                  key={item.integrationId}
                  className="rounded border border-border bg-background/40 px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">{item.label}</span>
                    <span
                      className={cn(
                        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium uppercase",
                        getHealthClasses(item.combinedStatus),
                      )}
                    >
                      {item.combinedStatus}
                    </span>
                  </div>
                  <div className="mt-2 text-muted-foreground">{item.syncMessage}</div>
                  <div className="mt-1 text-muted-foreground">
                    Last completed pull: {formatDateTime(item.lastSyncAt)}
                  </div>
                  {item.combinedStatus !== "healthy" ? (
                    <div
                      className={cn(
                        "mt-2 rounded border px-2 py-1 text-[11px]",
                        item.combinedStatus === "attention"
                          ? "border-red-500/20 bg-red-500/5 text-red-300"
                          : "border-amber-500/20 bg-amber-500/5 text-amber-300",
                      )}
                    >
                      Next step: {item.recommendedAction}
                    </div>
                  ) : null}
                  <div className="mt-1 text-muted-foreground">
                    {item.running
                      ? "A pull is running now."
                      : item.due
                        ? "Another pull is due now."
                        : item.nextDueAt
                          ? `Next automatic check: ${formatDateTime(item.nextDueAt)}`
                          : "No next automatic check scheduled."}
                  </div>
                  {item.webhookExpected ? (
                    <div className="mt-2 rounded border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                      {item.webhookMessage}
                    </div>
                  ) : null}
                  {item.webhookExpected ? (
                    <div className="mt-2 rounded border border-border bg-background/40 px-2 py-1 text-[11px] text-muted-foreground">
                      {item.recentWebhookCount24h > 0
                        ? `${item.recentWebhookCount24h.toLocaleString()} marketplace notice${item.recentWebhookCount24h === 1 ? "" : "s"} recorded in the last 24h.`
                        : "No marketplace notices recorded in the last 24h."}
                      {item.lastWebhookMessage ? ` Latest result: ${item.lastWebhookMessage}` : ""}
                    </div>
                  ) : null}
                  {item.webhookExpected ? (
                    <div
                      className={cn(
                        "mt-2 rounded border px-2 py-1 text-[11px]",
                        getWebhookProofClasses(item.webhookProofStatus),
                      )}
                    >
                      <div>{item.webhookProofMessage}</div>
                      {item.lastWebhookTopic ? (
                        <div className="mt-1 text-[10px] uppercase tracking-wide opacity-80">
                          Topic: {item.lastWebhookTopic}
                          {item.lastWebhookEventStatus
                            ? ` • ${item.lastWebhookEventStatus}`
                            : ""}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {item.pendingBacklogCount > 0 ? (
                    <div className="mt-2 rounded border border-blue-500/20 bg-blue-500/5 px-2 py-1 text-[11px] text-blue-300">
                      Queued changed listings: {item.pendingBacklogCount.toLocaleString()}
                      {item.pendingBacklogWindowEndedAt
                        ? ` from window ending ${formatDateTime(item.pendingBacklogWindowEndedAt)}`
                        : ""}
                    </div>
                  ) : null}
                  {item.rateLimits ? (
                    <div className="mt-2 rounded border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                      <div>eBay API checked {formatDateTime(item.rateLimits.fetchedAt)}</div>
                      <div>
                        {item.rateLimits.methods
                          .map(
                            (method) =>
                              `${method.name}: ${method.remaining.toLocaleString()}/${method.limit.toLocaleString()} left`,
                          )
                          .join(" • ")}
                      </div>
                      {item.rateLimits.nextResetAt ? (
                        <div>Reset: {formatDateTime(item.rateLimits.nextResetAt)}</div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </article>
      </div>

      {/* Tabbed section */}
      <div
        data-tour="engine-tabs"
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
          data-tour="engine-table"
          id={`panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`tab-${activeTab}`}
          className="min-h-[280px] p-6"
        >
          {renderPanel()}
        </div>
      </div>
      <PageTour page="engineRoom" steps={PAGE_TOUR_STEPS.engineRoom} ready />
    </div>
  );
}
