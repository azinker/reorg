"use client";

import {
  RefreshCw,
  XCircle,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Circle,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tip";
import { SyncProgress } from "@/components/sync/SyncProgress";
import { SyncErrors } from "@/components/sync/SyncErrors";
import { EbayQuotaPanel } from "@/components/sync/EbayQuotaPanel";
import type {
  StoreEntry,
  IntegrationStatus,
  SyncPageState,
  SyncJobInfo,
  SyncRouteData,
  SchedulerStatus,
  SyncError,
} from "@/lib/sync-types";
import { LOGO_MAP } from "@/lib/sync-types";
import type { IntegrationSyncState, SyncProfile } from "@/lib/sync-types";
import {
  formatRelativeTime,
  formatCountdown,
  formatSchedule,
  formatDurationMs,
  getJobDurationMs,
  getRelevantFallbackReason,
  getCompletionSummary,
  getNextPullAt,
} from "@/lib/sync-utils";

function formatHour(h: number) {
  if (h === 0 || h === 24) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function formatIntervalShort(minutes: number) {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

function wasCompletedWithin(
  isoTimestamp: string | null | undefined,
  thresholdMs: number,
  nowMs: number,
) {
  if (!isoTimestamp) return false;
  const elapsed = nowMs - new Date(isoTimestamp).getTime();
  return elapsed >= 0 && elapsed < thresholdMs;
}

function ScheduleParamRow({
  label,
  value,
  completed,
  lastAt,
  nowMs,
}: {
  label: string;
  value: string;
  completed: boolean;
  lastAt?: string | null;
  nowMs?: number;
}) {
  const timestamp = completed && lastAt && nowMs
    ? formatRelativeTime(lastAt, nowMs)
    : null;

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1.5">
        {completed ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        ) : (
          <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
        )}
        <span className="text-[11px] text-muted-foreground">{label}</span>
        {timestamp && (
          <span className="text-[10px] text-emerald-500/70">{timestamp}</span>
        )}
      </div>
      <span className={cn(
        "text-[11px] font-semibold tabular-nums",
        completed ? "text-emerald-400" : "text-foreground/70",
      )}>
        {value}
      </span>
    </div>
  );
}

function parseTriggeredBy(triggeredBy: string | null | undefined) {
  if (!triggeredBy) return { source: "unknown", mode: "unknown" };
  const isScheduler = triggeredBy.startsWith("scheduler:");
  const mode = triggeredBy.includes("full") ? "full" : triggeredBy.includes("incremental") ? "incremental" : "unknown";
  return { source: isScheduler ? "scheduler" : "manual", mode };
}

function ScheduleParams({
  syncProfile,
  syncState,
  nowMs,
  isEbay,
  liveJob,
}: {
  syncProfile: SyncProfile;
  syncState: IntegrationSyncState | null;
  nowMs: number;
  isEbay: boolean;
  liveJob: SyncJobInfo | null;
}) {
  const normalInterval = syncProfile.dayIntervalMinutes;
  const overnightInterval = syncProfile.overnightIntervalMinutes;
  const fullInterval = syncProfile.fullReconcileIntervalHours;

  const lastIncremental = syncState?.lastIncrementalSyncAt;
  const lastFull = syncState?.lastFullSyncAt;

  const normalDone = wasCompletedWithin(lastIncremental, normalInterval * 60 * 1000, nowMs);
  const fullDone = wasCompletedWithin(lastFull, fullInterval * 60 * 60 * 1000, nowMs);

  const jobDone = liveJob && (liveJob.status === "COMPLETED" || liveJob.status === "FAILED");
  const { source, mode } = parseTriggeredBy(liveJob?.triggeredBy);
  const isManual = jobDone && source === "manual";
  const manualTimestamp = isManual ? (liveJob.completedAt ?? liveJob.startedAt) : null;

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <Clock className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Schedule
        </span>
      </div>
      <div className="space-y-1.5">
        <ScheduleParamRow
          label="Normal sync"
          value={`Every ${formatIntervalShort(normalInterval)}`}
          completed={normalDone}
          lastAt={lastIncremental}
          nowMs={nowMs}
        />
        <ScheduleParamRow
          label="Overnight"
          value={`Every ${formatIntervalShort(overnightInterval)}`}
          completed={false}
        />
        <ScheduleParamRow
          label="Full sync"
          value={`Every ${fullInterval}h`}
          completed={fullDone}
          lastAt={lastFull}
          nowMs={nowMs}
        />
        <ScheduleParamRow
          label="Active hours"
          value={`${formatHour(syncProfile.dayStartHour)} – ${formatHour(syncProfile.dayEndHour)}`}
          completed={false}
        />
      </div>

      {isManual && manualTimestamp && (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-md border border-blue-500/20 bg-blue-500/5 px-2.5 py-1.5 dark:bg-blue-500/10">
          <User className="h-3 w-3 shrink-0 text-blue-400" />
          <span className="text-[11px] text-blue-300">
            <span className="font-semibold">Manual {mode === "full" ? "Full Sync" : "Normal Sync"}</span>
            {" \u2014 "}
            {liveJob.status === "COMPLETED" ? (
              <CheckCircle2 className="inline h-3 w-3 text-emerald-500" />
            ) : (
              <XCircle className="inline h-3 w-3 text-red-400" />
            )}
            {" "}
            {liveJob.status === "COMPLETED" ? "succeeded" : "failed"}
            {" \u00B7 "}
            {formatRelativeTime(manualTimestamp, nowMs)}
          </span>
        </div>
      )}
    </div>
  );
}

