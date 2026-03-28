"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  RefreshCw,
  XCircle,
  Loader2,
  Copy,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";
import { usePageVisibility } from "@/lib/use-page-visibility";
import {
  formatEbayAutoSyncSchedule,
  getNextEbayAutoSyncAt,
} from "@/lib/services/ebay-sync-policy";

const LOGO_MAP: Record<string, string> = {
  eBay: "/logos/ebay.svg",
  BigCommerce: "/logos/bigcommerce.svg",
  Shopify: "/logos/shopify.svg",
};

const stores = [
  { id: "tpp", name: "The Perfect Part", acronym: "TPP", platform: "eBay", apiPlatform: "TPP_EBAY" },
  { id: "tt", name: "Telitetech", acronym: "TT", platform: "eBay", apiPlatform: "TT_EBAY" },
  { id: "bc", name: "BigCommerce", acronym: "BC", platform: "BigCommerce", apiPlatform: "BIGCOMMERCE" },
  { id: "shpfy", name: "Shopify", acronym: "SHPFY", platform: "Shopify", apiPlatform: "SHOPIFY" },
] as const;

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
  skipUpcHydration: boolean;
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
  lastRateLimitAt: string | null;
  lastRateLimitMessage: string | null;
  pendingIncrementalItemIds: string[];
  pendingIncrementalWindowEndedAt: string | null;
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
  lastWebhookEvent: {
    topic: string | null;
    status: string | null;
    message: string | null;
    receivedAt: string | null;
    relationToLastSync: "none" | "before_last_pull" | "after_last_pull";
  } | null;
  cooldown: {
    active: boolean;
    until: string | null;
    message: string | null;
    retryLabel: string | null;
  };
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
    isDegradedEstimate?: boolean;
    degradedNote?: string;
    isLocallyTracked?: boolean;
  } | null;
  quotaPolicy: {
    reservedGetItemCalls: number | null;
  } | null;
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
    recommendedAction: string;
    affectedLabels: string[];
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
    recentWebhookCount24h: number;
    lastWebhookTopic: string | null;
    lastWebhookMessage: string | null;
    lastWebhookEventStatus: string | null;
    minutesSinceWebhook: number | null;
    webhookStatus: "ok" | "quiet" | "missing" | "n/a";
    webhookMessage: string;
    webhookProofStatus: "none" | "before_last_pull" | "after_last_pull";
    webhookProofMessage: string;
    recommendedAction: string;
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

/* ------------------------------------------------------------------ */
/*  Utility helpers                                                    */
/* ------------------------------------------------------------------ */

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

