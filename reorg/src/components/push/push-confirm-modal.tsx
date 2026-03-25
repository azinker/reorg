"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Send,
  Shield,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PLATFORM_COLORS, PLATFORM_SHORT, type Platform } from "@/lib/grid-types";

export interface PushItem {
  stagedChangeId?: string;
  masterRowId?: string;
  marketplaceListingId?: string;
  platformVariantId?: string;
  sku: string;
  title: string;
  platform: Platform;
  listingId: string;
  field: "salePrice" | "adRate" | "upc";
  oldValue: number | string | null;
  newValue: number | string;
}

type ChecklistItem = {
  key: "write-safety" | "batch-size" | "pre-push-backup" | "confirmation" | "post-push-refresh";
  label: string;
  status: "ready" | "warning" | "blocked" | "completed";
  detail: string;
};

type PushResultItem = {
  stagedChangeId: string | null;
  masterRowId: string;
  marketplaceListingId: string;
  platform: Platform;
  listingId: string;
  field: string;
  oldValue: number | string | null;
  newValue: number | string;
  success: boolean;
  error?: string;
};

export type PushApiData = {
  pushJobId: string;
  dryRun: boolean;
  status: "completed" | "partial" | "failed" | "blocked";
  summary: {
    totalChanges: number;
    distinctListings: number;
    successfulChanges: number;
    failedChanges: number;
    successfulListings: number;
    failedListings: number;
    affectedPlatforms: Platform[];
    byPlatform: Array<{
      platform: Platform;
      changes: number;
      distinctListings: number;
      fields: Array<"salePrice" | "adRate" | "upc">;
    }>;
  };
  results: PushResultItem[];
  blockedReason?: string;
  firstLivePush?: boolean;
  operatorChecklist?: Array<{
    label: string;
    detail: string;
  }>;
  message: string;
  nextStep: string;
  batchSafety?: {
    status: "ready" | "warning" | "blocked";
    detail: string;
  };
  goLiveChecklist?: ChecklistItem[];
  prePushBackup?: {
    status: "not-needed" | "ready" | "completed" | "warning" | "blocked" | "failed";
    detail: string;
    backupId?: string | null;
    missingEnvVars?: string[];
    required?: boolean;
  };
  postPushRefresh?: {
    status:
      | "not-needed"
      | "ready"
      | "warning"
      | "blocked"
      | "completed"
      | "failed";
    detail: string;
    retryAt?: string | null;
    requiredCalls?: number | null;
    availableCalls?: number | null;
    results?: Array<{
      platform: Platform;
      label: string;
      status: "COMPLETED" | "FAILED" | "ALREADY_RUNNING" | "UNSUPPORTED" | "STARTED";
      jobId: string | null;
      message: string;
      targetedCount: number;
    }>;
  };
};

interface PushConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onApplied?: (result: PushApiData) => void;
  items: PushItem[];
  previewItems?: PushItem[];
  autoRunDryRun?: boolean;
}

type ModalPhase =
  | "review"
  | "dry-run"
  | "ready"
  | "pushing"
  | "done"
  | "blocked"
  | "error";

function getPushItemKey(item: PushItem): string {
  return [
    item.platform,
    item.listingId,
    item.platformVariantId ?? "",
    item.field,
    String(item.newValue),
  ].join(":");
}

function formatValue(field: string, value: number | string | null): string {
  if (value == null) return "—";
  if (field === "upc") return String(value);
  if (field.toLowerCase().includes("rate")) return `${(Number(value) * 100).toFixed(1)}%`;
  return `$${Number(value).toFixed(2)}`;
}

function getChecklistClasses(status: ChecklistItem["status"]) {
  if (status === "blocked") return "border-red-500/30 bg-red-500/10 text-red-300";
  if (status === "warning") return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  if (status === "completed") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  return "border-blue-500/30 bg-blue-500/10 text-blue-300";
}

function formatDisplayValue(field: string, value: number | string | null): string {
  if (field === "upc") {
    return value == null ? "No UPC" : String(value);
  }
  return formatValue(field, value);
}

