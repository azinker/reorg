"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  RefreshCw,
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  Copy,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  TimerReset,
} from "lucide-react";
import { cn } from "@/lib/utils";

const LOGO_MAP: Record<string, string> = {
  eBay: "/logos/ebay.svg",
  BigCommerce: "/logos/bigcommerce.svg",
  Shopify: "/logos/shopify.svg",
};

const stores = [
  { id: "tpp", name: "The Perfect Part", acronym: "TPP", platform: "eBay", apiPlatform: "TPP_EBAY", theme: "blue" },
  { id: "tt", name: "Telitetech", acronym: "TT", platform: "eBay", apiPlatform: "TT_EBAY", theme: "emerald" },
  { id: "bc", name: "BigCommerce", acronym: "BC", platform: "BigCommerce", apiPlatform: "BIGCOMMERCE", theme: "orange" },
  { id: "shpfy", name: "Shopify", acronym: "SHPFY", platform: "Shopify", apiPlatform: "SHOPIFY", theme: "lime" },
] as const;

const themeClasses = {
  blue: { badge: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  emerald: { badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  orange: { badge: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  lime: { badge: "bg-lime-500/15 text-lime-400 border-lime-500/30" },
} as const;

type IntegrationStatus = {
  platform: string;
  label: string;
  enabled: boolean;
  connected: boolean;
  lastSyncAt: string | null;
};

type SyncPageState = "idle" | "syncing" | "done" | "error";

type SyncError = { sku: string; message: string };

type SyncProfile = {
  autoSyncEnabled: boolean;
  timezone: string;
  dayStartHour: number;
  dayEndHour: number;
  dayIntervalMinutes: number;
  overnightIntervalMinutes: number;
  preferredMode: "full" | "incremental";
  fullReconcileIntervalHours: number;
  incrementalStrategy: string;
};

type IntegrationSyncState = {
  lastRequestedMode: "full" | "incremental" | null;
  lastEffectiveMode: "full" | "incremental" | null;
  lastScheduledSyncAt: string | null;
  lastFullSyncAt: string | null;
  lastIncrementalSyncAt: string | null;
  lastCursor: string | null;
  lastWebhookAt: string | null;
  lastFallbackReason: string | null;
};

type IntegrationWebhookState = {
  destination: string | null;
  topics: string[];
  providerIds: string[];
  lastEnsuredAt: string | null;
  lastEnsureError: string | null;
};

type SyncJobInfo = {
  id: string;
  status: string;
  itemsProcessed: number;
  itemsCreated: number;
  itemsUpdated: number;
  errors: SyncError[];
  startedAt: string | null;
  completedAt: string | null;
};

type SyncRouteData = {
  integrationId: string;
  platform: string;
  label: string;
  enabled: boolean;
  lastSyncAt: string | null;
  syncProfile: SyncProfile;
  syncState: IntegrationSyncState;
  webhookState: IntegrationWebhookState;
  webhookHealth: {
    status: "ok" | "warning" | "info";
    message: string;
    expectedDestination: string | null;
    currentDestination: string | null;
  };
  lastJob: SyncJobInfo | null;
};

type CompletionTone = "success" | "warning" | "error" | "info";

type SchedulerStatus = {
  enabled: boolean;
  lastTickAt: string | null;
  lastOutcome: "dry_run" | "completed" | "failed" | null;
  lastDueCount: number;
  lastDispatchedCount: number;
  lastError: string | null;
  runningCount: number;
  dueNowCount: number;
  healthSummary: {
    status: "healthy" | "delayed" | "attention";
    healthyCount: number;
    delayedCount: number;
    attentionCount: number;
    headline: string;
    detail: string;
  };
  integrationHealth: Array<{
    integrationId: string;
    label: string;
    platform: string;
    status: "healthy" | "delayed" | "attention";
    combinedStatus: "healthy" | "delayed" | "attention";
    syncStatus: "fresh" | "delayed" | "stale" | "never";
    syncMessage: string;
    lastSyncAt: string | null;
    minutesSinceSync: number | null;
    intervalMinutes: number;
    due: boolean;
    running: boolean;
    nextDueAt: string | null;
    webhookExpected: boolean;
    lastWebhookAt: string | null;
    minutesSinceWebhook: number | null;
    webhookStatus: "ok" | "quiet" | "missing" | "n/a";
    webhookMessage: string;
  }>;
  recentJobs: Array<{
    id: string;
    platform: string;
    label: string;
    mode: string;
    status: string;
    itemsProcessed: number;
    itemsCreated: number;
    itemsUpdated: number;
    startedAt: string | null;
    completedAt: string | null;
    latestStoreSyncAt: string | null;
    recoveredAfterScheduledFailure: boolean;
  }>;
  recentWebhooks: Array<{
    id: string;
    platform: string;
    topic: string;
    status: string;
    message: string;
    receivedAt: string;
  }>;
  upcoming: Array<{
    integrationId: string;
    platform: string;
    label: string;
    due: boolean;
    running: boolean;
    requestedMode: string;
    effectiveMode: string;
    intervalMinutes: number;
    lastScheduledSyncAt: string | null;
    nextDueAt: string | null;
    minutesUntilDue: number | null;
    reason: string;
    fallbackReason: string | null;
  }>;
  automationEvents: Array<{
    id: string;
    type: "scheduler_tick" | "stale_job" | "webhook";
    title: string;
    status: "completed" | "dry_run" | "failed" | "warning" | "ignored" | "debounced" | "running" | "started" | "unknown";
    platform: string | null;
    detail: string;
    occurredAt: string;
  }>;
};

function formatDateTime(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function formatDurationMs(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatModeLabel(mode: string | null) {
  if (!mode) return "Unknown";
  if (mode === "incremental") return "Incremental";
  if (mode === "full") return "Full";
  return mode
    .split(":")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDueCountdown(minutesUntilDue: number | null, due: boolean, running: boolean) {
  if (running) return "Running now";
  if (due) return "Due now";
  if (minutesUntilDue == null) return "Not scheduled";
  if (minutesUntilDue === 0) return "Due within 1m";
  if (minutesUntilDue < 60) return `Due in ${minutesUntilDue}m`;
  const hours = Math.floor(minutesUntilDue / 60);
  const minutes = minutesUntilDue % 60;
  return minutes > 0 ? `Due in ${hours}h ${minutes}m` : `Due in ${hours}h`;
}

function getAutomationBadgeClasses(
  status: SchedulerStatus["automationEvents"][number]["status"],
) {
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

function getReadableJobStatus(status: string) {
  if (status === "RUNNING") return "Updating now";
  if (status === "COMPLETED") return "Last scheduled update finished";
  if (status === "FAILED") return "Last scheduled update did not finish";
  return status;
}

function getReadableWebhookStatus(status: string) {
  if (status === "started") return "started a refresh";
  if (status === "running") return "covered by a current refresh";
  if (status === "debounced") return "already covered";
  if (status === "ignored") return "recorded only";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return status;
}

function getHealthClasses(status: "healthy" | "delayed" | "attention") {
  if (status === "attention") {
    return "border-red-500/30 bg-red-500/10 text-red-300";
  }
  if (status === "delayed") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  }
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
}

function getJobDurationMs(job: SyncJobInfo | null, now: number) {
  if (!job?.startedAt) return null;
  const startedAt = new Date(job.startedAt).getTime();
  const finishedAt = job.completedAt ? new Date(job.completedAt).getTime() : now;
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return null;
  return Math.max(0, finishedAt - startedAt);
}

function getLocalDateTimeParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = getLocalDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

function zonedDateTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

function addDaysToParts(
  parts: ReturnType<typeof getLocalDateTimeParts>,
  days: number,
  timeZone: string,
) {
  const baseUtc = zonedDateTimeToUtc(
    timeZone,
    parts.year,
    parts.month,
    parts.day,
    12,
    0,
    0,
  );
  baseUtc.setUTCDate(baseUtc.getUTCDate() + days);
  return getLocalDateTimeParts(baseUtc, timeZone);
}

function getNextPullAt(profile: SyncProfile, now: Date) {
  if (!profile.autoSyncEnabled) return null;

  const nowParts = getLocalDateTimeParts(now, profile.timezone);
  const candidates: Date[] = [];

  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const dayParts = addDaysToParts(nowParts, dayOffset, profile.timezone);

    for (
      let minute = profile.dayStartHour * 60;
      minute < profile.dayEndHour * 60;
      minute += profile.dayIntervalMinutes
    ) {
      candidates.push(
        zonedDateTimeToUtc(
          profile.timezone,
          dayParts.year,
          dayParts.month,
          dayParts.day,
          Math.floor(minute / 60),
          minute % 60,
        ),
      );
    }

    const overnightEnd = profile.dayStartHour * 60 + 24 * 60;
    for (
      let minute = profile.dayEndHour * 60;
      minute < overnightEnd;
      minute += profile.overnightIntervalMinutes
    ) {
      const targetDayParts =
        minute >= 24 * 60
          ? addDaysToParts(dayParts, 1, profile.timezone)
          : dayParts;
      const normalizedMinute = minute % (24 * 60);
      candidates.push(
        zonedDateTimeToUtc(
          profile.timezone,
          targetDayParts.year,
          targetDayParts.month,
          targetDayParts.day,
          Math.floor(normalizedMinute / 60),
          normalizedMinute % 60,
        ),
      );
    }
  }

  const nowTime = now.getTime();
  return candidates
    .filter((candidate) => candidate.getTime() > nowTime)
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

function formatCountdown(target: Date | null, now: number) {
  if (!target) return "Not scheduled";
  const remaining = target.getTime() - now;
  if (remaining <= 0) return "Due now";

  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatSchedule(profile: SyncProfile) {
  const overnightWindowMinutes =
    (24 - profile.dayEndHour + profile.dayStartHour) * 60;
  const overnightLabel =
    profile.overnightIntervalMinutes >= overnightWindowMinutes
      ? "Once overnight"
      : profile.overnightIntervalMinutes >= 60 &&
          profile.overnightIntervalMinutes % 60 === 0
        ? `Every ${profile.overnightIntervalMinutes / 60}h overnight`
        : `Every ${profile.overnightIntervalMinutes}m overnight`;

  const daytimeLabel =
    profile.dayIntervalMinutes >= 60 && profile.dayIntervalMinutes % 60 === 0
      ? `Every ${profile.dayIntervalMinutes / 60}h`
      : `Every ${profile.dayIntervalMinutes}m`;

  return `${daytimeLabel} from ${profile.dayStartHour}:00-${profile.dayEndHour}:00, ${overnightLabel}`;
}

function usesWebhookWakeup(profile: SyncProfile) {
  return (
    profile.incrementalStrategy === "shopify_webhook_reconcile" ||
    profile.incrementalStrategy === "bigcommerce_webhook_reconcile"
  );
}

function getCompletionSummary(
  job: SyncJobInfo | null,
  fallbackReason: string | null,
): { label: string; tone: CompletionTone; detail: string } {
  if (!job) {
    return {
      label: "No sync yet",
      tone: "info",
      detail: "No completed sync has been recorded for this store yet.",
    };
  }

  const issueCount = Array.isArray(job.errors) ? job.errors.length : 0;

  if (job.status === "RUNNING") {
    return {
      label: "Sync running",
      tone: "info",
      detail: "Pull is in progress now.",
    };
  }

  if (job.status === "FAILED") {
    return {
      label: "Sync failed",
      tone: "error",
      detail:
        issueCount > 0
          ? `${issueCount} issue${issueCount === 1 ? "" : "s"} blocked completion.`
          : "The last pull did not complete successfully.",
    };
  }

  if (issueCount > 0) {
    return {
      label: "Semi-complete",
      tone: "warning",
      detail: `100% finished, but ${issueCount} row${issueCount === 1 ? "" : "s"} had issues and may have been skipped.`,
    };
  }

  return {
    label: "100% complete",
    tone: "success",
    detail: fallbackReason
      ? "Completed successfully with a safe fallback path."
      : "Completed successfully with no reported errors.",
  };
}

export default function SyncPage() {
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [schedulerEnabled, setSchedulerEnabled] = useState(false);
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [syncing, setSyncing] = useState<Record<string, SyncPageState>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const [liveJobs, setLiveJobs] = useState<Record<string, SyncJobInfo | null>>({});
  const [syncMeta, setSyncMeta] = useState<Record<string, SyncRouteData | null>>(
    {},
  );
  const [errorsExpanded, setErrorsExpanded] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [syncAllRunning, setSyncAllRunning] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const initialCheckDone = useRef(false);

  const fetchIntegrations = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations");
      const json = await res.json();
      if (json.data) setIntegrations(json.data);
    } catch {
      // ignore
    }
  }, []);

  const fetchSchedulerSetting = useCallback(async () => {
    try {
      const res = await fetch("/api/settings?key=scheduler_enabled");
      const json = await res.json();
      setSchedulerEnabled(Boolean(json.data));
    } catch {
      setSchedulerEnabled(false);
    }
  }, []);

  const fetchSchedulerStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/scheduler/status", { cache: "no-store" });
      const json = await res.json();
      setSchedulerStatus((json.data ?? null) as SchedulerStatus | null);
    } catch {
      setSchedulerStatus(null);
    }
  }, []);

  useEffect(() => {
    fetchIntegrations();
    fetchSchedulerSetting();
    fetchSchedulerStatus();
    const schedulerTimer = setInterval(fetchSchedulerStatus, 30_000);
    return () => {
      Object.values(pollTimers.current).forEach(clearInterval);
      clearInterval(schedulerTimer);
    };
  }, [fetchIntegrations, fetchSchedulerSetting, fetchSchedulerStatus]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const getStatus = (apiPlatform: string) =>
    integrations.find((integration) => integration.platform === apiPlatform);

  function copyErrors(apiPlatform: string) {
    const job = liveJobs[apiPlatform];
    if (!job?.errors?.length) return;

    const text = job.errors
      .map((error) => `Item: ${error.sku}\nError: ${error.message}`)
      .join("\n\n---\n\n");
    const header = `=== ${apiPlatform} Sync Errors (${job.errors.length}) ===\nJob ID: ${job.id}\nCompleted: ${job.completedAt ?? "N/A"}\n\n`;

    navigator.clipboard.writeText(header + text).then(() => {
      setCopied(apiPlatform);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  const loadStoreStatus = useCallback(async (apiPlatform: string) => {
    const res = await fetch(`/api/sync/${apiPlatform}`);
    const json = await res.json();
    const data = (json.data ?? null) as SyncRouteData | null;

    if (!data) return null;

    setSyncMeta((prev) => ({ ...prev, [apiPlatform]: data }));
    setLiveJobs((prev) => ({ ...prev, [apiPlatform]: data.lastJob }));

    return data;
  }, []);

  const pollSyncStatus = useCallback(
    (apiPlatform: string) => {
      if (pollTimers.current[apiPlatform]) {
        clearInterval(pollTimers.current[apiPlatform]);
      }

      const timer = setInterval(async () => {
        try {
          const data = await loadStoreStatus(apiPlatform);
          const job = data?.lastJob ?? null;

          if (job && (job.status === "COMPLETED" || job.status === "FAILED")) {
            clearInterval(pollTimers.current[apiPlatform]);
            delete pollTimers.current[apiPlatform];

            const issueCount = Array.isArray(job.errors) ? job.errors.length : 0;
            const message =
              job.status === "COMPLETED"
                ? `Done - ${job.itemsProcessed} processed, ${job.itemsCreated} created, ${job.itemsUpdated} updated${issueCount > 0 ? `, ${issueCount} issues` : ""}`
                : "Failed - see details below";

            setSyncing((prev) => ({
              ...prev,
              [apiPlatform]: job.status === "COMPLETED" ? "done" : "error",
            }));
            setResults((prev) => ({ ...prev, [apiPlatform]: message }));

            if (issueCount > 0) {
              setErrorsExpanded((prev) => ({ ...prev, [apiPlatform]: true }));
            }

            fetchIntegrations();
            fetchSchedulerStatus();
          }
        } catch {
          // ignore
        }
      }, 2000);

      pollTimers.current[apiPlatform] = timer;
    },
    [fetchIntegrations, fetchSchedulerStatus, loadStoreStatus],
  );

  useEffect(() => {
    if (initialCheckDone.current) return;
    initialCheckDone.current = true;

    (async () => {
      for (const store of stores) {
        try {
          const data = await loadStoreStatus(store.apiPlatform);
          const job = data?.lastJob ?? null;
          if (!job) continue;

          if (job.status === "RUNNING") {
            setSyncing((prev) => ({ ...prev, [store.apiPlatform]: "syncing" }));
            pollSyncStatus(store.apiPlatform);
          } else if (job.status === "COMPLETED" || job.status === "FAILED") {
            const issueCount = Array.isArray(job.errors) ? job.errors.length : 0;
            const message =
              job.status === "COMPLETED"
                ? `Last sync: ${job.itemsProcessed} processed, ${job.itemsCreated} created, ${job.itemsUpdated} updated${issueCount > 0 ? `, ${issueCount} issues` : ""}`
                : "Last sync failed - see details below";

            setSyncing((prev) => ({
              ...prev,
              [store.apiPlatform]: job.status === "COMPLETED" ? "done" : "error",
            }));
            setResults((prev) => ({ ...prev, [store.apiPlatform]: message }));
          }
        } catch {
          // ignore
        }
      }
    })();
  }, [loadStoreStatus, pollSyncStatus]);

  const syncStore = useCallback(
    async (apiPlatform: string) => {
      setSyncing((prev) => ({ ...prev, [apiPlatform]: "syncing" }));
      setResults((prev) => ({ ...prev, [apiPlatform]: "" }));
      setLiveJobs((prev) => ({ ...prev, [apiPlatform]: null }));
      setErrorsExpanded((prev) => ({ ...prev, [apiPlatform]: false }));

      try {
        const res = await fetch(`/api/sync/${apiPlatform}`, { method: "POST" });
        const text = await res.text();
        let json: { data?: Record<string, unknown>; error?: string };

        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          setSyncing((prev) => ({ ...prev, [apiPlatform]: "error" }));
          setResults((prev) => ({
            ...prev,
            [apiPlatform]: res.ok
              ? "Invalid response from server"
              : `Sync failed (${res.status}). Check server logs.`,
          }));
          return;
        }

        if (!res.ok) {
          setSyncing((prev) => ({ ...prev, [apiPlatform]: "error" }));
          setResults((prev) => ({
            ...prev,
            [apiPlatform]: json.error ?? "Sync failed",
          }));
          return;
        }

        const data = json.data;
        if (data?.status === "STARTED" || data?.status === "ALREADY_RUNNING") {
          const fallbackReason =
            typeof data.fallbackReason === "string" ? data.fallbackReason : null;
          if (fallbackReason) {
            setResults((prev) => ({ ...prev, [apiPlatform]: fallbackReason }));
          }
          pollSyncStatus(apiPlatform);
          return;
        }

        const message = data
          ? `Done - ${data.itemsProcessed ?? 0} processed, ${data.itemsCreated ?? 0} created, ${data.itemsUpdated ?? 0} updated`
          : "Sync completed";

        setSyncing((prev) => ({ ...prev, [apiPlatform]: "done" }));
        setResults((prev) => ({ ...prev, [apiPlatform]: message }));
        fetchIntegrations();
        fetchSchedulerStatus();
        await loadStoreStatus(apiPlatform);
      } catch (error) {
        setSyncing((prev) => ({ ...prev, [apiPlatform]: "error" }));
        setResults((prev) => ({
          ...prev,
          [apiPlatform]: error instanceof Error ? error.message : "Network error",
        }));
      }
    },
    [fetchIntegrations, fetchSchedulerStatus, loadStoreStatus, pollSyncStatus],
  );

  const syncAll = useCallback(async () => {
    setSyncAllRunning(true);
    const connectedStores = stores.filter((store) => getStatus(store.apiPlatform)?.connected);
    await Promise.allSettled(
      connectedStores.map((store) => syncStore(store.apiPlatform)),
    );
    setSyncAllRunning(false);
  }, [integrations, syncStore]);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Sync</h1>
        <p className="text-sm text-muted-foreground">
          Pull-only sync controls - fetch latest data from connected marketplaces
        </p>
      </div>

      <div className="mb-6 flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3">
        <CheckCircle className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">
          Sync is pull-only. It never pushes changes to marketplaces.
        </p>
      </div>

      <div className="mb-8">
        <button
          type="button"
          disabled={syncAllRunning}
          onClick={syncAll}
          className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {syncAllRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden />
          )}
          {syncAllRunning ? "Syncing All..." : "Sync All"}
        </button>
      </div>

      <div className="mb-8 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <TimerReset className={cn(
                "h-4 w-4",
                schedulerStatus?.runningCount ? "animate-spin text-blue-400" : "text-muted-foreground"
              )} />
              <h2 className="text-sm font-semibold text-foreground">Automatic Background Updates</h2>
              <span className={cn(
                "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium",
                schedulerEnabled
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-400"
              )}>
                {schedulerEnabled ? "Auto updates on" : "Auto updates off"}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Last automatic check: {formatDateTime(schedulerStatus?.lastTickAt ?? null)}
              {schedulerStatus?.lastOutcome ? ` | Result: ${schedulerStatus.lastOutcome}` : ""}
            </p>
          </div>
          <div className="grid min-w-[260px] grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div className="rounded border border-border bg-muted/40 px-3 py-2">
              <div className="text-muted-foreground">Ready At Last Check</div>
              <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">
                {schedulerStatus?.lastDueCount ?? 0}
              </div>
            </div>
            <div className="rounded border border-border bg-muted/40 px-3 py-2">
              <div className="text-muted-foreground">Started At Last Check</div>
              <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">
                {schedulerStatus?.lastDispatchedCount ?? 0}
              </div>
            </div>
            <div className="rounded border border-border bg-muted/40 px-3 py-2">
              <div className="text-muted-foreground">Updating Now</div>
              <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">
                {schedulerStatus?.runningCount ?? 0}
              </div>
            </div>
            <div className="rounded border border-border bg-muted/40 px-3 py-2">
              <div className="text-muted-foreground">Last Result</div>
              <div className="mt-1 text-sm font-semibold text-foreground">
                {schedulerStatus?.lastOutcome ?? "—"}
              </div>
            </div>
          </div>
        </div>
        {schedulerStatus?.lastError && (
          <div className="mt-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            Last automatic update error: {schedulerStatus.lastError}
          </div>
        )}
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          <div className="rounded border border-border bg-muted/20 px-3 py-2">
            <div className="text-muted-foreground">Stores Ready To Update Right Now</div>
            <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">
              {schedulerStatus?.dueNowCount ?? 0}
            </div>
          </div>
          <div className="rounded border border-border bg-muted/20 px-3 py-2">
            <div className="text-muted-foreground">Most Recent Automatic Check Result</div>
            <div className="mt-1 text-sm font-semibold text-foreground">
              {schedulerStatus?.lastOutcome ?? "—"}
            </div>
          </div>
        </div>
        {schedulerStatus &&
          schedulerStatus.dueNowCount > 0 &&
          schedulerStatus.lastDueCount !== schedulerStatus.dueNowCount && (
            <div className="mt-3 rounded border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-300">
              {schedulerStatus.dueNowCount} store
              {schedulerStatus.dueNowCount === 1 ? "" : "s"} became ready after the
              last automatic check. They will start on the next scheduler tick.
            </div>
          )}
        {schedulerStatus?.healthSummary && (
          <div
            className={cn(
              "mt-3 rounded border px-3 py-2 text-xs",
              getHealthClasses(schedulerStatus.healthSummary.status),
            )}
          >
            <div className="font-semibold">
              Store update health: {schedulerStatus.healthSummary.headline}
            </div>
            <div className="mt-1">{schedulerStatus.healthSummary.detail}</div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] uppercase tracking-wide">
              <span>Healthy {schedulerStatus.healthSummary.healthyCount}</span>
              <span>Delayed {schedulerStatus.healthSummary.delayedCount}</span>
              <span>Attention {schedulerStatus.healthSummary.attentionCount}</span>
            </div>
          </div>
        )}
        {!!schedulerStatus?.integrationHealth?.length && (
          <div className="mt-4 rounded border border-border bg-muted/20 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Store Freshness
            </div>
            <div className="mb-3 text-xs text-muted-foreground">
              This shows whether each store is refreshing within its expected window, plus whether Shopify and BigCommerce are still sending change notices.
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {schedulerStatus.integrationHealth.slice(0, 4).map((item) => (
                <div
                  key={item.integrationId}
                  className="rounded border border-border bg-background/40 px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">{item.label}</span>
                    <span
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase",
                        getHealthClasses(item.combinedStatus),
                      )}
                    >
                      {item.combinedStatus}
                    </span>
                  </div>
                  <div className="mt-2 text-foreground/90">{item.syncMessage}</div>
                  <div className="mt-1 text-muted-foreground">
                    Last completed pull: {formatDateTime(item.lastSyncAt)}
                  </div>
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
                    <div
                      className={cn(
                        "mt-2 rounded border px-2 py-1 text-[11px]",
                        item.webhookStatus === "ok"
                          ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-300"
                          : item.webhookStatus === "quiet"
                            ? "border-amber-500/20 bg-amber-500/5 text-amber-300"
                            : "border-border bg-muted/40 text-muted-foreground",
                      )}
                    >
                      {item.webhookMessage}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}
        {!!schedulerStatus?.recentJobs?.length && (
          <div className="mt-4 rounded border border-border bg-muted/20 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Latest Scheduled Update Per Store
            </div>
            <div className="mb-3 text-xs text-muted-foreground">
              This section only shows scheduled safety-check pulls. A store can still update successfully from webhooks even if its last scheduled pull did not finish.
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {schedulerStatus.recentJobs.slice(0, 4).map((job) => (
              <div key={job.id} className="rounded border border-border bg-muted/30 px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">{job.label}</span>
                  <span className={cn(
                    "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase",
                    job.mode === "incremental"
                      ? "border-blue-500/30 bg-blue-500/10 text-blue-400"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-400"
                  )}>
                    {job.mode}
                  </span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  {getReadableJobStatus(job.status)} • {job.itemsProcessed.toLocaleString()} items checked
                </div>
                <div className="mt-1 text-muted-foreground">
                  {job.status === "RUNNING" ? "Started" : "Finished"}: {formatDateTime(job.status === "RUNNING" ? job.startedAt : job.completedAt)}
                </div>
                {job.recoveredAfterScheduledFailure ? (
                  <div className="mt-1 text-emerald-400">
                    Newer store updates succeeded after this scheduled issue.
                  </div>
                ) : null}
              </div>
            ))}
            </div>
          </div>
        )}
        {!!schedulerStatus?.upcoming?.length && (
          <div className="mt-4 rounded border border-border bg-muted/20 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              What Happens Next
            </div>
            <div className="mb-3 text-xs text-muted-foreground">
              This shows which store is updating now and which stores are waiting for their next automatic check.
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {schedulerStatus.upcoming.slice(0, 4).map((item) => (
                <div
                  key={item.integrationId}
                  className="rounded border border-border bg-background/40 px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">{item.label}</span>
                    <span
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase",
                        item.running
                          ? "border-blue-500/30 bg-blue-500/10 text-blue-400"
                          : item.due
                            ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
                      )}
                    >
                      {item.running ? "updating" : item.due ? "ready" : "waiting"}
                    </span>
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    {formatModeLabel(item.effectiveMode)} update • every {item.intervalMinutes} minutes
                  </div>
                  <div className="mt-1 text-foreground/80">
                    {formatDueCountdown(item.minutesUntilDue, item.due, item.running)}
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    {item.nextDueAt ? `Next check: ${formatDateTime(item.nextDueAt)}` : item.reason}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {!!schedulerStatus?.recentWebhooks?.length && (
          <div className="mt-4 rounded border border-border bg-muted/20 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recent Store Change Notices
            </div>
            <div className="mb-3 text-xs text-muted-foreground">
              These are marketplace notices that tell reorG something changed and may need a refresh.
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {schedulerStatus.recentWebhooks.slice(0, 4).map((webhook) => (
                <div
                  key={webhook.id}
                  className="rounded border border-border bg-background/40 px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">
                      {webhook.platform}
                    </span>
                    <span className="text-muted-foreground">
                      {formatDateTime(webhook.receivedAt)}
                    </span>
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    {webhook.topic} | {getReadableWebhookStatus(webhook.status)}
                  </div>
                  <div className="mt-1 text-foreground/80">
                    {webhook.message}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {!!schedulerStatus?.automationEvents?.length && (
          <div className="mt-4 rounded border border-border bg-muted/20 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Why The System Did What It Did
            </div>
            <div className="mb-3 text-xs text-muted-foreground">
              These are the recent automatic decisions reorG made, such as starting a refresh, skipping a duplicate notice, or finishing a targeted update.
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {schedulerStatus.automationEvents.slice(0, 6).map((event) => (
                <div
                  key={event.id}
                  className="rounded border border-border bg-background/40 px-3 py-2 text-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-foreground">
                        {event.title}
                        {event.platform ? (
                          <span className="ml-1 text-muted-foreground">{event.platform}</span>
                        ) : null}
                      </div>
                      <div className="mt-1 text-muted-foreground">{event.detail}</div>
                    </div>
                    <span
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase",
                        getAutomationBadgeClasses(event.status),
                      )}
                    >
                      {event.status.replace("_", " ")}
                    </span>
                  </div>
                  <div className="mt-2 text-muted-foreground">
                    {formatDateTime(event.occurredAt)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {stores.map((store) => {
          const theme = themeClasses[store.theme];
          const logoSrc = LOGO_MAP[store.platform];
          const status = getStatus(store.apiPlatform);
          const connected = status?.connected ?? false;
          const storeSync = syncing[store.apiPlatform] ?? "idle";
          const result = results[store.apiPlatform];
          const liveJob = liveJobs[store.apiPlatform];
          const meta = syncMeta[store.apiPlatform];
          const syncProfile = meta?.syncProfile ?? null;
          const syncState = meta?.syncState ?? null;
          const webhookState = meta?.webhookState ?? null;
          const webhookHealth = meta?.webhookHealth ?? null;
          const isSyncing = storeSync === "syncing";
          const jobErrors = (liveJob?.errors ?? []) as SyncError[];
          const showErrors = errorsExpanded[store.apiPlatform] && jobErrors.length > 0;
          const durationMs = getJobDurationMs(liveJob, nowMs);
          const nextPullAt = syncProfile ? getNextPullAt(syncProfile, new Date(nowMs)) : null;
          const completionSummary = getCompletionSummary(
            liveJob,
            syncState?.lastFallbackReason ?? null,
          );
          const summaryClasses =
            completionSummary.tone === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
              : completionSummary.tone === "warning"
                ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                : completionSummary.tone === "error"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-blue-500/30 bg-blue-500/10 text-blue-400";

          return (
            <article
              key={store.id}
              className={cn(
                "rounded-lg border border-border bg-card p-6 transition-colors duration-200",
                "hover:border-border/80 hover:bg-card/95",
              )}
            >
              <div className="mb-4 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  {logoSrc ? (
                    <img
                      src={logoSrc}
                      alt={store.platform}
                      width={20}
                      height={20}
                      style={{ width: 20, height: 20, minWidth: 20 }}
                      className="shrink-0"
                    />
                  ) : null}
                  <h3 className="truncate text-base font-semibold text-foreground">
                    {store.name}
                  </h3>
                  <span
                    className={cn(
                      "shrink-0 rounded border px-2 py-0.5 text-xs font-medium",
                      theme.badge,
                    )}
                  >
                    {store.acronym}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {connected ? (
                    <>
                      <CheckCircle className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                      <span className="text-xs text-emerald-500">Connected</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="text-xs text-muted-foreground">Not Connected</span>
                    </>
                  )}
                </div>
              </div>

              <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Clock className="h-4 w-4 shrink-0" aria-hidden />
                  <span>Last synced: {formatDateTime(status?.lastSyncAt ?? null)}</span>
                </div>
              </div>

              <div className={cn("mb-4 rounded-md border px-3 py-3", summaryClasses)}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold">{completionSummary.label}</div>
                    <div className="mt-0.5 text-xs opacity-90">{completionSummary.detail}</div>
                  </div>
                  {durationMs !== null ? (
                    <div className="rounded border border-current/20 px-2 py-1 text-[11px] font-semibold tabular-nums">
                      Duration: {formatDurationMs(durationMs)}
                    </div>
                  ) : null}
                </div>
                {liveJob ? (
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                    <div className="rounded border border-current/15 bg-background/30 px-2 py-1.5">
                      <div className="opacity-70">Processed</div>
                      <div className="mt-0.5 text-sm font-semibold tabular-nums">{liveJob.itemsProcessed}</div>
                    </div>
                    <div className="rounded border border-current/15 bg-background/30 px-2 py-1.5">
                      <div className="opacity-70">Created</div>
                      <div className="mt-0.5 text-sm font-semibold tabular-nums">{liveJob.itemsCreated}</div>
                    </div>
                    <div className="rounded border border-current/15 bg-background/30 px-2 py-1.5">
                      <div className="opacity-70">Updated</div>
                      <div className="mt-0.5 text-sm font-semibold tabular-nums">{liveJob.itemsUpdated}</div>
                    </div>
                    <div className="rounded border border-current/15 bg-background/30 px-2 py-1.5">
                      <div className="opacity-70">{jobErrors.length > 0 ? "Issues" : "Errors"}</div>
                      <div className="mt-0.5 text-sm font-semibold tabular-nums">{jobErrors.length}</div>
                    </div>
                  </div>
                ) : null}
              </div>

              {syncProfile ? (
                <div className="mb-4 grid gap-3 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground sm:grid-cols-3">
                  <div>
                    <div className="font-semibold text-foreground/90">Next pull</div>
                    <div className="mt-1 text-sm font-semibold text-foreground tabular-nums">
                      {connected && syncProfile.autoSyncEnabled && schedulerEnabled
                        ? formatCountdown(nextPullAt, nowMs)
                        : connected && syncProfile.autoSyncEnabled
                          ? "Scheduler off"
                          : "Not scheduled"}
                    </div>
                    <div className="mt-1">
                      {connected && syncProfile.autoSyncEnabled && schedulerEnabled && nextPullAt
                        ? `Due around ${nextPullAt.toLocaleString()}`
                        : connected && syncProfile.autoSyncEnabled
                          ? "Pull cadence is configured, but automatic pulls are not enabled yet."
                        : "Auto-pull is not active for this store yet."}
                    </div>
                  </div>
                  <div>
                    <div className="font-semibold text-foreground/90">Pull cadence</div>
                    <div className="mt-1">{formatSchedule(syncProfile)}</div>
                    <div className="mt-1">
                      Preferred mode: {syncProfile.preferredMode}
                      {syncState?.lastEffectiveMode ? ` | Last mode used: ${syncState.lastEffectiveMode}` : ""}
                    </div>
                  </div>
                  <div>
                    <div className="font-semibold text-foreground/90">Change wake-up</div>
                    <div className="mt-1 text-sm font-semibold text-foreground">
                      {usesWebhookWakeup(syncProfile)
                        ? syncState?.lastWebhookAt
                          ? formatDateTime(syncState.lastWebhookAt)
                          : "Waiting for first webhook"
                        : syncState?.lastIncrementalSyncAt
                          ? formatDateTime(syncState.lastIncrementalSyncAt)
                          : "Scheduled pulls only"}
                    </div>
                    <div className="mt-1">
                      {usesWebhookWakeup(syncProfile)
                        ? "Marketplace webhooks can trigger an earlier pull-only refresh between scheduled runs."
                        : "This store relies on its scheduled cadence unless you start a manual pull."}
                    </div>
                    {usesWebhookWakeup(syncProfile) && webhookState ? (
                      <div className="mt-2 rounded border border-border/60 bg-background/40 px-2 py-1.5">
                        <div>
                          Registration: {webhookState.topics.length > 0 ? "Configured" : "Not registered yet"}
                        </div>
                        <div className="break-all">
                          Destination: {webhookState.destination ?? "Not set"}
                        </div>
                        <div>
                          Last ensured: {formatDateTime(webhookState.lastEnsuredAt)}
                        </div>
                        {webhookState.lastEnsureError ? (
                          <div className="text-red-400">
                            Ensure error: {webhookState.lastEnsureError}
                          </div>
                        ) : null}
                        {webhookHealth?.expectedDestination ? (
                          <div
                            className={cn(
                              "mt-2 rounded border px-2 py-1.5",
                              webhookHealth.status === "warning"
                                ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
                            )}
                          >
                            <div>{webhookHealth.message}</div>
                            {webhookHealth.status === "warning" ? (
                              <div className="mt-1 break-all text-[11px]">
                                Expected: {webhookHealth.expectedDestination}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {syncState?.lastFallbackReason && !isSyncing ? (
                <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
                  Last fallback note: {syncState.lastFallbackReason}
                </div>
              ) : null}

              {isSyncing && liveJob && liveJob.status === "RUNNING" ? (
                <div className="mb-4 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
                    <span className="text-xs font-medium text-blue-400">Syncing...</span>
                  </div>
                  <div className="mt-1.5 grid grid-cols-3 gap-2 text-xs tabular-nums">
                    <div>
                      <span className="text-muted-foreground">Processed</span>
                      <div className="text-sm font-bold text-blue-400">{liveJob.itemsProcessed}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Created</span>
                      <div className="text-sm font-bold text-emerald-400">{liveJob.itemsCreated}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Updated</span>
                      <div className="text-sm font-bold text-amber-400">{liveJob.itemsUpdated}</div>
                    </div>
                  </div>
                  {jobErrors.length > 0 ? (
                    <div className="mt-2 flex items-center gap-1 text-xs text-red-400">
                      <AlertTriangle className="h-3 w-3" />
                      <span>{jobErrors.length} issue{jobErrors.length > 1 ? "s" : ""} so far</span>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {isSyncing && !liveJob ? (
                <div className="mb-4 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
                    <span className="text-xs font-medium text-blue-400">Starting sync...</span>
                  </div>
                </div>
              ) : null}

              {result && !isSyncing ? (
                <div
                  className={cn(
                    "mb-4 rounded-md px-3 py-2 text-xs",
                    storeSync === "error"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-emerald-500/10 text-emerald-400",
                  )}
                >
                  {result}
                </div>
              ) : null}

              {!isSyncing && jobErrors.length > 0 ? (
                <div className="mb-4">
                  <button
                    onClick={() =>
                      setErrorsExpanded((prev) => ({
                        ...prev,
                        [store.apiPlatform]: !prev[store.apiPlatform],
                      }))
                    }
                    className="flex w-full cursor-pointer items-center justify-between rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/15"
                  >
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      <span>{jobErrors.length} issue{jobErrors.length > 1 ? "s" : ""}</span>
                    </div>
                    {showErrors ? (
                      <ChevronUp className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                  </button>

                  {showErrors ? (
                    <div className="mt-2 rounded-md border border-border bg-background p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase text-muted-foreground">
                          Error Log
                        </span>
                        <button
                          onClick={() => copyErrors(store.apiPlatform)}
                          className="flex cursor-pointer items-center gap-1 rounded border border-border bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <Copy className="h-3 w-3" />
                          {copied === store.apiPlatform ? "Copied!" : "Copy All Errors"}
                        </button>
                      </div>
                      <div className="max-h-60 overflow-auto space-y-1.5 text-[11px] font-mono">
                        {jobErrors.map((error, index) => (
                          <div
                            key={index}
                            className="rounded border border-border/50 bg-card/50 px-2 py-1.5"
                          >
                            <span className="font-bold text-red-400">{error.sku}</span>
                            <span className="text-muted-foreground"> - </span>
                            <span className="text-foreground/80 break-all">{error.message}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  disabled={!connected || isSyncing}
                  onClick={() => syncStore(store.apiPlatform)}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground",
                    "transition-colors hover:bg-muted hover:text-foreground",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                  aria-label={`Sync ${store.name} now`}
                >
                  {isSyncing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {isSyncing ? "Syncing..." : "Sync Now"}
                </button>
                <span className="text-xs text-muted-foreground">Pull-only</span>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