function formatRelativeTime(value: string | null, nowMs: number) {
  if (!value) return "Never";
  const diffMs = nowMs - new Date(value).getTime();
  if (diffMs < 0) return "Just now";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return rem > 0 ? `${hours}h ${rem}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getJobDurationMs(job: SyncJobInfo | null, now: number) {
  if (!job?.startedAt) return null;
  const startedAt = new Date(job.startedAt).getTime();
  const finishedAt = job.completedAt ? new Date(job.completedAt).getTime() : now;
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return null;
  return Math.max(0, finishedAt - startedAt);
}

function getRelevantFallbackReason(
  profile: SyncProfile,
  syncState: IntegrationSyncState | null | undefined,
) {
  if (!syncState?.lastFallbackReason) return null;
  if (profile.preferredMode === "full" && syncState.lastEffectiveMode === "full") return null;
  return syncState.lastFallbackReason;
}

function getCompletionSummary(
  job: SyncJobInfo | null,
  fallbackReason: string | null,
): { label: string; tone: CompletionTone; detail: string } {
  if (!job) return { label: "No sync yet", tone: "info", detail: "Run a sync to pull data from this store." };
  const issueCount = Array.isArray(job.errors) ? job.errors.length : 0;
  if (job.status === "RUNNING") return { label: "Syncing", tone: "info", detail: "Pull is in progress." };
  if (job.status === "FAILED") {
    return {
      label: "Failed",
      tone: "error",
      detail: issueCount > 0
        ? `${issueCount} issue${issueCount === 1 ? "" : "s"} blocked completion.`
        : "Last pull did not complete.",
    };
  }
  if (issueCount > 0) {
    return {
      label: "Completed with issues",
      tone: "warning",
      detail: `Done, but ${issueCount} row${issueCount === 1 ? "" : "s"} had issues.`,
    };
  }
  return {
    label: "Complete",
    tone: "success",
    detail: fallbackReason ? "Completed with safe fallback." : "All items synced successfully.",
  };
}

/* ------------------------------------------------------------------ */
/*  Schedule / countdown helpers                                       */
/* ------------------------------------------------------------------ */

function getLocalDateTimeParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const v = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: v("year"), month: v("month"), day: v("day"), hour: v("hour"), minute: v("minute"), second: v("second") };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const p = getLocalDateTimeParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

function zonedDateTimeToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number, s = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  return new Date(guess - getTimeZoneOffsetMs(new Date(guess), tz));
}

function addDaysToParts(parts: ReturnType<typeof getLocalDateTimeParts>, days: number, tz: string) {
  const b = zonedDateTimeToUtc(tz, parts.year, parts.month, parts.day, 12, 0, 0);
  b.setUTCDate(b.getUTCDate() + days);
  return getLocalDateTimeParts(b, tz);
}

function getNextPullAt(profile: SyncProfile, now: Date, platform: string) {
  if (!profile.autoSyncEnabled) return null;
  if (platform === "TPP_EBAY" || platform === "TT_EBAY") return getNextEbayAutoSyncAt(now, profile.timezone);

  const nowParts = getLocalDateTimeParts(now, profile.timezone);
  const candidates: Date[] = [];

  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const dayParts = addDaysToParts(nowParts, dayOffset, profile.timezone);

    for (let m = profile.dayStartHour * 60; m < profile.dayEndHour * 60; m += profile.dayIntervalMinutes) {
      candidates.push(zonedDateTimeToUtc(profile.timezone, dayParts.year, dayParts.month, dayParts.day, Math.floor(m / 60), m % 60));
    }

    const overnightEnd = profile.dayStartHour * 60 + 24 * 60;
    for (let m = profile.dayEndHour * 60; m < overnightEnd; m += profile.overnightIntervalMinutes) {
      const tp = m >= 24 * 60 ? addDaysToParts(dayParts, 1, profile.timezone) : dayParts;
      const nm = m % (24 * 60);
      candidates.push(zonedDateTimeToUtc(profile.timezone, tp.year, tp.month, tp.day, Math.floor(nm / 60), nm % 60));
    }
  }

  const nowTime = now.getTime();
  return candidates.filter((c) => c.getTime() > nowTime).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

function formatCountdown(target: Date | null, now: number) {
  if (!target) return "—";
  const remaining = target.getTime() - now;
  if (remaining <= 0) return "Due now";
  const totalSeconds = Math.floor(remaining / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function formatSchedule(profile: SyncProfile, platform: string) {
  if (platform === "TPP_EBAY" || platform === "TT_EBAY") return formatEbayAutoSyncSchedule();
  const overnightWindowMinutes = (24 - profile.dayEndHour + profile.dayStartHour) * 60;
  const overnightLabel =
    profile.overnightIntervalMinutes >= overnightWindowMinutes ? "Once overnight"
      : profile.overnightIntervalMinutes >= 60 && profile.overnightIntervalMinutes % 60 === 0
        ? `Every ${profile.overnightIntervalMinutes / 60}h overnight`
        : `Every ${profile.overnightIntervalMinutes}m overnight`;
  const daytimeLabel =
    profile.dayIntervalMinutes >= 60 && profile.dayIntervalMinutes % 60 === 0
      ? `Every ${profile.dayIntervalMinutes / 60}h`
      : `Every ${profile.dayIntervalMinutes}m`;
  return `${daytimeLabel} (${profile.dayStartHour}:00–${profile.dayEndHour}:00), ${overnightLabel}`;
}

/* ------------------------------------------------------------------ */
/*  Tooltip helper                                                     */
/* ------------------------------------------------------------------ */

function Tip({
  children,
  text,
  side = "top",
}: {
  children: React.ReactNode;
  text: string;
  /** `bottom` avoids clipping when the trigger sits just under the app header (main has overflow-auto). */
  side?: "top" | "bottom";
}) {
  if (side === "bottom") {
    return (
      <div className="group/tip relative inline-flex">
        {children}
        <div className="pointer-events-none absolute left-1/2 top-full z-[100] mt-2 w-60 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground opacity-0 shadow-lg transition-opacity duration-200 group-hover/tip:opacity-100">
          <div
            className="absolute bottom-full left-1/2 -translate-x-1/2 border-[6px] border-transparent border-b-border"
            aria-hidden
          />
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="group/tip relative inline-flex">
      {children}
      <div className="pointer-events-none absolute bottom-full left-1/2 z-[100] mb-2.5 w-60 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground opacity-0 shadow-lg transition-opacity duration-200 group-hover/tip:opacity-100">
        {text}
        <div
          className="absolute left-1/2 top-full -translate-x-1/2 border-[5px] border-transparent border-t-border"
          aria-hidden
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export default function SyncPage() {
  const isPageVisible = usePageVisibility();
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [schedulerEnabled, setSchedulerEnabled] = useState(false);
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [syncing, setSyncing] = useState<Record<string, SyncPageState>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const [liveJobs, setLiveJobs] = useState<Record<string, SyncJobInfo | null>>({});
  const [syncMeta, setSyncMeta] = useState<Record<string, SyncRouteData | null>>({});
  const [errorsExpanded, setErrorsExpanded] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [syncAllRunning, setSyncAllRunning] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const preSyncJobIds = useRef<Record<string, string | null>>({});
  const initialCheckDone = useRef(false);

  /* ---- data fetchers ---- */

  const fetchIntegrations = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations");
      const json = await res.json();
      if (json.data) setIntegrations(json.data);
    } catch { /* ignore */ }
  }, []);

  const fetchSchedulerSetting = useCallback(async () => {
    try {
      const res = await fetch("/api/settings?key=scheduler_enabled");
      const json = await res.json();
      setSchedulerEnabled(Boolean(json.data));
    } catch { setSchedulerEnabled(false); }
  }, []);

  const fetchSchedulerStatus = useCallback(async (forceRefresh = false) => {
    try {
      const res = await fetch(
        forceRefresh ? "/api/scheduler/status?refresh=1" : "/api/scheduler/status",
        { cache: "no-store" },
      );
      const json = await res.json();
      setSchedulerStatus((json.data ?? null) as SchedulerStatus | null);
    } catch { setSchedulerStatus(null); }
  }, []);

  useEffect(() => {
    fetchIntegrations();
    fetchSchedulerSetting();
    fetchSchedulerStatus();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetchSchedulerStatus();
    }, 20_000);
    return () => {
      Object.values(pollTimers.current).forEach(clearInterval);
      clearInterval(timer);
    };
  }, [fetchIntegrations, fetchSchedulerSetting, fetchSchedulerStatus]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const getStatus = (apiPlatform: string) =>
    integrations.find((i) => i.platform === apiPlatform);

  /* ---- store status loader ---- */

  const loadStoreStatus = useCallback(async (apiPlatform: string) => {
    const res = await fetch(`/api/sync/${apiPlatform}?ts=${Date.now()}`, { cache: "no-store" });
    const json = await res.json();
    const data = (json.data ?? null) as SyncRouteData | null;
    if (!data) return null;

    setSyncMeta((prev) => ({ ...prev, [apiPlatform]: data }));
    setLiveJobs((prev) => ({ ...prev, [apiPlatform]: data.lastJob }));

    const job = data.lastJob;
    const waitingForNew = apiPlatform in preSyncJobIds.current;

    if (job?.status === "RUNNING") {
      if (waitingForNew) delete preSyncJobIds.current[apiPlatform];
      setSyncing((prev) => ({ ...prev, [apiPlatform]: "syncing" }));
    } else if (job && (job.status === "COMPLETED" || job.status === "FAILED")) {
      if (waitingForNew && job.id === preSyncJobIds.current[apiPlatform]) {
        return data;
      }
      if (waitingForNew) delete preSyncJobIds.current[apiPlatform];
      const issueCount = Array.isArray(job.errors) ? job.errors.length : 0;
      const message =
        job.status === "COMPLETED"
          ? `Done — ${job.itemsProcessed} processed, ${job.itemsCreated} created, ${job.itemsUpdated} updated${issueCount > 0 ? `, ${issueCount} issues` : ""}`
          : "Last sync failed — see details below";
      setSyncing((prev) => ({ ...prev, [apiPlatform]: job.status === "COMPLETED" ? "done" : "error" }));
      setResults((prev) => ({ ...prev, [apiPlatform]: message }));
      if (issueCount > 0) setErrorsExpanded((prev) => ({ ...prev, [apiPlatform]: true }));
    }

    return data;
  }, []);

  useEffect(() => {
    if (!isPageVisible) return;
    void fetchSchedulerStatus();
    for (const store of stores) void loadStoreStatus(store.apiPlatform);
  }, [fetchSchedulerStatus, isPageVisible, loadStoreStatus]);

  /* ---- sync polling ---- */

  const pollSyncStatus = useCallback(
    (apiPlatform: string) => {
      if (pollTimers.current[apiPlatform]) clearInterval(pollTimers.current[apiPlatform]);

      const timer = setInterval(async () => {
        if (!isPageVisible) return;
        try {
          const data = await loadStoreStatus(apiPlatform);
          const job = data?.lastJob ?? null;
          if (
            job &&
            (job.status === "COMPLETED" || job.status === "FAILED") &&
            !(apiPlatform in preSyncJobIds.current && job.id === preSyncJobIds.current[apiPlatform])
          ) {
            clearInterval(pollTimers.current[apiPlatform]);
            delete pollTimers.current[apiPlatform];
            delete preSyncJobIds.current[apiPlatform];
            const issueCount = Array.isArray(job.errors) ? job.errors.length : 0;
            const message =
              job.status === "COMPLETED"
                ? `Done — ${job.itemsProcessed} processed, ${job.itemsCreated} created, ${job.itemsUpdated} updated${issueCount > 0 ? `, ${issueCount} issues` : ""}`
                : "Failed — see details below";
            setSyncing((prev) => ({ ...prev, [apiPlatform]: job.status === "COMPLETED" ? "done" : "error" }));
            setResults((prev) => ({ ...prev, [apiPlatform]: message }));
            if (issueCount > 0) setErrorsExpanded((prev) => ({ ...prev, [apiPlatform]: true }));
            fetchIntegrations();
            fetchSchedulerStatus(true);
          } else if (job && job.status === "RUNNING" && job.itemsProcessed > 0) {
            const issueCount = Array.isArray(job.errors) ? job.errors.filter((e: Record<string, unknown>) => e.sku !== "_phase").length : 0;
            const liveMsg = `${job.itemsProcessed} processed, ${job.itemsCreated} created, ${job.itemsUpdated} updated${issueCount > 0 ? `, ${issueCount} issues so far` : ""}`;
            setResults((prev) => ({ ...prev, [apiPlatform]: liveMsg }));
          }
        } catch { /* ignore */ }
      }, 2000);

      pollTimers.current[apiPlatform] = timer;
    },
    [fetchIntegrations, fetchSchedulerStatus, isPageVisible, loadStoreStatus],
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
                : "Last sync failed — see details below";
            setSyncing((prev) => ({ ...prev, [store.apiPlatform]: job.status === "COMPLETED" ? "done" : "error" }));
            setResults((prev) => ({ ...prev, [store.apiPlatform]: message }));
            if (issueCount > 0 && job.status === "FAILED") {
              setErrorsExpanded((prev) => ({ ...prev, [store.apiPlatform]: true }));
            }
          }
        } catch { /* ignore */ }
      }
    })();
  }, [loadStoreStatus, pollSyncStatus]);

  /* ---- sync actions ---- */

  const syncStore = useCallback(
    async (apiPlatform: string, mode?: "full" | "incremental") => {
      const currentJob = liveJobs[apiPlatform];
      preSyncJobIds.current[apiPlatform] = currentJob?.id ?? null;

      setSyncing((prev) => ({ ...prev, [apiPlatform]: "syncing" }));
      setResults((prev) => ({ ...prev, [apiPlatform]: "" }));
      setLiveJobs((prev) => ({ ...prev, [apiPlatform]: null }));
      setErrorsExpanded((prev) => ({ ...prev, [apiPlatform]: false }));

      try {
        const useExecuteRoute = mode === "full";
        const syncUrl = useExecuteRoute
          ? `/api/sync/${apiPlatform}/execute`
          : `/api/sync/${apiPlatform}`;
        const res = await fetch(syncUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: mode ? JSON.stringify({ mode }) : undefined,
        });
        const text = await res.text();
        let json: { data?: Record<string, unknown>; error?: string };
        try { json = text ? JSON.parse(text) : {}; } catch {
          delete preSyncJobIds.current[apiPlatform];
          setSyncing((prev) => ({ ...prev, [apiPlatform]: "error" }));
          setResults((prev) => ({ ...prev, [apiPlatform]: res.ok ? "Invalid response" : `Sync failed (${res.status})` }));
          return;
        }

        if (!res.ok) {
          delete preSyncJobIds.current[apiPlatform];
          setSyncing((prev) => ({ ...prev, [apiPlatform]: "error" }));
          setResults((prev) => ({ ...prev, [apiPlatform]: json.error ?? "Sync failed" }));
          await loadStoreStatus(apiPlatform);
          fetchSchedulerStatus(true);
          return;
        }

        const data = json.data;
        if (data?.status === "STARTED" || data?.status === "ALREADY_RUNNING") {
          const fb = typeof data.fallbackReason === "string" ? data.fallbackReason : null;
          if (fb) setResults((prev) => ({ ...prev, [apiPlatform]: fb }));
          pollSyncStatus(apiPlatform);
          setTimeout(() => { delete preSyncJobIds.current[apiPlatform]; }, 60_000);
          return;
        }

        if (useExecuteRoute && (data?.status === "COMPLETED" || data?.status === "FAILED")) {
          delete preSyncJobIds.current[apiPlatform];
          await loadStoreStatus(apiPlatform);
          fetchIntegrations();
          fetchSchedulerStatus(true);
          return;
        }

        const modeLabel = mode === "full" ? "Full sync" : "Sync";
        const message = data
          ? `${modeLabel} done — ${data.itemsProcessed ?? 0} processed, ${data.itemsCreated ?? 0} created, ${data.itemsUpdated ?? 0} updated`
          : "Sync completed";
        setSyncing((prev) => ({ ...prev, [apiPlatform]: "done" }));
        setResults((prev) => ({ ...prev, [apiPlatform]: message }));
        fetchIntegrations();
        fetchSchedulerStatus(true);
        await loadStoreStatus(apiPlatform);
      } catch (error) {
        delete preSyncJobIds.current[apiPlatform];
        setSyncing((prev) => ({ ...prev, [apiPlatform]: "error" }));
        setResults((prev) => ({ ...prev, [apiPlatform]: error instanceof Error ? error.message : "Network error" }));
      }
    },
    [fetchIntegrations, fetchSchedulerStatus, liveJobs, loadStoreStatus, pollSyncStatus],
  );

  const cancelSync = useCallback(
    async (apiPlatform: string) => {
      try {
        const res = await fetch(`/api/sync/${apiPlatform}`, { method: "DELETE" });
        const json = (await res.json().catch(() => ({}))) as { data?: { message?: string }; error?: string };
        if (!res.ok) {
          setSyncing((prev) => ({ ...prev, [apiPlatform]: "error" }));
          setResults((prev) => ({ ...prev, [apiPlatform]: json.error ?? "Failed to cancel" }));
          return;
        }
        if (pollTimers.current[apiPlatform]) { clearInterval(pollTimers.current[apiPlatform]); delete pollTimers.current[apiPlatform]; }
        setSyncing((prev) => ({ ...prev, [apiPlatform]: "done" }));
        setResults((prev) => ({ ...prev, [apiPlatform]: json.data?.message ?? "Sync cancelled" }));
        await loadStoreStatus(apiPlatform);
        fetchSchedulerStatus(true);
      } catch (error) {
        setSyncing((prev) => ({ ...prev, [apiPlatform]: "error" }));
        setResults((prev) => ({ ...prev, [apiPlatform]: error instanceof Error ? error.message : "Failed to cancel" }));
      }
    },
    [fetchSchedulerStatus, loadStoreStatus],
  );

  const syncAll = useCallback(async () => {
    setSyncAllRunning(true);
    const connected = stores.filter((s) => getStatus(s.apiPlatform)?.connected);
    await Promise.allSettled(connected.map((s) => syncStore(s.apiPlatform)));
    setSyncAllRunning(false);
  }, [integrations, syncStore]);

  function copyErrors(apiPlatform: string) {
    const job = liveJobs[apiPlatform];
    if (!job?.errors?.length) return;
    const text = job.errors.map((e) => `Item: ${e.sku}\nError: ${e.message}`).join("\n\n---\n\n");
    const header = `=== ${apiPlatform} Sync Errors (${job.errors.length}) ===\nJob ID: ${job.id}\n\n`;
    navigator.clipboard.writeText(header + text).then(() => {
      setCopied(apiPlatform);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  /* ---- derived values ---- */

  const healthSummary = schedulerStatus?.healthSummary;
  const showHealthAlert = healthSummary && healthSummary.status !== "healthy";

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  return (
    <div className="min-h-screen p-6" data-tour="sync-header">
      {/* ---- header ---- */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Sync</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pull-only — fetches the latest data from your connected marketplaces
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium",
              schedulerEnabled
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                : "border-muted-foreground/30 bg-muted/50 text-muted-foreground",
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", schedulerEnabled ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground")} />
            Auto-sync {schedulerEnabled ? "on" : "off"}
          </div>
          <Tip
            side="bottom"
            text="Triggers a quick sync on every connected store at once. Uses each store's preferred mode (incremental or full)."
          >
            <button
              type="button"
              disabled={syncAllRunning}
              onClick={syncAll}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {syncAllRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {syncAllRunning ? "Syncing All..." : "Sync All"}
            </button>
          </Tip>
        </div>
      </div>

      {/* ---- health alert (only when there are issues) ---- */}
      {showHealthAlert && (
        <div
          className={cn(
            "mb-6 rounded-lg border px-4 py-3 text-sm",
            healthSummary.status === "attention"
              ? "border-red-500/30 bg-red-500/10 text-red-300"
              : "border-amber-500/30 bg-amber-500/10 text-amber-300",
          )}
        >
          <strong>{healthSummary.headline}:</strong> {healthSummary.detail}
          <span className="ml-3 opacity-80">→ {healthSummary.recommendedAction}</span>
        </div>
      )}

      {/* ---- store cards ---- */}
      <div className="grid gap-5 md:grid-cols-2" data-tour="sync-stores">
        {stores.map((store) => {
          const status = getStatus(store.apiPlatform);
          const connected = status?.connected ?? false;
          const storeSync = syncing[store.apiPlatform] ?? "idle";
          const result = results[store.apiPlatform];
          const liveJob = liveJobs[store.apiPlatform];
          const meta = syncMeta[store.apiPlatform];
          const syncProfile = meta?.syncProfile ?? null;
          const syncState = meta?.syncState ?? null;
          const cooldown = meta?.cooldown ?? null;
          const isSyncing = storeSync === "syncing";
          const jobErrors = (liveJob?.errors ?? []) as SyncError[];
          const showErrors = errorsExpanded[store.apiPlatform] && jobErrors.length > 0;
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
              key={store.id}
              className={cn(
                "relative rounded-xl border bg-card transition-all duration-300",
                isSyncing
                  ? "border-violet-500/40 shadow-[0_0_20px_rgba(139,92,246,0.06)]"
                  : "border-border hover:border-violet-500/20",
              )}
            >
              {/* purple accent line when syncing */}
              {isSyncing && (
                <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-violet-600 via-purple-500 to-violet-600 animate-pulse" />
              )}

              <div className="p-5">
                {/* ---- card header ---- */}
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

                {/* ---- stats: next pull + last sync ---- */}
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-violet-500/15 bg-violet-500/[0.03] p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Next Pull</div>
                    <div className="mt-1.5 text-xl font-bold tabular-nums text-violet-400">
                      {connected && syncProfile?.autoSyncEnabled && schedulerEnabled
                        ? formatCountdown(nextPullAt, nowMs)
                        : cooldownActive ? "Cooldown" : "—"}
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
                        ? `${liveJob.itemsProcessed.toLocaleString()} items${durationMs ? ` · ${formatDurationMs(durationMs)}` : ""}`
                        : "—"}
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

                {/* ---- attention / delayed detail ---- */}
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
                          <p className="leading-snug opacity-70">→ {healthItem.recommendedAction}</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* ---- eBay API Quota ---- */}
                {isEbay && (
                  <div className="mt-4 rounded-lg border border-border/60 bg-muted/10 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        eBay API Quota
                      </span>
                      {rateLimits?.nextResetAt && (
                        <span className="text-[10px] text-muted-foreground">
                          Resets {formatRelativeTime(rateLimits.nextResetAt, nowMs).replace(" ago", "")}
                        </span>
                      )}
                    </div>
                    {rateLimits?.degradedNote && (
                      <p className="mt-1.5 text-[10px] leading-snug text-amber-400/90">{rateLimits.degradedNote}</p>
                    )}
                    {rateLimits && rateLimits.methods.length > 0 ? (
                      <div className="mt-2 space-y-2">
                        {rateLimits.methods.map((method) => {
                          const isUnknown = method.limit === 0;
                          const remainingCount = method.limit > 0 ? method.remaining : 0;
                          const usedPct = isUnknown
                            ? 0
                            : method.status === "exhausted"
                              ? 100
                              : method.limit > 0
                                ? Math.max(
                                    method.count > 0 ? 2 : 0,
                                    Math.round((method.count / method.limit) * 100),
                                  )
                                : 0;
                          const barColor =
                            method.status === "exhausted" ? "bg-red-500"
                              : method.status === "tight" ? "bg-amber-500"
                              : isUnknown ? "bg-muted/30"
                              : usedPct === 0 ? "bg-emerald-500/30"
                              : "bg-emerald-500";
                          const textColor =
                            method.status === "exhausted" ? "text-red-400"
                              : method.status === "tight" ? "text-amber-400"
                              : isUnknown ? "text-muted-foreground/60"
                              : "text-emerald-400";
                          const countLabel = isUnknown
                            ? "—"
                            : `${remainingCount.toLocaleString()} / ${method.limit.toLocaleString()}`;
                          return (
                            <div key={method.name}>
                              <div className="flex items-center justify-between text-[11px]">
                                <span className="text-muted-foreground">{method.name}</span>
                                <span className={cn("font-semibold tabular-nums", textColor)}>
                                  {countLabel}
                                </span>
                              </div>
                              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted/40">
                                <div
                                  className={cn("h-full rounded-full transition-all", barColor)}
                                  style={{ width: `${usedPct}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        {isSyncing ? "Loading..." : "Quota data will appear after next sync or page refresh."}
                      </p>
                    )}
                  </div>
                )}

                {/* ---- eBay quota optimization toggle ---- */}
                {isEbay && syncProfile && (
                  <div className="mt-3 flex items-center justify-between rounded-lg border border-border/40 bg-muted/5 px-3 py-2">
                    <div className="min-w-0 pr-3">
                      <span className="text-[11px] font-medium text-foreground">
                        Skip UPC pull during sync
                      </span>
                      <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                        {syncProfile.skipUpcHydration
                          ? "Full Sync uses only GetSellerList (no GetItem burn). Import UPCs and push with ReviseFixedPriceItem instead."
                          : "Full Sync will call GetItem for variation listings to pull UPCs and variant photos."}
                      </p>
                    </div>
                    <button
                      type="button"
                      className={cn(
                        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors cursor-pointer",
                        syncProfile.skipUpcHydration
                          ? "border-emerald-500/40 bg-emerald-500"
                          : "border-border bg-muted/60",
                      )}
                      onClick={async () => {
                        const next = !syncProfile.skipUpcHydration;
                        setSyncMeta((prev) => ({
                          ...prev,
                          [store.apiPlatform]: prev[store.apiPlatform]
                            ? {
                                ...prev[store.apiPlatform]!,
                                syncProfile: { ...syncProfile, skipUpcHydration: next },
                              }
                            : prev[store.apiPlatform],
                        }));
                        await fetch(`/api/integrations/${store.apiPlatform}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ config: { syncProfile: { skipUpcHydration: next } } }),
                        });
                      }}
                    >
                      <span
                        className={cn(
                          "inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform",
                          syncProfile.skipUpcHydration ? "translate-x-[18px]" : "translate-x-[2px]",
                        )}
                      />
                    </button>
                  </div>
                )}

                {/* ---- live progress (during sync) ---- */}
                {isSyncing && liveJob?.status === "RUNNING" && (() => {
                  const isChunkedPlatform = store.platform === "BigCommerce" || store.platform === "Shopify";
                  const itemsPerMin =
                    liveJob.itemsProcessed > 0 && durationMs && durationMs > 5000
                      ? Math.round((liveJob.itemsProcessed / (durationMs / 1000)) * 60)
                      : null;
                  return (
                    <div className="mt-4 rounded-lg border border-violet-500/30 bg-violet-500/[0.04] p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
                          <span className="text-sm font-semibold text-violet-400">
                            {liveJob.itemsProcessed === 0 ? "Starting…" : "Syncing…"}
                          </span>
                          {isChunkedPlatform && liveJob.itemsProcessed > 0 && (
                            <span className="rounded border border-violet-500/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-400/70">
                              Multi-chunk
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {itemsPerMin !== null && (
                            <span className="text-[11px] tabular-nums text-violet-400/60">
                              {itemsPerMin.toLocaleString()}/min
                            </span>
                          )}
                          {durationMs !== null && (
                            <span className="text-xs tabular-nums text-muted-foreground">{formatDurationMs(durationMs)}</span>
                          )}
                        </div>
                      </div>
                      {liveJob.itemsProcessed === 0 && (() => {
                        const phaseEntry = liveJob.errors?.find((e) => e.sku === "_phase");
                        return (
                          <p className="mt-1 text-[11px] text-violet-400/70">
                            {phaseEntry ? phaseEntry.message : "Connected — waiting for first batch to report progress."}
                          </p>
                        );
                      })()}
                      <div className="mt-3 h-1 overflow-hidden rounded-full bg-violet-500/20">
                        <div className="h-full w-full animate-[pulse_1.5s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-violet-600 via-purple-500 to-violet-600" />
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                        <div>
                          <div className="text-lg font-bold tabular-nums text-violet-400">{liveJob.itemsProcessed.toLocaleString()}</div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Processed</div>
                        </div>
                        <div>
                          <div className="text-lg font-bold tabular-nums text-emerald-400">{liveJob.itemsCreated.toLocaleString()}</div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Created</div>
                        </div>
                        <div>
                          <div className="text-lg font-bold tabular-nums text-amber-400">{liveJob.itemsUpdated.toLocaleString()}</div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Updated</div>
                        </div>
                      </div>
                      {jobErrors.length > 0 && (
                        <div className="mt-3 flex items-center gap-1 text-xs text-red-400">
                          <AlertTriangle className="h-3 w-3" />
                          {jobErrors.length} issue{jobErrors.length > 1 ? "s" : ""} so far
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* starting spinner (no job record yet) */}
                {isSyncing && !liveJob && (
                  <div className="mt-4 flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/[0.04] px-4 py-3">
                    <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
                    <span className="text-sm font-medium text-violet-400">Starting sync...</span>
                  </div>
                )}

                {/* result message (live during sync + after sync completes) */}
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

                {/* cooldown alert */}
                {cooldownActive && (
                  <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                    <span className="font-semibold">eBay daily quota reached</span>
                    {cooldown?.retryLabel ? ` — resets around ${cooldown.retryLabel}` : " — waiting for quota reset"}
                  </div>
                )}

                {/* pending backlog */}
                {pendingBacklogCount > 0 && (
                  <div className="mt-4 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-300">
                    {pendingBacklogCount.toLocaleString()} changed listing{pendingBacklogCount === 1 ? "" : "s"} queued for next pull
                  </div>
                )}

                {/* fallback reason */}
                {relevantFallbackReason && !isSyncing && (
                  <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
                    {relevantFallbackReason}
                  </div>
                )}

                {/* errors (collapsible) */}
                {(() => {
                  if (isSyncing || jobErrors.length === 0) return null;
                  const nonPhaseErrors = jobErrors.filter((e) => e.sku !== "_phase");
                  if (nonPhaseErrors.length === 0) return null;
                  const isOnlyStaleError =
                    nonPhaseErrors.length === 1 &&
                    nonPhaseErrors[0].message.includes("stale running threshold");
                  const realErrors = nonPhaseErrors.filter(
                    (e) => !e.message.includes("stale running threshold"),
                  );
                  if (isOnlyStaleError) {
                    return (
                      <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                        Last pull timed out — the next scheduled sync will retry automatically.
                      </div>
                    );
                  }
                  return (
                    <div className="mt-4">
                      <button
                        type="button"
                        onClick={() => setErrorsExpanded((prev) => ({ ...prev, [store.apiPlatform]: !prev[store.apiPlatform] }))}
                        className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/15"
                      >
                        <div className="flex items-center gap-1.5">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {realErrors.length} issue{realErrors.length > 1 ? "s" : ""}
                        </div>
                        {showErrors ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      </button>
                      {showErrors && (
                        <div className="mt-2 rounded-lg border border-border bg-background p-3">
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-[10px] font-bold uppercase text-muted-foreground">Error Log</span>
                            <button
                              type="button"
                              onClick={() => copyErrors(store.apiPlatform)}
                              className="flex cursor-pointer items-center gap-1 rounded border border-border bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                            >
                              <Copy className="h-3 w-3" />
                              {copied === store.apiPlatform ? "Copied!" : "Copy All"}
                            </button>
                          </div>
                          <div className="max-h-48 space-y-1 overflow-auto font-mono text-[11px]">
                            {realErrors.map((error, i) => (
                              <div key={i} className="rounded border border-border/50 bg-card/50 px-2 py-1.5">
                                <span className="font-bold text-red-400">{error.sku}</span>
                                <span className="text-muted-foreground"> — </span>
                                <span className="break-all text-foreground/80">{error.message}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* ---- action buttons with tooltips ---- */}
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <Tip text={
                    cooldownActive
                      ? "Incremental sync is still available — it uses GetSellerEvents and GetSellerList, which have their own separate quota (not GetItem). Safe to run."
                      : "Quick sync — pulls only the most recent changes since the last update. Fast and efficient for routine refreshes."
                  }>
                    <button
                      type="button"
                      disabled={!connected || isSyncing}
                      onClick={() => syncStore(store.apiPlatform)}
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
                      ? `Full Sync is blocked — it relies heavily on GetItem which is at its daily limit. Resume after the quota resets${cooldown?.retryLabel ? ` around ${cooldown.retryLabel}` : ""}.`
                      : "Full catalog sync — re-downloads every listing from the marketplace from scratch. Use when data looks out of date or after major changes."
                  }>
                    <button
                      type="button"
                      disabled={!connected || isSyncing || cooldownActive}
                      onClick={() => syncStore(store.apiPlatform, "full")}
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

                  <Tip text="Stops the current sync. All progress made so far is saved — nothing is lost or rolled back.">
                    <button
                      type="button"
                      disabled={!connected || !isSyncing}
                      onClick={() => cancelSync(store.apiPlatform)}
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
        })}
      </div>

      <PageTour page="sync" steps={PAGE_TOUR_STEPS.sync} ready />
    </div>
  );
}
