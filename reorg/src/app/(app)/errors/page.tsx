"use client";

import { useState } from "react";
import { CheckCircle, ChevronDown, Filter } from "lucide-react";
import { cn } from "@/lib/utils";

const SEVERITY_OPTIONS = [
  { value: "all", label: "All" },
  { value: "critical", label: "Critical" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
] as const;

const STORE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "tpp", label: "TPP" },
  { value: "tt", label: "TT" },
  { value: "bc", label: "BC" },
  { value: "shpfy", label: "SHPFY" },
] as const;

const TIME_OPTIONS = [
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
] as const;

export default function ErrorsPage() {
  const [severity, setSeverity] = useState("all");
  const [store, setStore] = useState("all");
  const [timeRange, setTimeRange] = useState("24h");

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Errors
        </h1>
        <p className="text-sm text-muted-foreground">
          Friendly error summaries with technical details available
        </p>
      </div>

      {/* Filter row */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Filter className="h-4 w-4 shrink-0" aria-hidden />
          <span className="font-medium">Filters</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className={cn(
                "cursor-pointer appearance-none rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm",
                "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
                "text-foreground"
              )}
              aria-label="Filter by severity"
            >
              {SEVERITY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <ChevronDown
              className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
          </div>
          <div className="relative">
            <select
              value={store}
              onChange={(e) => setStore(e.target.value)}
              className={cn(
                "cursor-pointer appearance-none rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm",
                "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
                "text-foreground"
              )}
              aria-label="Filter by store"
            >
              {STORE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <ChevronDown
              className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
          </div>
          <div className="relative">
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value)}
              className={cn(
                "cursor-pointer appearance-none rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm",
                "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
                "text-foreground"
              )}
              aria-label="Filter by time range"
            >
              {TIME_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <ChevronDown
              className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
          </div>
        </div>
      </div>

      {/* Empty state */}
      <div className="flex min-h-[320px] items-center justify-center">
        <article
          className={cn(
            "flex w-full max-w-lg flex-col items-center gap-4 rounded-lg border border-border bg-card p-10 text-center",
            "shadow-sm"
          )}
        >
          <div
            className={cn(
              "flex h-16 w-16 shrink-0 items-center justify-center rounded-full",
              "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            )}
          >
            <CheckCircle className="h-8 w-8" aria-hidden />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">
              No errors recorded
            </h2>
            <p className="text-sm text-muted-foreground">
              When integration or sync issues occur, they&apos;ll appear here with
              plain-English explanations.
            </p>
          </div>
        </article>
      </div>
    </div>
  );
}
