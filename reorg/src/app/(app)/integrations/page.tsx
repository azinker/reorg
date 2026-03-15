"use client";

import { useState } from "react";
import {
  Plug,
  Crown,
  Lock,
  Unlock,
  CheckCircle,
  XCircle,
  Settings2,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

const integrations = [
  {
    id: "tpp",
    name: "TPP eBay",
    subtitle: "The Perfect Part",
    acronym: "TPP",
    platform: "eBay",
    theme: "blue" as const,
    isMaster: true,
  },
  {
    id: "tt",
    name: "TT eBay",
    subtitle: "Telitetech",
    acronym: "TT",
    platform: "eBay",
    theme: "emerald" as const,
    isMaster: false,
  },
  {
    id: "bc",
    name: "BigCommerce",
    subtitle: null,
    acronym: "BC",
    platform: "BigCommerce",
    theme: "orange" as const,
    isMaster: false,
  },
  {
    id: "shpfy",
    name: "Shopify",
    subtitle: null,
    acronym: "SHPFY",
    platform: "Shopify",
    theme: "lime" as const,
    isMaster: false,
  },
] as const;

const themeClasses = {
  blue: {
    badge:
      "bg-blue-500/15 text-blue-400 border-blue-500/30 dark:bg-blue-500/20 dark:text-blue-400 dark:border-blue-500/40",
  },
  emerald: {
    badge:
      "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 dark:bg-emerald-500/20 dark:text-emerald-400 dark:border-emerald-500/40",
  },
  orange: {
    badge:
      "bg-orange-500/15 text-orange-400 border-orange-500/30 dark:bg-orange-500/20 dark:text-orange-400 dark:border-orange-500/40",
  },
  lime: {
    badge:
      "bg-lime-500/15 text-lime-400 border-lime-500/30 dark:bg-lime-500/20 dark:text-lime-400 dark:border-lime-500/40",
  },
} as const;

export default function IntegrationsPage() {
  const [writeLocks, setWriteLocks] = useState<Record<string, boolean>>({
    tpp: true,
    tt: true,
    bc: true,
    shpfy: true,
  });

  const connectedCount = 0;

  const toggleWriteLock = (id: string) => {
    setWriteLocks((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Integrations
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage marketplace connections, API tokens, and write locks
        </p>
      </div>

      {/* Summary bar */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Plug
              className="h-5 w-5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="text-sm font-medium text-foreground">
              {connectedCount} of {integrations.length} connected
            </span>
          </div>
          <div className="h-2 w-32 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300 ease-in-out"
              style={{
                width: `${(connectedCount / integrations.length) * 100}%`,
              }}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <Lock className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
          <p className="text-sm text-amber-700 dark:text-amber-400">
            All integrations launch with write locks enabled
          </p>
        </div>
      </div>

      {/* Integration cards grid */}
      <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
        {integrations.map((integration) => {
          const theme = themeClasses[integration.theme];
          const isLocked = writeLocks[integration.id];
          const isConnected = false;

          return (
            <article
              key={integration.id}
              className={cn(
                "flex flex-col rounded-lg border border-border bg-card p-6 transition-colors duration-200",
                "hover:border-border/80 hover:bg-card/95"
              )}
            >
              {/* Card header: store name + badges */}
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <h3 className="truncate text-base font-semibold text-foreground">
                  {integration.name}
                  {integration.subtitle && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      ({integration.subtitle})
                    </span>
                  )}
                </h3>
                <span
                  className={cn(
                    "shrink-0 rounded border px-2 py-0.5 text-xs font-medium",
                    theme.badge
                  )}
                >
                  {integration.acronym}
                </span>
                {integration.isMaster && (
                  <span
                    className="inline-flex cursor-default shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400"
                    title="Master store"
                  >
                    <Crown className="h-3 w-3" aria-hidden />
                    Master
                  </span>
                )}
              </div>

              {/* Connection status */}
              <div className="mb-4 flex items-center gap-1.5">
                {isConnected ? (
                  <>
                    <CheckCircle
                      className="h-4 w-4 shrink-0 text-green-500"
                      aria-hidden
                    />
                    <span className="text-sm text-muted-foreground">
                      Connected
                    </span>
                  </>
                ) : (
                  <>
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-red-500"
                      aria-hidden
                    />
                    <XCircle
                      className="h-4 w-4 shrink-0 text-red-500"
                      aria-hidden
                    />
                    <span className="text-sm text-muted-foreground">
                      Not Connected
                    </span>
                  </>
                )}
              </div>

              {/* Write Lock toggle */}
              <div className="mb-4 flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground">
                  Write Lock
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isLocked}
                  aria-label={`${isLocked ? "Unlock" : "Lock"} writes for ${integration.name}`}
                  onClick={() => toggleWriteLock(integration.id)}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-200",
                    isLocked
                      ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400"
                      : "border-border bg-muted/50 text-muted-foreground hover:bg-muted"
                  )}
                >
                  {isLocked ? (
                    <>
                      <Lock className="h-4 w-4" aria-hidden />
                      Locked
                    </>
                  ) : (
                    <>
                      <Unlock className="h-4 w-4" aria-hidden />
                      Unlocked
                    </>
                  )}
                </button>
              </div>

              {/* Last Sync */}
              <div className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground">
                <span>Last Sync:</span>
                <span>Never</span>
              </div>

              {/* Actions */}
              <div className="mt-auto flex flex-wrap gap-2">
                <button
                  type="button"
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground",
                    "transition-colors hover:bg-muted hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  )}
                  aria-label={`Configure ${integration.name}`}
                >
                  <Settings2 className="h-4 w-4" aria-hidden />
                  Configure
                </button>
                <button
                  type="button"
                  disabled={!isConnected}
                  aria-label={`Test connection for ${integration.name}`}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors",
                    isConnected
                      ? "cursor-pointer bg-background text-foreground hover:bg-muted hover:text-foreground"
                      : "cursor-not-allowed border-border/50 bg-muted/30 text-muted-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none"
                  )}
                >
                  <Zap className="h-4 w-4" aria-hidden />
                  Test Connection
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
