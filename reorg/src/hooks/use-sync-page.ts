"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { usePageVisibility } from "@/lib/use-page-visibility";
import type {
  IntegrationStatus,
  SchedulerStatus,
  SyncPageState,
  SyncJobInfo,
  SyncRouteData,
  SyncError,
  StoreEntry,
} from "@/lib/sync-types";
import { STORES } from "@/lib/sync-types";

export type UseSyncPageReturn = {
  integrations: IntegrationStatus[];
  schedulerEnabled: boolean;
  schedulerStatus: SchedulerStatus | null;
  syncing: Record<string, SyncPageState>;
  results: Record<string, string>;
  liveJobs: Record<string, SyncJobInfo | null>;
  syncMeta: Record<string, SyncRouteData | null>;
  errorsExpanded: Record<string, boolean>;
  copied: string | null;
  syncAllRunning: boolean;
  nowMs: number;
  stores: readonly StoreEntry[];
  getStatus: (apiPlatform: string) => IntegrationStatus | undefined;
  syncStore: (apiPlatform: string, mode?: "full" | "incremental") => Promise<void>;
  cancelSync: (apiPlatform: string) => Promise<void>;
  syncAll: (mode?: "full" | "incremental") => Promise<void>;
  copyErrors: (apiPlatform: string) => void;
  toggleErrors: (apiPlatform: string) => void;
  setSyncMeta: React.Dispatch<React.SetStateAction<Record<string, SyncRouteData | null>>>;
};

export function useSyncPage(): UseSyncPageReturn {
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

  const getStatus = useCallback(
    (apiPlatform: string) => integrations.find((i) => i.platform === apiPlatform),
    [integrations],
  );

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
    for (const store of STORES) void loadStoreStatus(store.apiPlatform);
  }, [fetchSchedulerStatus, isPageVisible, loadStoreStatus]);

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
            const issueCount = Array.isArray(job.errors) ? job.errors.filter((e: SyncError) => e.sku !== "_phase").length : 0;
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
      for (const store of STORES) {
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

  const syncAll = useCallback(async (mode?: "full" | "incremental") => {
    setSyncAllRunning(true);
    const connected = STORES.filter((s) => integrations.find((i) => i.platform === s.apiPlatform)?.connected);
    await Promise.allSettled(connected.map((s) => syncStore(s.apiPlatform, mode)));
    setSyncAllRunning(false);
  }, [integrations, syncStore]);

  const copyErrors = useCallback((apiPlatform: string) => {
    const job = liveJobs[apiPlatform];
    if (!job?.errors?.length) return;
    const text = job.errors.map((e) => `Item: ${e.sku}\nError: ${e.message}`).join("\n\n---\n\n");
    const header = `=== ${apiPlatform} Sync Errors (${job.errors.length}) ===\nJob ID: ${job.id}\n\n`;
    navigator.clipboard.writeText(header + text).then(() => {
      setCopied(apiPlatform);
      setTimeout(() => setCopied(null), 2000);
    });
  }, [liveJobs]);

  const toggleErrors = useCallback((apiPlatform: string) => {
    setErrorsExpanded((prev) => ({ ...prev, [apiPlatform]: !prev[apiPlatform] }));
  }, []);

  return {
    integrations,
    schedulerEnabled,
    schedulerStatus,
    syncing,
    results,
    liveJobs,
    syncMeta,
    errorsExpanded,
    copied,
    syncAllRunning,
    nowMs,
    stores: STORES,
    getStatus,
    syncStore,
    cancelSync,
    syncAll,
    copyErrors,
    toggleErrors,
    setSyncMeta,
  };
}