function getBanner(
  phase: ModalPhase,
  result: PushApiData | null,
  errorMessage: string | null,
  batchProgress: { current: number; total: number; succeeded: number; failed: number } | null = null,
) {
  if (phase === "dry-run") {
    return {
      icon: Loader2,
      className: "border-blue-500/30 bg-blue-500/10 text-blue-300",
      title: "Running dry run",
      detail: "Validating the push plan without writing to marketplaces.",
      spin: true,
    };
  }
  if (phase === "pushing") {
    const detail = batchProgress && batchProgress.total > 1
      ? `Batch ${batchProgress.current} of ${batchProgress.total} — ${batchProgress.succeeded} succeeded so far.`
      : "Writing to marketplaces through the guarded push chain.";
    return {
      icon: Loader2,
      className: "border-amber-500/30 bg-amber-500/10 text-amber-300",
      title: batchProgress && batchProgress.total > 1
        ? `Pushing batch ${batchProgress.current} / ${batchProgress.total}`
        : "Running live push",
      detail,
      spin: true,
    };
  }
  if (phase === "blocked") {
    return {
      icon: AlertTriangle,
      className: "border-amber-500/30 bg-amber-500/10 text-amber-300",
      title: result?.message ?? "Push blocked",
      detail: result?.blockedReason ?? result?.nextStep ?? "Resolve the blocker before retrying.",
      spin: false,
    };
  }
  if (phase === "error") {
    return {
      icon: XCircle,
      className: "border-red-500/30 bg-red-500/10 text-red-300",
      title: "Push request failed",
      detail: errorMessage ?? "The push request could not be completed.",
      spin: false,
    };
  }
  if (phase === "done" && result) {
    const hasBatchInfo = batchProgress && batchProgress.total > 1;
    const batchTitle = hasBatchInfo
      ? `Push completed — ${batchProgress.succeeded.toLocaleString()} succeeded${batchProgress.failed > 0 ? `, ${batchProgress.failed.toLocaleString()} failed` : ""} across ${batchProgress.total} batches`
      : result.message;
    return {
      icon: batchProgress?.failed ? AlertTriangle : result.status === "partial" ? AlertTriangle : CheckCircle2,
      className:
        (batchProgress?.failed ?? 0) > 0 || result.status === "partial"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
      title: batchTitle,
      detail: hasBatchInfo && batchProgress.failed > 0
        ? "Some batches failed. You can retry the failed changes."
        : result.nextStep,
      spin: false,
    };
  }
  if (phase === "ready" && result) {
    return {
      icon: Shield,
      className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
      title: "Dry run completed",
      detail: result.nextStep,
      spin: false,
    };
  }
  return {
    icon: Send,
    className: "border-border bg-muted/30 text-foreground",
    title: "Review live push",
    detail: "Run the dry run first, then confirm the live push only if the checklist looks clean.",
    spin: false,
  };
}

