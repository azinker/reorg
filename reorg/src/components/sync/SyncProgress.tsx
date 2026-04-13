"use client";

import { Loader2, AlertTriangle } from "lucide-react";
import type { SyncJobInfo, SyncError } from "@/lib/sync-types";
import { formatDurationMs } from "@/lib/sync-utils";

type Props = {
  liveJob: SyncJobInfo | null;
  isSyncing: boolean;
  durationMs: number | null;
  platform: string;
};

export function SyncProgress({ liveJob, isSyncing, durationMs, platform }: Props) {
  if (!isSyncing) return null;

  if (!liveJob) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/[0.04] px-4 py-3">
        <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
        <span className="text-sm font-medium text-violet-400">Starting sync...</span>
      </div>
    );
  }

  if (liveJob.status !== "RUNNING") return null;

  const isChunkedPlatform = platform === "BigCommerce" || platform === "Shopify";
  const itemsPerMin =
    liveJob.itemsProcessed > 0 && durationMs && durationMs > 5000
      ? Math.round((liveJob.itemsProcessed / (durationMs / 1000)) * 60)
      : null;
  const jobErrors = (liveJob.errors ?? []) as SyncError[];

  return (
    <div className="mt-4 rounded-lg border border-violet-500/30 bg-violet-500/[0.04] p-4" data-tour="sync-live-progress">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
          <span className="text-sm font-semibold text-violet-400">
            {liveJob.itemsProcessed === 0 ? "Starting\u2026" : "Syncing\u2026"}
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
            {phaseEntry ? phaseEntry.message : "Connected \u2014 waiting for first batch to report progress."}
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
}
