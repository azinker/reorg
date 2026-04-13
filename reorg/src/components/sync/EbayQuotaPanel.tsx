"use client";

import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/sync-utils";
import type { RateLimitsData, SyncProfile, SyncRouteData } from "@/lib/sync-types";

type Props = {
  rateLimits: RateLimitsData | null;
  syncProfile: SyncProfile | null;
  isSyncing: boolean;
  nowMs: number;
  apiPlatform: string;
  onToggleUpc: () => void;
};

export function EbayQuotaPanel({ rateLimits, syncProfile, isSyncing, nowMs, onToggleUpc }: Props) {
  return (
    <>
      {/* Quota bars */}
      <div className="mt-4 rounded-lg border border-border/60 bg-muted/10 px-3 py-2.5" data-tour="sync-ebay-quota">
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
                    ? Math.max(method.count > 0 ? 2 : 0, Math.round((method.count / method.limit) * 100))
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
                ? "\u2014"
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

      {/* UPC toggle */}
      {syncProfile && (
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
            onClick={onToggleUpc}
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
    </>
  );
}