export function PushConfirmModal({
  open,
  onClose,
  onApplied,
  items,
  previewItems,
  autoRunDryRun = false,
}: PushConfirmModalProps) {
  const [phase, setPhase] = useState<ModalPhase>("review");
  const [result, setResult] = useState<PushApiData | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeItems, setActiveItems] = useState<PushItem[]>(items);
  const [selectedItemKeys, setSelectedItemKeys] = useState<Set<string>>(new Set(items.map(getPushItemKey)));
  const [autoDryRunStarted, setAutoDryRunStarted] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    current: number;
    total: number;
    succeeded: number;
    failed: number;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase("review");
    setResult(null);
    setErrorMessage(null);
    setActiveItems(items);
    setSelectedItemKeys(new Set(items.map(getPushItemKey)));
    setAutoDryRunStarted(false);
    setBatchProgress(null);
  }, [open, items]);

  const reviewItems = previewItems?.length ? previewItems : activeItems;
  const activeItemKeySet = useMemo(
    () => new Set(activeItems.map(getPushItemKey)),
    [activeItems],
  );
  const selectedActiveItems = useMemo(
    () => activeItems.filter((item) => selectedItemKeys.has(getPushItemKey(item))),
    [activeItems, selectedItemKeys],
  );
  const selectedListingCount = useMemo(
    () => new Set(selectedActiveItems.map((item) => `${item.platform}:${item.listingId}`)).size,
    [selectedActiveItems],
  );

  const groupedByListing = useMemo(() => {
    return reviewItems.reduce<Record<string, PushItem[]>>((acc, item) => {
      const key = `${item.platform}:${item.listingId}`;
      if (!acc[key]) acc[key] = [];
      acc[key].push(item);
      return acc;
    }, {});
  }, [reviewItems]);
  const previewSummaryByPlatform = useMemo(() => {
    const summary = new Map<
      Platform,
      { platform: Platform; changes: number; listingIds: Set<string>; fields: Set<"salePrice" | "adRate" | "upc"> }
    >();

    for (const item of reviewItems) {
      const existing = summary.get(item.platform) ?? {
        platform: item.platform,
        changes: 0,
        listingIds: new Set<string>(),
        fields: new Set<"salePrice" | "adRate" | "upc">(),
      };
      existing.changes += 1;
      existing.listingIds.add(item.listingId);
      existing.fields.add(item.field);
      summary.set(item.platform, existing);
    }

    return [...summary.values()].map((entry) => ({
      platform: entry.platform,
      changes: entry.changes,
      distinctListings: entry.listingIds.size,
      fields: [...entry.fields],
    }));
  }, [reviewItems]);
  const showingPreviewPlan = Boolean(previewItems?.length);
  const plannedListingCount = Object.keys(groupedByListing).length;
  const plannedChangeCount = reviewItems.length;
  const impactByStoreEntries = showingPreviewPlan ? previewSummaryByPlatform : (result?.summary.byPlatform ?? []);

  const failedResults = result?.results.filter((entry) => !entry.success) ?? [];
  const retryFailedItems = useMemo(() => {
    if (!result || failedResults.length === 0) return [];
    const failedKeys = new Set(
      failedResults.map((entry) => `${entry.platform}:${entry.listingId}:${entry.field}`),
    );
    return activeItems.filter((item) =>
      failedKeys.has(`${item.platform}:${item.listingId}:${item.field}`),
    );
  }, [activeItems, failedResults, result]);
  const canClose = phase !== "dry-run" && phase !== "pushing";
  const banner = getBanner(phase, result, errorMessage, batchProgress);
  const BannerIcon = banner.icon;
  const canConfirmLive =
    phase === "ready" &&
    result != null &&
    result.status !== "blocked" &&
    result.goLiveChecklist?.every((item) => item.status !== "blocked") !== false;

  function setAllSelections(nextChecked: boolean) {
    setSelectedItemKeys(nextChecked ? new Set(activeItems.map(getPushItemKey)) : new Set());
  }

  function toggleItemSelection(item: PushItem, checked: boolean) {
    const key = getPushItemKey(item);
    setSelectedItemKeys((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }

  const LIVE_PUSH_BATCH_SIZE = 80;

  async function sendPushBatch(changes: PushItem[], dryRun: boolean) {
    const response = await fetch("/api/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        changes,
        dryRun,
        confirmedLivePush: !dryRun,
      }),
    });

    const payload = await response.json().catch(() => null) as { data?: PushApiData; error?: string } | null;
    if (!payload) {
      throw new Error(
        `Server returned ${response.status} — the push function may have timed out or crashed. Check Engine Room for the push job status before retrying.`,
      );
    }
    if (!response.ok && !payload.data) {
      throw new Error(payload.error ?? "Push request failed.");
    }

    const data = payload.data;
    if (!data) {
      throw new Error("Push route returned no data.");
    }
    return data;
  }

  async function runRequest(dryRun: boolean) {
    if (selectedActiveItems.length === 0) {
      setErrorMessage("Select at least one staged change before running the push.");
      setPhase("error");
      return;
    }

    setErrorMessage(null);
    setBatchProgress(null);

    if (dryRun) {
      setPhase("dry-run");
      try {
        const data = await sendPushBatch(selectedActiveItems, true);
        setResult(data);
        if (data.status === "blocked") {
          setPhase("blocked");
          return;
        }
        setPhase("ready");
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Push request failed.");
        setPhase("error");
      }
      return;
    }

    setPhase("pushing");
    const needsBatching = selectedActiveItems.length > LIVE_PUSH_BATCH_SIZE;
    if (!needsBatching) {
      try {
        const data = await sendPushBatch(selectedActiveItems, false);
        setResult(data);
        if (data.status === "blocked") {
          setPhase("blocked");
          return;
        }
        setPhase("done");
        onApplied?.(data);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Push request failed.");
        setPhase("error");
      }
      return;
    }

    const batches: PushItem[][] = [];
    for (let i = 0; i < selectedActiveItems.length; i += LIVE_PUSH_BATCH_SIZE) {
      batches.push(selectedActiveItems.slice(i, i + LIVE_PUSH_BATCH_SIZE));
    }

    let totalSucceeded = 0;
    let totalFailed = 0;
    const allFailedItems: PushItem[] = [];
    let lastData: PushApiData | null = null;

    for (let b = 0; b < batches.length; b++) {
      setBatchProgress({
        current: b + 1,
        total: batches.length,
        succeeded: totalSucceeded,
        failed: totalFailed,
      });

      try {
        const data = await sendPushBatch(batches[b], false);
        lastData = data;

        const batchSucceeded = data.results?.filter((r: { success: boolean }) => r.success).length ?? 0;
        const batchFailed = data.results?.filter((r: { success: boolean }) => !r.success).length ?? 0;
        totalSucceeded += batchSucceeded;
        totalFailed += batchFailed;

        if (batchFailed > 0 && data.results) {
          const failedKeys = new Set(
            data.results
              .filter((r: { success: boolean }) => !r.success)
              .map((r: { platform: string; listingId: string; field: string }) =>
                `${r.platform}:${r.listingId}:${r.field}`),
          );
          for (const item of batches[b]) {
            if (failedKeys.has(`${item.platform}:${item.listingId}:${item.field}`)) {
              allFailedItems.push(item);
            }
          }
        }

        if (data.status === "blocked") {
          setErrorMessage(`Batch ${b + 1} was blocked: ${(data as { blockedReason?: string }).blockedReason ?? "safety rule"}`);
          for (let remaining = b + 1; remaining < batches.length; remaining++) {
            allFailedItems.push(...batches[remaining]);
            totalFailed += batches[remaining].length;
          }
          break;
        }
      } catch (error) {
        totalFailed += batches[b].length;
        allFailedItems.push(...batches[b]);
        setErrorMessage(
          `Batch ${b + 1}/${batches.length} failed: ${error instanceof Error ? error.message : "Unknown error"}. ` +
          `${totalSucceeded} changes succeeded before the failure.`,
        );
        for (let remaining = b + 1; remaining < batches.length; remaining++) {
          allFailedItems.push(...batches[remaining]);
          totalFailed += batches[remaining].length;
        }
        break;
      }
    }

    setBatchProgress({
      current: batches.length,
      total: batches.length,
      succeeded: totalSucceeded,
      failed: totalFailed,
    });

    if (lastData) {
      setResult({
        ...lastData,
        summary: {
          ...(lastData.summary ?? {}),
          totalChanges: totalSucceeded + totalFailed,
          distinctListings: new Set(selectedActiveItems.map((i) => `${i.platform}:${i.listingId}`)).size,
          successfulChanges: totalSucceeded,
          failedChanges: totalFailed,
        },
        results: [],
      } as unknown as PushApiData);
    }

    if (totalFailed > 0 && allFailedItems.length > 0) {
      setActiveItems(allFailedItems);
      setSelectedItemKeys(new Set(allFailedItems.map(getPushItemKey)));
    }

    if (totalSucceeded > 0) {
      onApplied?.(lastData ?? ({} as PushApiData));
    }

    setPhase(totalFailed === 0 ? "done" : totalSucceeded > 0 ? "done" : "error");
  }

  useEffect(() => {
    if (!open || !autoRunDryRun || autoDryRunStarted || phase !== "review") return;
    setAutoDryRunStarted(true);
    void runRequest(true);
  }, [autoDryRunStarted, autoRunDryRun, open, phase]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[300] bg-black/70 backdrop-blur-sm"
        onClick={canClose ? onClose : undefined}
      />
      <div className="fixed left-1/2 top-1/2 z-[301] w-[min(960px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Send className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                {autoRunDryRun ? "Fast Push Review" : "Review Push"}
              </h2>
              <p className="text-xs text-muted-foreground">
                {selectedActiveItems.length} selected change{selectedActiveItems.length === 1 ? "" : "s"} ready across {selectedListingCount} listing
                {selectedListingCount === 1 ? "" : "s"}
              </p>
            </div>
          </div>
          {canClose ? (
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          ) : null}
        </div>

        <div className="max-h-[75vh] overflow-y-auto px-6 py-5">
          <section className={cn("mb-5 rounded-xl border px-4 py-3", banner.className)}>
            <div className="flex items-start gap-3">
              <BannerIcon className={cn("mt-0.5 h-5 w-5 shrink-0", banner.spin && "animate-spin")} />
              <div className="flex-1">
                <div className="text-sm font-semibold">{banner.title}</div>
                <div className="mt-1 text-xs opacity-90">{banner.detail}</div>
                {phase === "pushing" && batchProgress && batchProgress.total > 1 && (
                  <div className="mt-2.5">
                    <div className="h-2 overflow-hidden rounded-full bg-black/20">
                      <div
                        className="h-full rounded-full bg-amber-400 transition-all duration-500"
                        style={{ width: `${Math.round((batchProgress.current / batchProgress.total) * 100)}%` }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between text-[10px] tabular-nums opacity-70">
                      <span>{batchProgress.succeeded} succeeded{batchProgress.failed > 0 ? `, ${batchProgress.failed} failed` : ""}</span>
                      <span>{Math.round((batchProgress.current / batchProgress.total) * 100)}%</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Listings</div>
              <div className="mt-1 text-2xl font-semibold text-foreground">
                {phase === "review" || phase === "ready"
                  ? selectedListingCount
                  : showingPreviewPlan
                    ? plannedListingCount
                    : (result?.summary.distinctListings ?? plannedListingCount)}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Changes</div>
              <div className="mt-1 text-2xl font-semibold text-foreground">
                {phase === "review" || phase === "ready"
                  ? selectedActiveItems.length
                  : showingPreviewPlan
                    ? plannedChangeCount
                    : (result?.summary.totalChanges ?? plannedChangeCount)}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Succeeded</div>
              <div className="mt-1 text-2xl font-semibold text-emerald-400">
                {batchProgress && batchProgress.total > 1
                  ? batchProgress.succeeded
                  : (result?.summary.successfulChanges ?? 0)}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Failed</div>
              <div className="mt-1 text-2xl font-semibold text-red-400">
                {batchProgress && batchProgress.total > 1
                  ? batchProgress.failed
                  : (result?.summary.failedChanges ?? 0)}
              </div>
            </div>
          </section>

          {result?.firstLivePush && result.operatorChecklist?.length ? (
            <section className="mb-5 rounded-xl border border-violet-500/30 bg-violet-500/10 p-4">
              <div className="text-sm font-semibold text-violet-100">First Live Push Operator Checklist</div>
              <p className="mt-1 text-xs text-violet-100/85">
                This looks like the first live marketplace push in this environment. Review this once before you confirm.
              </p>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {result.operatorChecklist.map((item) => (
                  <article key={item.label} className="rounded-lg border border-violet-400/20 bg-black/10 px-3 py-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-100">{item.label}</div>
                    <div className="mt-1 text-xs text-violet-100/85">{item.detail}</div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {result?.goLiveChecklist?.length ? (
            <section className="mb-5">
              <div className="mb-2">
                <h3 className="text-sm font-semibold text-foreground">Go-Live Checklist</h3>
                <p className="text-xs text-muted-foreground">
                  These are the checks reorG ran before allowing a live push.
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {result.goLiveChecklist.map((item) => (
                  <article key={item.key} className={cn("rounded-xl border p-4", getChecklistClasses(item.status))}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold">{item.label}</div>
                      <span className="rounded border border-current/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                        {item.status}
                      </span>
                    </div>
                    <p className="mt-2 text-xs opacity-90">{item.detail}</p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {impactByStoreEntries.length ? (
            <section className="mb-5">
              <div className="mb-2">
                <h3 className="text-sm font-semibold text-foreground">Impact By Store</h3>
                <p className="text-xs text-muted-foreground">
                  {showingPreviewPlan
                    ? "This shows the full Match UPC plan across every marketplace in the review."
                    : "Dry run and live results are grouped here so you can see the size of each store update."}
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {impactByStoreEntries.map((entry) => (
                  <article key={entry.platform} className="rounded-xl border border-border bg-background/50 p-4">
                    <div className="flex items-center gap-2">
                      <span className={cn("rounded border px-2 py-0.5 text-[10px] font-semibold uppercase", PLATFORM_COLORS[entry.platform])}>
                        {PLATFORM_SHORT[entry.platform]}
                      </span>
                      <span className="text-sm font-semibold text-foreground">{entry.platform}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Listings</div>
                        <div className="mt-1 font-semibold text-foreground">{entry.distinctListings}</div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Changes</div>
                        <div className="mt-1 font-semibold text-foreground">{entry.changes}</div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Fields</div>
                        <div className="mt-1 font-semibold text-foreground">{entry.fields.join(", ")}</div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {(result?.prePushBackup || result?.postPushRefresh || result?.batchSafety) ? (
            <section className="mb-5 grid gap-3 lg:grid-cols-3">
              {result?.batchSafety ? (
                <article className="rounded-xl border border-border bg-background/50 p-4">
                  <div className="text-sm font-semibold text-foreground">Batch Guardrails</div>
                  <p className="mt-2 text-xs text-muted-foreground">{result.batchSafety.detail}</p>
                </article>
              ) : null}
              {result?.prePushBackup ? (
                <article className="rounded-xl border border-border bg-background/50 p-4">
                  <div className="text-sm font-semibold text-foreground">Pre-Push Backup</div>
                  <p className="mt-2 text-xs text-muted-foreground">{result.prePushBackup.detail}</p>
                  {result.prePushBackup.backupId ? (
                    <p className="mt-2 text-[11px] font-mono text-muted-foreground">Backup ID: {result.prePushBackup.backupId}</p>
                  ) : null}
                </article>
              ) : null}
              {result?.postPushRefresh ? (
                <article className="rounded-xl border border-border bg-background/50 p-4">
                  <div className="text-sm font-semibold text-foreground">Post-Push Refresh</div>
                  <p className="mt-2 text-xs text-muted-foreground">{result.postPushRefresh.detail}</p>
                  {result.postPushRefresh.retryAt ? (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Retry after: {new Date(result.postPushRefresh.retryAt).toLocaleString()}
                    </p>
                  ) : null}
                </article>
              ) : null}
            </section>
          ) : null}

          {failedResults.length > 0 ? (
            <section className="mb-5">
              <div className="mb-2">
                <h3 className="text-sm font-semibold text-foreground">Failed Changes</h3>
                <p className="text-xs text-muted-foreground">
                  These stayed staged so you can review and retry them safely.
                </p>
              </div>
              <div className="space-y-2">
                {failedResults.slice(0, 12).map((entry) => (
                  <article key={`${entry.platform}:${entry.listingId}:${entry.field}`} className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className={cn("rounded border px-2 py-0.5 text-[10px] font-semibold uppercase", PLATFORM_COLORS[entry.platform])}>
                        {PLATFORM_SHORT[entry.platform]}
                      </span>
                      <span className="font-mono text-muted-foreground">{entry.listingId}</span>
                      <span className="text-muted-foreground">{entry.field}</span>
                    </div>
                    <div className="mt-2 text-sm text-foreground">
                      {formatDisplayValue(entry.field, entry.oldValue)} → {formatDisplayValue(entry.field, entry.newValue)}
                    </div>
                    <div className="mt-1 text-xs text-red-300">{entry.error ?? "Unknown push error."}</div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          <section>
            <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
              <div>
              <h3 className="text-sm font-semibold text-foreground">Changes In This Push</h3>
              <p className="text-xs text-muted-foreground">
                Review the exact listings and fields before confirming any live write.
              </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAllSelections(true)}
                  disabled={activeItems.length === 0}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                  Select All
                </button>
                <button
                  type="button"
                  onClick={() => setAllSelections(false)}
                  disabled={selectedActiveItems.length === 0}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                  Clear All
                </button>
              </div>
            </div>
            <div className="space-y-3">
              {Object.entries(groupedByListing).map(([key, listingItems]) => {
                const first = listingItems[0];
                return (
                  <article key={key} className="rounded-xl border border-border bg-background/50 p-4">
                    <div className="flex items-center gap-2">
                      <span className={cn("rounded border px-2 py-0.5 text-[10px] font-semibold uppercase", PLATFORM_COLORS[first.platform])}>
                        {PLATFORM_SHORT[first.platform]}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">{first.listingId}</span>
                      <span className="truncate text-sm font-medium text-foreground">{first.sku}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{first.title}</p>
                    <div className="mt-3 space-y-2">
                      {listingItems.map((item) => {
                        const itemKey = getPushItemKey(item);
                        const isSelectable = activeItemKeySet.has(itemKey);
                        const isSelected = selectedItemKeys.has(itemKey);
                        return (
                          <label
                            key={`${item.platform}:${item.listingId}:${item.field}:${item.newValue}`}
                            className={cn(
                              "flex items-center gap-3 rounded-lg border px-3 py-2 text-sm",
                              isSelectable
                                ? "border-border bg-background/40"
                                : "border-border/50 bg-muted/20 opacity-70",
                            )}
                          >
                            {isSelectable ? (
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={(event) => toggleItemSelection(item, event.target.checked)}
                                className="h-4 w-4 cursor-pointer rounded border-border bg-background text-primary focus:ring-primary"
                              />
                            ) : (
                              <span className="inline-flex min-w-[72px] items-center rounded border border-border/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Preview only
                              </span>
                            )}
                            <span className="w-20 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
                              {item.field}
                            </span>
                            <span className="text-muted-foreground line-through">
                              {formatDisplayValue(item.field, item.oldValue)}
                            </span>
                            <RefreshCw className="h-3.5 w-3.5 text-muted-foreground/60" />
                            <span className="font-semibold text-foreground">
                              {formatDisplayValue(item.field, item.newValue)}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
          <div className="text-xs text-muted-foreground">
            {phase === "review"
              ? "Select the staged changes you want, run the dry run, then confirm the live push only for those selected items."
              : result?.nextStep ?? "Review the result and next step before closing."}
          </div>
          <div className="flex items-center gap-2">
            {phase === "review" ? (
              <>
                <button
                  onClick={onClose}
                  className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void runRequest(true)}
                  disabled={selectedActiveItems.length === 0}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer"
                >
                  {autoRunDryRun ? "Checking Push" : "Run Dry Run"}
                </button>
              </>
            ) : null}

            {phase === "ready" ? (
              <>
                <button
                  onClick={onClose}
                  className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
                >
                  Close
                </button>
                <button
                  onClick={() => void runRequest(false)}
                  disabled={!canConfirmLive || selectedActiveItems.length === 0}
                  className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                  {autoRunDryRun ? "Push Now" : "Confirm Live Push"}
                </button>
              </>
            ) : null}

            {(phase === "done" || phase === "blocked" || phase === "error") ? (
              <>
                {retryFailedItems.length > 0 ? (
                  <button
                    onClick={() => {
                      setActiveItems(retryFailedItems);
                      setSelectedItemKeys(new Set(retryFailedItems.map(getPushItemKey)));
                      setResult(null);
                      setErrorMessage(null);
                      setPhase("review");
                    }}
                    className="rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-accent cursor-pointer"
                  >
                    Retry Failed Only
                  </button>
                ) : null}
                <button
                  onClick={onClose}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer"
                >
                  Close
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
