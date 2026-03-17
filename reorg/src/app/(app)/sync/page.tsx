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

type SyncState = "idle" | "syncing" | "done" | "error";

type SyncError = { sku: string; message: string };

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

export default function SyncPage() {
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [syncing, setSyncing] = useState<Record<string, SyncState>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const [liveJobs, setLiveJobs] = useState<Record<string, SyncJobInfo | null>>({});
  const [errorsExpanded, setErrorsExpanded] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [syncAllRunning, setSyncAllRunning] = useState(false);
  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const fetchIntegrations = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations");
      const json = await res.json();
      if (json.data) setIntegrations(json.data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchIntegrations();
    return () => {
      Object.values(pollTimers.current).forEach(clearInterval);
    };
  }, [fetchIntegrations]);

  const getStatus = (apiPlatform: string) =>
    integrations.find((i) => i.platform === apiPlatform);

  function copyErrors(apiPlatform: string) {
    const job = liveJobs[apiPlatform];
    if (!job?.errors?.length) return;
    const text = job.errors
      .map((e) => `Item: ${e.sku}\nError: ${e.message}`)
      .join("\n\n---\n\n");
    const header = `=== ${apiPlatform} Sync Errors (${job.errors.length}) ===\nJob ID: ${job.id}\nCompleted: ${job.completedAt ?? "N/A"}\n\n`;
    navigator.clipboard.writeText(header + text).then(() => {
      setCopied(apiPlatform);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  const pollSyncStatus = useCallback(
    (apiPlatform: string) => {
      if (pollTimers.current[apiPlatform]) {
        clearInterval(pollTimers.current[apiPlatform]);
      }

      const timer = setInterval(async () => {
        try {
          const res = await fetch(`/api/sync/${apiPlatform}`);
          const json = await res.json();
          const job = json.data?.lastJob as SyncJobInfo | null;

          if (job) {
            setLiveJobs((prev) => ({ ...prev, [apiPlatform]: job }));

            if (job.status === "COMPLETED" || job.status === "FAILED") {
              clearInterval(pollTimers.current[apiPlatform]);
              delete pollTimers.current[apiPlatform];

              const errorCount = Array.isArray(job.errors) ? job.errors.length : 0;
              const msg =
                job.status === "COMPLETED"
                  ? `Done — ${job.itemsProcessed} items processed, ${job.itemsCreated} created, ${job.itemsUpdated} updated${errorCount > 0 ? `, ${errorCount} errors` : ""}`
                  : `Failed — see errors below`;

              setSyncing((prev) => ({
                ...prev,
                [apiPlatform]: job.status === "COMPLETED" ? "done" : "error",
              }));
              setResults((prev) => ({ ...prev, [apiPlatform]: msg }));
              if (errorCount > 0) {
                setErrorsExpanded((prev) => ({ ...prev, [apiPlatform]: true }));
              }
              fetchIntegrations();
            }
          }
        } catch { /* ignore */ }
      }, 2000);

      pollTimers.current[apiPlatform] = timer;
    },
    [fetchIntegrations]
  );

  // On mount: check each store for a running or last completed sync job
  const initialCheckDone = useRef(false);
  useEffect(() => {
    if (initialCheckDone.current) return;
    initialCheckDone.current = true;

    (async () => {
      for (const store of stores) {
        try {
          const res = await fetch(`/api/sync/${store.apiPlatform}`);
          const json = await res.json();
          const job = json.data?.lastJob as SyncJobInfo | null;
          if (!job) continue;

          setLiveJobs((prev) => ({ ...prev, [store.apiPlatform]: job }));

          if (job.status === "RUNNING") {
            setSyncing((prev) => ({ ...prev, [store.apiPlatform]: "syncing" }));
            pollSyncStatus(store.apiPlatform);
          } else if (job.status === "COMPLETED" || job.status === "FAILED") {
            const errorCount = Array.isArray(job.errors) ? job.errors.length : 0;
            const msg =
              job.status === "COMPLETED"
                ? `Last sync: ${job.itemsProcessed} processed, ${job.itemsCreated} created, ${job.itemsUpdated} updated${errorCount > 0 ? `, ${errorCount} errors` : ""}`
                : `Last sync failed — see errors below`;
            setSyncing((prev) => ({
              ...prev,
              [store.apiPlatform]: job.status === "COMPLETED" ? "done" : "error",
            }));
            setResults((prev) => ({ ...prev, [store.apiPlatform]: msg }));
          }
        } catch { /* ignore */ }
      }
    })();
  }, [pollSyncStatus]);

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
            [apiPlatform]: res.ok ? "Invalid response from server" : `Sync failed (${res.status}). Check server logs.`,
          }));
          return;
        }

        if (!res.ok) {
          setSyncing((prev) => ({ ...prev, [apiPlatform]: "error" }));
          setResults((prev) => ({ ...prev, [apiPlatform]: json.error ?? "Sync failed" }));
          return;
        }

        const d = json.data;

        if (d?.status === "STARTED" || d?.status === "ALREADY_RUNNING") {
          pollSyncStatus(apiPlatform);
          return;
        }

        const msg = d
          ? `Done — ${d.itemsProcessed ?? 0} processed, ${d.itemsCreated ?? 0} created, ${d.itemsUpdated ?? 0} updated`
          : "Sync completed";

        setSyncing((prev) => ({ ...prev, [apiPlatform]: "done" }));
        setResults((prev) => ({ ...prev, [apiPlatform]: msg }));
        fetchIntegrations();
      } catch (err) {
        setSyncing((prev) => ({ ...prev, [apiPlatform]: "error" }));
        setResults((prev) => ({
          ...prev,
          [apiPlatform]: err instanceof Error ? err.message : "Network error",
        }));
      }
    },
    [fetchIntegrations, pollSyncStatus]
  );

  const syncAll = useCallback(async () => {
    setSyncAllRunning(true);
    const connected = stores.filter((s) => getStatus(s.apiPlatform)?.connected);
    await Promise.allSettled(connected.map((s) => syncStore(s.apiPlatform)));
    setSyncAllRunning(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [integrations, syncStore]);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Sync</h1>
        <p className="text-sm text-muted-foreground">
          Pull-only sync controls — fetch latest data from connected marketplaces
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
          {syncAllRunning ? "Syncing All…" : "Sync All"}
        </button>
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
          const isSyncing = storeSync === "syncing";
          const jobErrors = (liveJob?.errors ?? []) as SyncError[];
          const showErrors = errorsExpanded[store.apiPlatform] && jobErrors.length > 0;

          return (
            <article
              key={store.id}
              className={cn(
                "rounded-lg border border-border bg-card p-6 transition-colors duration-200",
                "hover:border-border/80 hover:bg-card/95"
              )}
            >
              {/* Header */}
              <div className="mb-4 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  {logoSrc && (
                    <img src={logoSrc} alt={store.platform} width={20} height={20}
                      style={{ width: 20, height: 20, minWidth: 20 }} className="shrink-0" />
                  )}
                  <h3 className="truncate text-base font-semibold text-foreground">{store.name}</h3>
                  <span className={cn("shrink-0 rounded border px-2 py-0.5 text-xs font-medium", theme.badge)}>
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

              {/* Last synced */}
              <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Clock className="h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    Last synced:{" "}
                    {status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : "Never"}
                  </span>
                </div>
              </div>

              {/* Live progress */}
              {isSyncing && liveJob && liveJob.status === "RUNNING" && (
                <div className="mb-4 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
                    <span className="text-xs font-medium text-blue-400">Syncing…</span>
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
                  {jobErrors.length > 0 && (
                    <div className="mt-2 flex items-center gap-1 text-xs text-red-400">
                      <AlertTriangle className="h-3 w-3" />
                      <span>{jobErrors.length} error{jobErrors.length > 1 ? "s" : ""} so far</span>
                    </div>
                  )}
                </div>
              )}

              {isSyncing && !liveJob && (
                <div className="mb-4 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
                    <span className="text-xs font-medium text-blue-400">Starting sync…</span>
                  </div>
                </div>
              )}

              {/* Result message */}
              {result && !isSyncing && (
                <div
                  className={cn(
                    "mb-4 rounded-md px-3 py-2 text-xs",
                    storeSync === "error"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-emerald-500/10 text-emerald-400"
                  )}
                >
                  {result}
                </div>
              )}

              {/* Error details */}
              {!isSyncing && jobErrors.length > 0 && (
                <div className="mb-4">
                  <button
                    onClick={() =>
                      setErrorsExpanded((prev) => ({
                        ...prev,
                        [store.apiPlatform]: !prev[store.apiPlatform],
                      }))
                    }
                    className="flex w-full items-center justify-between rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/15 cursor-pointer"
                  >
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      <span>
                        {jobErrors.length} error{jobErrors.length > 1 ? "s" : ""}
                      </span>
                    </div>
                    {showErrors ? (
                      <ChevronUp className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                  </button>

                  {showErrors && (
                    <div className="mt-2 rounded-md border border-border bg-background p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase text-muted-foreground">
                          Error Log
                        </span>
                        <button
                          onClick={() => copyErrors(store.apiPlatform)}
                          className="flex items-center gap-1 rounded border border-border bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
                        >
                          <Copy className="h-3 w-3" />
                          {copied === store.apiPlatform ? "Copied!" : "Copy All Errors"}
                        </button>
                      </div>
                      <div className="max-h-60 overflow-auto space-y-1.5 text-[11px] font-mono">
                        {jobErrors.map((err, idx) => (
                          <div
                            key={idx}
                            className="rounded border border-border/50 bg-card/50 px-2 py-1.5"
                          >
                            <span className="font-bold text-red-400">
                              {err.sku}
                            </span>
                            <span className="text-muted-foreground"> — </span>
                            <span className="text-foreground/80 break-all">
                              {err.message}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Sync button */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  disabled={!connected || isSyncing}
                  onClick={() => syncStore(store.apiPlatform)}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground",
                    "transition-colors hover:bg-muted hover:text-foreground",
                    "disabled:cursor-not-allowed disabled:opacity-50"
                  )}
                  aria-label={`Sync ${store.name} now`}
                >
                  {isSyncing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {isSyncing ? "Syncing…" : "Sync Now"}
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
