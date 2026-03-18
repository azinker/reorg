"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Filter,
  AlertTriangle,
  AlertCircle,
  Info,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const SEVERITY_OPTIONS = [
  { value: "all", label: "All" },
  { value: "critical", label: "Critical" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
] as const;

const BASE_STORE_OPTIONS = [{ value: "all", label: "All" }] as const;
const CATEGORY_OPTIONS = [
  { value: "all", label: "All Causes" },
  { value: "stale-pull", label: "Stale Pulls" },
  { value: "dead-webhook", label: "Dead Webhooks" },
  { value: "sync-failure", label: "Sync Failures" },
  { value: "sync-warning", label: "Sync Warnings" },
  { value: "missing-data", label: "Missing Data" },
] as const;

const TIME_OPTIONS = [
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
] as const;

type Severity = "critical" | "warning" | "info";
type ErrorCategory =
  | "stale-pull"
  | "dead-webhook"
  | "sync-failure"
  | "sync-warning"
  | "missing-data"
  | "system";

interface ErrorEntry {
  id: string;
  severity: Severity;
  category: ErrorCategory;
  summary: string;
  technicalDetails: string;
  store: string;
  storeAcronym: string;
  timestamp: string;
  occurredAt: string;
  recommendedAction: string;
  actionLabel: string | null;
  actionHref: string | null;
  priority: number;
}

const categoryLabels: Record<ErrorCategory, string> = {
  "stale-pull": "Stale Pull",
  "dead-webhook": "Dead Webhook",
  "sync-failure": "Sync Failure",
  "sync-warning": "Sync Warning",
  "missing-data": "Missing Data",
  system: "System",
};

const severityConfig: Record<
  Severity,
  { icon: typeof AlertCircle; badgeCls: string; borderCls: string }
> = {
  critical: {
    icon: AlertCircle,
    badgeCls: "bg-red-500/15 text-red-400 border-red-500/30",
    borderCls: "border-l-red-500",
  },
  warning: {
    icon: AlertTriangle,
    badgeCls: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    borderCls: "border-l-amber-500",
  },
  info: {
    icon: Info,
    badgeCls: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    borderCls: "border-l-blue-500",
  },
};

function ErrorCard({
  error,
  onDismiss,
}: {
  error: ErrorEntry;
  onDismiss: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const config = severityConfig[error.severity];
  const SeverityIcon = config.icon;

  return (
    <article
      className={cn(
        "rounded-lg border border-border border-l-4 bg-card p-5 transition-colors duration-200",
        config.borderCls,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <SeverityIcon
            className={cn(
              "mt-0.5 h-5 w-5 shrink-0",
              config.badgeCls.split(" ").find((token) => token.startsWith("text-")),
            )}
            aria-hidden
          />
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium capitalize",
                  config.badgeCls,
                )}
              >
                {error.severity}
              </span>
              <span className="inline-flex items-center rounded border border-border bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {error.storeAcronym}
              </span>
              <span className="inline-flex items-center rounded border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground/80">
                {categoryLabels[error.category]}
              </span>
              <span className="text-xs text-muted-foreground">{error.timestamp}</span>
            </div>
            <p className="text-sm font-medium text-foreground">{error.summary}</p>
            <p className="text-xs text-muted-foreground">{error.store}</p>
            <p className="text-xs text-foreground/80">
              Next step: {error.recommendedAction}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(error.id)}
          className="shrink-0 cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Dismiss error"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="mt-3 ml-8">
        {error.actionLabel && error.actionHref ? (
          <div className="mb-2">
            <Link
              href={error.actionHref}
              className="inline-flex cursor-pointer items-center rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              {error.actionLabel}
            </Link>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" aria-hidden />
              Hide Technical Details
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              Show Technical Details
            </>
          )}
        </button>
        {expanded ? (
          <div className="mt-2 rounded-md border border-border bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300">
            {error.technicalDetails}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export default function ErrorsPage() {
  const [entries, setEntries] = useState<ErrorEntry[]>([]);
  const [severity, setSeverity] = useState("all");
  const [category, setCategory] = useState("all");
  const [store, setStore] = useState("all");
  const [timeRange, setTimeRange] = useState("24h");
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadErrors() {
      setLoading(true);
      setLoadError("");

      try {
        const res = await fetch("/api/errors", { cache: "no-store" });
        const json = await res.json();

        if (!res.ok) {
          throw new Error(json.error ?? "Failed to load errors");
        }

        if (!cancelled) {
          setEntries(Array.isArray(json.data) ? json.data : []);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "Failed to load errors",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadErrors();

    return () => {
      cancelled = true;
    };
  }, []);

  const storeOptions = useMemo(() => {
    const dynamicOptions = entries
      .map((entry) => ({
        value: entry.storeAcronym.toLowerCase(),
        label: entry.storeAcronym,
      }))
      .filter(
        (option, index, array) =>
          array.findIndex((candidate) => candidate.value === option.value) === index,
      );

    return [...BASE_STORE_OPTIONS, ...dynamicOptions];
  }, [entries]);

  const filteredErrors = entries.filter((entry) => {
    if (dismissedIds.has(entry.id)) return false;
    if (severity !== "all" && entry.severity !== severity) return false;
    if (category !== "all" && entry.category !== category) return false;
    if (store !== "all" && entry.storeAcronym.toLowerCase() !== store) return false;

    const ageMs = Date.now() - new Date(entry.occurredAt).getTime();
    if (timeRange === "24h" && ageMs > 24 * 60 * 60 * 1000) return false;
    if (timeRange === "7d" && ageMs > 7 * 24 * 60 * 60 * 1000) return false;
    if (timeRange === "30d" && ageMs > 30 * 24 * 60 * 60 * 1000) return false;

    return true;
  });

  const groupedErrors = useMemo(() => {
    const order: ErrorCategory[] = [
      "sync-failure",
      "stale-pull",
      "dead-webhook",
      "missing-data",
      "sync-warning",
      "system",
    ];
    return order
      .map((group) => ({
        category: group,
        label: categoryLabels[group],
        entries: filteredErrors.filter((entry) => entry.category === group),
      }))
      .filter((group) => group.entries.length > 0);
  }, [filteredErrors]);

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Errors
        </h1>
        <p className="text-sm text-muted-foreground">
          Friendly error summaries for missing data, failed syncs, and stores that are falling behind
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Filter className="h-4 w-4 shrink-0" aria-hidden />
          <span className="font-medium">Filters</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className={cn(
                "cursor-pointer appearance-none rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm text-foreground",
                "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
              )}
              aria-label="Filter by root cause"
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
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
              value={severity}
              onChange={(event) => setSeverity(event.target.value)}
              className={cn(
                "cursor-pointer appearance-none rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm text-foreground",
                "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
              )}
              aria-label="Filter by severity"
            >
              {SEVERITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
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
              onChange={(event) => setStore(event.target.value)}
              className={cn(
                "cursor-pointer appearance-none rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm text-foreground",
                "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
              )}
              aria-label="Filter by store"
            >
              {storeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
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
              onChange={(event) => setTimeRange(event.target.value)}
              className={cn(
                "cursor-pointer appearance-none rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm text-foreground",
                "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
              )}
              aria-label="Filter by time range"
            >
              {TIME_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
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

      {loadError ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {loadError}
        </div>
      ) : loading ? (
        <div className="rounded-lg border border-border bg-card px-4 py-8 text-sm text-muted-foreground">
          Loading error summaries...
        </div>
      ) : filteredErrors.length > 0 ? (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Showing
              </div>
              <div className="mt-1 text-lg font-semibold text-foreground">
                {filteredErrors.length} issue{filteredErrors.length === 1 ? "" : "s"}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Critical
              </div>
              <div className="mt-1 text-lg font-semibold text-red-300">
                {filteredErrors.filter((entry) => entry.severity === "critical").length}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Warnings
              </div>
              <div className="mt-1 text-lg font-semibold text-amber-300">
                {filteredErrors.filter((entry) => entry.severity === "warning").length}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Top Cause
              </div>
              <div className="mt-1 text-lg font-semibold text-foreground">
                {groupedErrors[0]?.label ?? "None"}
              </div>
            </div>
          </div>

          {groupedErrors.map((group) => (
            <section key={group.category} className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {group.entries.length} issue{group.entries.length === 1 ? "" : "s"} in this queue
                  </p>
                </div>
              </div>
              <div className="space-y-4">
                {group.entries.map((error) => (
                  <ErrorCard
                    key={error.id}
                    error={error}
                    onDismiss={(id) =>
                      setDismissedIds((prev) => {
                        const next = new Set(prev);
                        next.add(id);
                        return next;
                      })
                    }
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="flex min-h-[320px] items-center justify-center">
          <article
            className={cn(
              "flex w-full max-w-lg flex-col items-center gap-4 rounded-lg border border-border bg-card p-10 text-center",
              "shadow-sm",
            )}
          >
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
              <CheckCircle className="h-8 w-8" aria-hidden />
            </div>
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">
                No errors to show
              </h2>
              <p className="text-sm text-muted-foreground">
                All current errors have been dismissed or filtered out.
              </p>
            </div>
          </article>
        </div>
      )}
    </div>
  );
}
