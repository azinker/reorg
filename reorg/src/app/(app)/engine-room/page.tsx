"use client";

import { useState } from "react";
import {
  Gauge,
  Activity,
  GitPullRequest,
  FileText,
  Shield,
  RefreshCw,
  Send,
  ScrollText,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "sync-jobs", label: "Sync Jobs", icon: RefreshCw },
  { id: "push-queue", label: "Push Queue", icon: Send },
  { id: "change-log", label: "Change Log", icon: ScrollText },
  { id: "raw-events", label: "Raw Events", icon: Terminal },
] as const;

const EMPTY_STATES: Record<(typeof TABS)[number]["id"], string> = {
  "sync-jobs":
    "No sync jobs recorded yet. Connect an integration and run your first sync.",
  "push-queue":
    "No pushes queued. Stage changes in the dashboard and push when ready.",
  "change-log":
    "No changes logged yet. Edits, pushes, and sync events will appear here.",
  "raw-events": "Raw API events will appear here for debugging.",
};

export default function EngineRoomPage() {
  const [activeTab, setActiveTab] = useState<(typeof TABS)[number]["id"]>(
    "sync-jobs"
  );

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Engine Room
        </h1>
        <p className="text-sm text-muted-foreground">
          Operations control center — sync jobs, push queue, audit trail
        </p>
      </div>

      {/* Summary cards */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article
          className={cn(
            "rounded-lg border border-border bg-card p-4 transition-colors duration-200",
            "ring-1 ring-border/50",
            "hover:border-border/80 hover:bg-card/95"
          )}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
                "bg-muted/80 text-muted-foreground"
              )}
            >
              <Activity className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-foreground">
                0
              </p>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Active Syncs
              </p>
            </div>
          </div>
        </article>

        <article
          className={cn(
            "rounded-lg border border-border bg-card p-4 transition-colors duration-200",
            "ring-1 ring-border/50",
            "hover:border-border/80 hover:bg-card/95"
          )}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
                "bg-muted/80 text-muted-foreground"
              )}
            >
              <GitPullRequest className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-foreground">
                0
              </p>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Queued Pushes
              </p>
            </div>
          </div>
        </article>

        <article
          className={cn(
            "rounded-lg border border-border bg-card p-4 transition-colors duration-200",
            "ring-1 ring-border/50",
            "hover:border-border/80 hover:bg-card/95"
          )}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
                "bg-muted/80 text-muted-foreground"
              )}
            >
              <FileText className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-foreground">
                0
              </p>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Recent Errors
              </p>
            </div>
          </div>
        </article>

        <article
          className={cn(
            "rounded-lg border border-amber-500/30 bg-card p-4 transition-colors duration-200",
            "ring-1 ring-amber-500/20",
            "hover:border-amber-500/40 hover:bg-card/95"
          )}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
                "bg-amber-500/15 text-amber-500 dark:text-amber-400"
              )}
            >
              <Shield className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                ON
              </p>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Write Lock Status
              </p>
            </div>
          </div>
        </article>
      </div>

      {/* Tabbed section */}
      <div
        className={cn(
          "rounded-lg border border-border bg-card",
          "ring-1 ring-border/30"
        )}
      >
        {/* Tab bar */}
        <div className="flex border-b border-border">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-5 py-3 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  isActive
                    ? "border-b-2 border-primary text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}
                aria-selected={isActive}
                aria-controls={`panel-${tab.id}`}
                id={`tab-${tab.id}`}
                role="tab"
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab panels */}
        <div
          id={`panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`tab-${activeTab}`}
          className="min-h-[280px] p-8"
        >
          <div className="flex flex-col items-center justify-center gap-3 text-center">
            <div
              className={cn(
                "flex h-14 w-14 shrink-0 items-center justify-center rounded-full",
                "bg-muted/60 text-muted-foreground"
              )}
            >
              {(() => {
                const TabIcon = TABS.find((t) => t.id === activeTab)!.icon;
                return <TabIcon className="h-7 w-7" aria-hidden />;
              })()}
            </div>
            <p className="max-w-md text-sm text-muted-foreground">
              {EMPTY_STATES[activeTab]}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