type Props = {
  store: StoreEntry;
  status: IntegrationStatus | undefined;
  storeSync: SyncPageState;
  result: string | undefined;
  liveJob: SyncJobInfo | null;
  meta: SyncRouteData | null;
  errorsExpanded: boolean;
  copied: boolean;
  nowMs: number;
  schedulerEnabled: boolean;
  schedulerStatus: SchedulerStatus | null;
  onSync: (apiPlatform: string, mode?: "full" | "incremental") => void;
  onCancel: (apiPlatform: string) => void;
  onCopyErrors: (apiPlatform: string) => void;
  onToggleErrors: (apiPlatform: string) => void;
  onToggleUpc: (apiPlatform: string) => void;
};

export function SyncStoreCard({
  store,
  status,
  storeSync,
  result,
  liveJob,
  meta,
  errorsExpanded,
  copied,
  nowMs,
  schedulerEnabled,
  schedulerStatus,
  onSync,
  onCancel,
  onCopyErrors,
  onToggleErrors,
  onToggleUpc,
}: Props) {
  const connected = status?.connected ?? false;
  const syncProfile = meta?.syncProfile ?? null;
  const syncState = meta?.syncState ?? null;
  const cooldown = meta?.cooldown ?? null;
  const isSyncing = storeSync === "syncing";
  const jobErrors = (liveJob?.errors ?? []) as SyncError[];
  const durationMs = getJobDurationMs(liveJob, nowMs);
  const cooldownActive = Boolean(cooldown?.active);
  const nextPullAt = cooldownActive
    ? cooldown?.until ? new Date(cooldown.until) : null
    : syncProfile ? getNextPullAt(syncProfile, new Date(nowMs), store.apiPlatform) : null;
  const relevantFallbackReason = syncProfile ? getRelevantFallbackReason(syncProfile, syncState) : null;
  const completionSummary = getCompletionSummary(liveJob, relevantFallbackReason);
  const healthItem = schedulerStatus?.integrationHealth?.find((h) => h.platform === store.apiPlatform);
  const healthStatus = healthItem?.combinedStatus ?? (connected ? "healthy" : undefined);
  const rateLimits = meta?.rateLimits ?? null;
  const logoSrc = LOGO_MAP[store.platform];
  const pendingBacklogCount = syncState?.pendingIncrementalItemIds?.length ?? 0;
  const isEbay = store.platform === "eBay";

  return (
    <article
      className={cn(
        "relative rounded-xl border bg-card transition-all duration-300",
        isSyncing
          ? "border-violet-500/40 shadow-[0_0_20px_rgba(139,92,246,0.06)]"
          : "border-border hover:border-violet-500/20",
      )}
    >
      {isSyncing && (
        <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-violet-600 via-purple-500 to-violet-600 animate-pulse" />
      )}

      <div className="p-5">
        {/* Card header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            {logoSrc && (
              <img src={logoSrc} alt={store.platform} width={22} height={22} className="shrink-0" style={{ width: 22, height: 22 }} />
            )}
            <h3 className="truncate text-lg font-semibold text-foreground">{store.name}</h3>
            <span className="shrink-0 rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[11px] font-bold text-violet-400">
              {store.acronym}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {healthStatus && (
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  healthStatus === "healthy"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                    : healthStatus === "delayed"
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                      : "border-red-500/30 bg-red-500/10 text-red-400",
                )}
              >
                {healthStatus}
              </span>
            )}
            <span className={cn("flex items-center gap-1 text-xs font-medium", connected ? "text-emerald-400" : "text-muted-foreground")}>
              <span className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-400" : "bg-muted-foreground")} />
              {connected ? "Live" : "Offline"}
            </span>
          </div>
        </div>

        {/* Stats: Next pull + Last sync */}
        <div className="mt-5 grid grid-cols-2 gap-3" data-tour="sync-store-stats">
          <div className="rounded-lg border border-violet-500/15 bg-violet-500/[0.03] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Next Pull</div>
            <div className="mt-1.5 text-xl font-bold tabular-nums text-violet-400">
              {connected && syncProfile?.autoSyncEnabled && schedulerEnabled
                ? formatCountdown(nextPullAt, nowMs)
                : cooldownActive ? "Cooldown" : "\u2014"}
            </div>
            <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
              {syncProfile ? formatSchedule(syncProfile, store.apiPlatform) : "No schedule configured"}
            </div>
            {syncState?.lastEffectiveMode && (
              <div className="mt-1.5">
                <span className="rounded border border-violet-500/20 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-violet-400">
                  {syncState.lastEffectiveMode}
                </span>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/[0.03] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Last Sync</div>
            <div className="mt-1.5 text-xl font-bold tabular-nums text-foreground">
              {formatRelativeTime(status?.lastSyncAt ?? null, nowMs)}
            </div>
            <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
              {liveJob && liveJob.status !== "RUNNING"
                ? `${liveJob.itemsProcessed.toLocaleString()} items${durationMs ? ` \u00B7 ${formatDurationMs(durationMs)}` : ""}`
                : "\u2014"}
            </div>
            <div className="mt-1.5">
              <span
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                  completionSummary.tone === "success" ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                    : completionSummary.tone === "warning" ? "border-amber-500/20 bg-amber-500/10 text-amber-400"
                    : completionSummary.tone === "error" ? "border-red-500/20 bg-red-500/10 text-red-400"
                    : "border-border bg-muted/50 text-muted-foreground",
                )}
              >
                {completionSummary.label}
              </span>
            </div>
          </div>
        </div>

        {/* Schedule parameters */}
        {syncProfile && (
          <ScheduleParams
            syncProfile={syncProfile}
            syncState={syncState}
            nowMs={nowMs}
            isEbay={isEbay}
            liveJob={liveJob}
          />
        )}

        {/* Attention / delayed detail */}
        {(healthStatus === "attention" || healthStatus === "delayed") && healthItem && !isSyncing && (
          <div className={cn(
            "mt-4 rounded-lg border px-3 py-2.5 text-xs",
            healthStatus === "attention"
              ? "border-red-500/30 bg-red-500/[0.06] text-red-300"
              : "border-amber-500/30 bg-amber-500/[0.06] text-amber-300",
          )}>
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0 space-y-1">
                <p className="font-semibold leading-snug">{healthItem.syncMessage}</p>
                {healthItem.webhookStatus !== "ok" && healthItem.webhookStatus !== "n/a" && (
                  <p className="leading-snug opacity-80">{healthItem.webhookMessage}</p>
                )}
                {healthItem.recommendedAction && (
                  <p className="leading-snug opacity-70">&rarr; {healthItem.recommendedAction}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* eBay-specific panels */}
        {isEbay && (
          <EbayQuotaPanel
            rateLimits={rateLimits}
            syncProfile={syncProfile}
            isSyncing={isSyncing}
            nowMs={nowMs}
            apiPlatform={store.apiPlatform}
            onToggleUpc={() => onToggleUpc(store.apiPlatform)}
          />
        )}

        {/* Live progress */}
        <SyncProgress
          liveJob={liveJob}
          isSyncing={isSyncing}
          durationMs={durationMs}
          platform={store.platform}
        />

        {/* Result message */}
        {result && (
          <div
            className={cn(
              "mt-4 rounded-lg px-3 py-2 text-xs font-medium",
              storeSync === "error"
                ? "bg-red-500/10 text-red-400"
                : isSyncing
                  ? "bg-violet-500/10 text-violet-300"
                  : "bg-emerald-500/10 text-emerald-400",
            )}
          >
            {result}
          </div>
        )}

        {/* Cooldown alert */}
        {cooldownActive && (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <span className="font-semibold">eBay daily quota reached</span>
            {cooldown?.retryLabel ? ` \u2014 resets around ${cooldown.retryLabel}` : " \u2014 waiting for quota reset"}
          </div>
        )}

        {/* Pending backlog */}
        {pendingBacklogCount > 0 && (
          <div className="mt-4 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-300">
            {pendingBacklogCount.toLocaleString()} changed listing{pendingBacklogCount === 1 ? "" : "s"} queued for next pull
          </div>
        )}

        {/* Fallback reason */}
        {relevantFallbackReason && !isSyncing && (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
            {relevantFallbackReason}
          </div>
        )}

        {/* Errors */}
        <SyncErrors
          errors={jobErrors}
          expanded={errorsExpanded}
          isSyncing={isSyncing}
          copied={copied}
          onToggle={() => onToggleErrors(store.apiPlatform)}
          onCopy={() => onCopyErrors(store.apiPlatform)}
        />

        {/* Action buttons */}
        <div className="mt-5 flex flex-wrap items-center gap-2" data-tour="sync-store-actions">
          <Tip text={
            cooldownActive
              ? "Incremental sync is still available \u2014 it uses GetSellerEvents and GetSellerList, which have their own separate quota (not GetItem). Safe to run."
              : "Quick sync \u2014 pulls only the most recent changes since the last update. Fast and efficient for routine refreshes."
          }>
            <button
              type="button"
              disabled={!connected || isSyncing}
              onClick={() => onSync(store.apiPlatform)}
              className={cn(
                "inline-flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors",
                "border-violet-500/30 bg-violet-500/10 text-violet-400 hover:bg-violet-500/20",
                "disabled:cursor-not-allowed disabled:opacity-40",
              )}
            >
              {isSyncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {isSyncing ? "Syncing..." : "Sync"}
            </button>
          </Tip>

          <Tip text={
            cooldownActive
              ? `Full Sync is blocked \u2014 it relies heavily on GetItem which is at its daily limit. Resume after the quota resets${cooldown?.retryLabel ? ` around ${cooldown.retryLabel}` : ""}.`
              : "Full catalog sync \u2014 re-downloads every listing from the marketplace from scratch. Use when data looks out of date or after major changes."
          }>
            <button
              type="button"
              disabled={!connected || isSyncing || cooldownActive}
              onClick={() => onSync(store.apiPlatform, "full")}
              className={cn(
                "inline-flex cursor-pointer items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                "bg-violet-600 text-white hover:bg-violet-500",
                "disabled:cursor-not-allowed disabled:opacity-40",
              )}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Full Sync
            </button>
          </Tip>

          <Tip text="Stops the current sync. All progress made so far is saved \u2014 nothing is lost or rolled back.">
            <button
              type="button"
              disabled={!connected || !isSyncing}
              onClick={() => onCancel(store.apiPlatform)}
              className={cn(
                "inline-flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors",
                "border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/15",
                "disabled:cursor-not-allowed disabled:opacity-40",
              )}
            >
              <XCircle className="h-3.5 w-3.5" />
              Cancel
            </button>
          </Tip>
        </div>
      </div>
    </article>
  );
}
