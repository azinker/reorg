"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, Loader2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";
import { SyncStoreCard } from "@/components/sync/SyncStoreCard";
import { useSyncPage } from "@/hooks/use-sync-page";

function SyncAllDropdown({
  syncAll,
  syncAllRunning,
}: {
  syncAll: (mode?: "full" | "incremental") => Promise<void>;
  syncAllRunning: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={syncAllRunning}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {syncAllRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        {syncAllRunning ? "Syncing All..." : "Sync All"}
        {!syncAllRunning && <ChevronDown className="h-3.5 w-3.5 opacity-70" />}
      </button>

      {open && !syncAllRunning && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-52 rounded-lg border border-border bg-card p-1 shadow-lg">
          <button
            type="button"
            onClick={() => { setOpen(false); void syncAll("incremental"); }}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-violet-500/10"
          >
            <RefreshCw className="h-3.5 w-3.5 text-violet-400" />
            <div>
              <div className="font-medium text-foreground">Normal Sync All</div>
              <div className="text-[11px] text-muted-foreground">Quick pull of recent changes</div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); void syncAll("full"); }}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-violet-500/10"
          >
            <RefreshCw className="h-3.5 w-3.5 text-purple-400" />
            <div>
              <div className="font-medium text-foreground">Full Sync All</div>
              <div className="text-[11px] text-muted-foreground">Re-download all listings</div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

export default function SyncPage() {
  const {
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
    stores,
    getStatus,
    syncStore,
    cancelSync,
    syncAll,
    copyErrors,
    toggleErrors,
    setSyncMeta,
  } = useSyncPage();

  const healthSummary = schedulerStatus?.healthSummary;
  const showHealthAlert = healthSummary && healthSummary.status !== "healthy";

  const handleToggleUpc = async (apiPlatform: string) => {
    const meta = syncMeta[apiPlatform];
    if (!meta?.syncProfile) return;
    const next = !meta.syncProfile.skipUpcHydration;
    setSyncMeta((prev) => ({
      ...prev,
      [apiPlatform]: prev[apiPlatform]
        ? {
            ...prev[apiPlatform]!,
            syncProfile: { ...prev[apiPlatform]!.syncProfile, skipUpcHydration: next },
          }
        : prev[apiPlatform],
    }));
    await fetch(`/api/integrations/${apiPlatform}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { syncProfile: { skipUpcHydration: next } } }),
    });
  };

  return (
    <div className="min-h-screen p-6" data-tour="sync-header">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Sync</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pull-only &mdash; fetches the latest data from your connected marketplaces
          </p>
        </div>
        <div className="flex items-center gap-3" data-tour="sync-actions">
          <div
            data-tour="sync-auto-badge"
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
          <SyncAllDropdown syncAll={syncAll} syncAllRunning={syncAllRunning} />
        </div>
      </div>

      {/* Health alert */}
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
          <span className="ml-3 opacity-80">&rarr; {healthSummary.recommendedAction}</span>
        </div>
      )}

      {/* Store cards */}
      <div className="grid gap-5 md:grid-cols-2" data-tour="sync-stores">
        {stores.map((store) => (
          <SyncStoreCard
            key={store.id}
            store={store}
            status={getStatus(store.apiPlatform)}
            storeSync={syncing[store.apiPlatform] ?? "idle"}
            result={results[store.apiPlatform]}
            liveJob={liveJobs[store.apiPlatform] ?? null}
            meta={syncMeta[store.apiPlatform] ?? null}
            errorsExpanded={errorsExpanded[store.apiPlatform] ?? false}
            copied={copied === store.apiPlatform}
            nowMs={nowMs}
            schedulerEnabled={schedulerEnabled}
            schedulerStatus={schedulerStatus}
            onSync={syncStore}
            onCancel={cancelSync}
            onCopyErrors={copyErrors}
            onToggleErrors={toggleErrors}
            onToggleUpc={handleToggleUpc}
          />
        ))}
      </div>

      <PageTour page="sync" steps={PAGE_TOUR_STEPS.sync} ready />
    </div>
  );
}
