"use client";

import { useState } from "react";
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

type Severity = "critical" | "warning" | "info";

interface ErrorEntry {
  id: string;
  severity: Severity;
  summary: string;
  technicalDetails: string;
  store: string;
  storeAcronym: string;
  timestamp: string;
}

const DUMMY_ERRORS: ErrorEntry[] = [
  {
    id: "err-001",
    severity: "critical",
    summary: "eBay API rate limit exceeded during sync",
    technicalDetails:
      "GET /sell/inventory/item returned HTTP 429 (Too Many Requests). X-RateLimit-Remaining: 0, X-RateLimit-Reset: 1742058012. Sync job SJ-0038 aborted after 12 seconds. Retry scheduled for 60s after reset window.",
    store: "eBay",
    storeAcronym: "TPP",
    timestamp: "Mar 14, 2026 6:00 PM",
  },
  {
    id: "err-002",
    severity: "critical",
    summary: "Shopify API authentication failed — token may be expired",
    technicalDetails:
      'POST /admin/api/2024-01/products.json returned HTTP 401 (Unauthorized). Response body: {"errors":"[API] Invalid API key or access token (unrecognized login or wrong password)"}. Check Settings → Integrations → Shopify to refresh the access token.',
    store: "Shopify",
    storeAcronym: "SHPFY",
    timestamp: "Mar 14, 2026 11:45 PM",
  },
  {
    id: "err-003",
    severity: "warning",
    summary: "Inventory quantity mismatch detected for SKU TPP-ALT-8803",
    technicalDetails:
      "eBay (TPP) reports availableQuantity: 14 but BigCommerce shows inventory_level: 9 for the same SKU. This discrepancy was detected during the latest sync pull. No automatic correction was made — review and stage changes manually if needed.",
    store: "eBay / BigCommerce",
    storeAcronym: "TPP / BC",
    timestamp: "Mar 15, 2026 8:03 AM",
  },
  {
    id: "err-004",
    severity: "warning",
    summary: "BigCommerce webhook delivery failing — 3 consecutive timeouts",
    technicalDetails:
      "Webhook ID 24819370 (scope: store/product/updated) has failed delivery 3 times in the last hour. Last attempt: POST to configured endpoint timed out after 10,000ms. BigCommerce may automatically deactivate this webhook after 3 more failures.",
    store: "BigCommerce",
    storeAcronym: "BC",
    timestamp: "Mar 15, 2026 9:10 AM",
  },
  {
    id: "err-005",
    severity: "info",
    summary: "eBay (TT) sync completed with 2 skipped items due to missing SKU",
    technicalDetails:
      'Items eBay ID 256104883291 and 256104883445 were returned in the inventory response but have no SKU value set (empty string). These items cannot be matched to a MasterRow and were placed in the Unmatched External Listings queue. Action: assign SKUs on eBay or manually match in the Unmatched page.',
    store: "eBay",
    storeAcronym: "TT",
    timestamp: "Mar 15, 2026 8:00 AM",
  },
];

const severityConfig: Record<Severity, { icon: typeof AlertCircle; badgeCls: string; borderCls: string }> = {
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

function ErrorCard({ error, onDismiss }: { error: ErrorEntry; onDismiss: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const config = severityConfig[error.severity];
  const SeverityIcon = config.icon;

  return (
    <article
      className={cn(
        "rounded-lg border border-border border-l-4 bg-card p-5 transition-colors duration-200",
        config.borderCls
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <SeverityIcon className={cn("mt-0.5 h-5 w-5 shrink-0", config.badgeCls.split(" ").find(c => c.startsWith("text-")))} aria-hidden />
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium capitalize", config.badgeCls)}>
                {error.severity}
              </span>
              <span className="inline-flex items-center rounded border border-border bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {error.storeAcronym}
              </span>
              <span className="text-xs text-muted-foreground">{error.timestamp}</span>
            </div>
            <p className="text-sm font-medium text-foreground">{error.summary}</p>
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
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
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
        {expanded && (
          <div className="mt-2 rounded-md border border-border bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300">
            {error.technicalDetails}
          </div>
        )}
      </div>
    </article>
  );
}

export default function ErrorsPage() {
  const [severity, setSeverity] = useState("all");
  const [store, setStore] = useState("all");
  const [timeRange, setTimeRange] = useState("24h");
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const filteredErrors = DUMMY_ERRORS.filter((err) => {
    if (dismissedIds.has(err.id)) return false;
    if (severity !== "all" && err.severity !== severity) return false;
    if (store !== "all" && !err.storeAcronym.toLowerCase().includes(store)) return false;
    return true;
  });

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

      {/* Error cards */}
      {filteredErrors.length > 0 ? (
        <div className="space-y-4">
          {filteredErrors.map((error) => (
            <ErrorCard
              key={error.id}
              error={error}
              onDismiss={(id) => setDismissedIds((prev) => new Set(prev).add(id))}
            />
          ))}
        </div>
      ) : (
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
                No errors to show
              </h2>
              <p className="text-sm text-muted-foreground">
                All errors have been dismissed or filtered out.
              </p>
            </div>
          </article>
        </div>
      )}
    </div>
  );
}
