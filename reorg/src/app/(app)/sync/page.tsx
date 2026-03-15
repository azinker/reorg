"use client";

import { RefreshCw, CheckCircle, XCircle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

const stores = [
  {
    id: "tpp",
    name: "The Perfect Part",
    acronym: "TPP",
    platform: "eBay",
    theme: "blue",
  },
  {
    id: "tt",
    name: "Telitetech",
    acronym: "TT",
    platform: "eBay",
    theme: "emerald",
  },
  {
    id: "bc",
    name: "BigCommerce",
    acronym: "BC",
    platform: "BigCommerce",
    theme: "orange",
  },
  {
    id: "shpfy",
    name: "Shopify",
    acronym: "SHPFY",
    platform: "Shopify",
    theme: "lime",
  },
] as const;

const themeClasses = {
  blue: {
    badge: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  },
  emerald: {
    badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  },
  orange: {
    badge: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  },
  lime: {
    badge: "bg-lime-500/15 text-lime-400 border-lime-500/30",
  },
} as const;

export default function SyncPage() {
  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Sync</h1>
        <p className="text-sm text-muted-foreground">
          Pull-only sync controls — fetch latest data from connected marketplaces
        </p>
      </div>

      {/* Status banner */}
      <div className="mb-6 flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3">
        <CheckCircle className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">
          Sync is pull-only. It never pushes changes to marketplaces.
        </p>
      </div>

      {/* Sync All button */}
      <div className="mb-8">
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label="Sync all marketplaces"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Sync All
        </button>
      </div>

      {/* Store cards grid */}
      <div className="grid gap-4 sm:grid-cols-2">
        {stores.map((store) => {
          const theme = themeClasses[store.theme];
          return (
            <article
              key={store.id}
              className={cn(
                "rounded-lg border border-border bg-card p-6 transition-colors duration-200",
                "hover:border-border/80 hover:bg-card/95"
              )}
            >
              {/* Card header: name + acronym badge */}
              <div className="mb-4 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <h3 className="truncate text-base font-semibold text-foreground">
                    {store.name}
                  </h3>
                  <span
                    className={cn(
                      "shrink-0 rounded border px-2 py-0.5 text-xs font-medium",
                      theme.badge
                    )}
                  >
                    {store.acronym}
                  </span>
                </div>
                {/* Connection status */}
                <div className="flex shrink-0 items-center gap-1.5">
                  <XCircle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="text-xs text-muted-foreground">Not Connected</span>
                </div>
              </div>

              {/* Stats row */}
              <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Clock className="h-4 w-4 shrink-0" aria-hidden />
                  <span>Last synced: Never</span>
                </div>
                <div className="text-muted-foreground">
                  <span>0 items</span>
                </div>
              </div>

              {/* Sync Now button + Pull-only label */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground",
                    "transition-colors hover:bg-muted hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  )}
                  aria-label={`Sync ${store.name} now`}
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  Sync Now
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
