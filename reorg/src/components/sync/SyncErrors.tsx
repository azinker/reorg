"use client";

import { AlertTriangle, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SyncError } from "@/lib/sync-types";

type Props = {
  errors: SyncError[];
  expanded: boolean;
  isSyncing: boolean;
  copied: boolean;
  onToggle: () => void;
  onCopy: () => void;
};

export function SyncErrors({ errors, expanded, isSyncing, copied, onToggle, onCopy }: Props) {
  if (isSyncing || errors.length === 0) return null;

  const nonPhaseErrors = errors.filter((e) => e.sku !== "_phase");
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
        Last pull timed out &mdash; the next scheduled sync will retry automatically.
      </div>
    );
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/15"
      >
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5" />
          {realErrors.length} issue{realErrors.length > 1 ? "s" : ""}
        </div>
        {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {expanded && (
        <div className="mt-2 rounded-lg border border-border bg-background p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase text-muted-foreground">Error Log</span>
            <button
              type="button"
              onClick={onCopy}
              className={cn(
                "flex cursor-pointer items-center gap-1 rounded border border-border bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground",
              )}
            >
              <Copy className="h-3 w-3" />
              {copied ? "Copied!" : "Copy All"}
            </button>
          </div>
          <div className="max-h-48 space-y-1 overflow-auto font-mono text-[11px]">
            {realErrors.map((error, i) => (
              <div key={i} className="rounded border border-border/50 bg-card/50 px-2 py-1.5">
                <span className="font-bold text-red-400">{error.sku}</span>
                <span className="text-muted-foreground"> &mdash; </span>
                <span className="break-all text-foreground/80">{error.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
