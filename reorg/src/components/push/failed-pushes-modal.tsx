"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Filter,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PLATFORM_SHORT, type Platform } from "@/lib/grid-types";
import type { PushItem } from "./push-confirm-modal";

type FailedPushItem = PushItem & {
  retryKey: string;
  pushJobId: string;
  failedAt: string;
  platformLabel: string;
  fieldLabel: string;
  oldDisplay: string;
  newDisplay: string;
  error: string;
  failureCategory: string;
  failureSummary: string;
  recommendedAction: string;
  isFormatInvalid?: boolean;
};

interface FailedPushesModalProps {
  failedPushes: FailedPushItem[];
  failedPushesLoading: boolean;
  failedPushCount: number;
  categorySet: Map<string, number>;
  platformSet: Map<string, number>;
  fieldSet: Map<string, number>;
  reasonSet: Map<string, number>;
  categoryLabels: Record<string, string>;
  fieldLabels: Record<string, string>;
  onClose: () => void;
  onRetryAll: (items: PushItem[]) => void;
  onRetryOne: (item: PushItem) => void;
  onSaveLocalBatch: (items: FailedPushItem[]) => void;
  onDismiss: (items: FailedPushItem[]) => void;
}

function stripExtraFields(failure: FailedPushItem): PushItem {
  const {
    retryKey: _a,
    pushJobId: _b,
    failedAt: _c,
    platformLabel: _d,
    fieldLabel: _e,
    oldDisplay: _f,
    newDisplay: _g,
    error: _h,
    failureCategory: _i,
    failureSummary: _j,
    recommendedAction: _k,
    ...item
  } = failure;
  return item;
}

export function FailedPushesModal({
  failedPushes,
  failedPushesLoading,
  failedPushCount,
  categorySet,
  platformSet,
  fieldSet,
  reasonSet,
  categoryLabels,
  fieldLabels,
  onClose,
  onRetryAll,
  onRetryOne,
  onSaveLocalBatch,
  onDismiss,
}: FailedPushesModalProps) {
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [filterPlatform, setFilterPlatform] = useState<string | null>(null);
  const [filterField, setFilterField] = useState<string | null>(null);
  const [filterReason, setFilterReason] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    let items = failedPushes;
    if (filterCategory) items = items.filter((f) => f.failureCategory === filterCategory);
    if (filterPlatform) items = items.filter((f) => f.platform === filterPlatform);
    if (filterField) items = items.filter((f) => f.field === filterField);
    if (filterReason) items = items.filter((f) => f.failureSummary === filterReason);
    return items;
  }, [failedPushes, filterCategory, filterPlatform, filterField, filterReason]);

  const hasActiveFilter = filterCategory || filterPlatform || filterField || filterReason;

  const validationUpcItems = useMemo(
    () => filtered.filter((f) => f.field === "upc"),
    [filtered],
  );
  const formatInvalidUpcItems = useMemo(
    () => filtered.filter((f) => f.field === "upc" && f.isFormatInvalid),
    [filtered],
  );

  function toggleSelect(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelectedKeys(new Set(filtered.map((f) => f.retryKey)));
  }

  function clearSelection() {
    setSelectedKeys(new Set());
  }

  const selectedItems = useMemo(
    () => filtered.filter((f) => selectedKeys.has(f.retryKey)),
    [filtered, selectedKeys],
  );

  const selectedUpcValidationItems = useMemo(
    () => selectedItems.filter((f) => f.field === "upc"),
    [selectedItems],
  );

  const retryableSelected = useMemo(
    () => selectedItems.filter((f) => f.failureCategory !== "validation" || f.field !== "upc"),
    [selectedItems],
  );

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex w-full max-w-5xl flex-col rounded-2xl border border-border bg-card shadow-2xl" style={{ maxHeight: "90vh" }}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-500/15 text-red-400">
              <AlertTriangle className="h-4.5 w-4.5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-foreground">Push Alerts</h3>
              <p className="text-xs text-muted-foreground">
                {failedPushCount} failed push{failedPushCount === 1 ? "" : "es"} from the last 14 days
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Category summary */}
        {!failedPushesLoading && failedPushCount > 0 && (
          <div className="border-b border-border bg-muted/10 px-5 py-3">
            <div className="flex flex-wrap gap-2">
              {[...categorySet.entries()]
                .sort(([, a], [, b]) => b - a)
                .map(([cat, count]) => (
                  <button
                    key={cat}
                    onClick={() => setFilterCategory(filterCategory === cat ? null : cat)}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left text-xs transition-all cursor-pointer min-w-[100px]",
                      filterCategory === cat
                        ? "border-primary/50 bg-primary/15 text-primary font-semibold"
                        : "border-border/60 bg-background/40 text-muted-foreground hover:border-border hover:bg-background/60",
                    )}
                  >
                    <span className="block text-[10px] uppercase tracking-wide opacity-70">
                      {categoryLabels[cat] ?? cat}
                    </span>
                    <span className="mt-0.5 block text-sm font-semibold">{count}</span>
                  </button>
                ))}
            </div>
          </div>
        )}

        {/* Filter row */}
        {!failedPushesLoading && failedPushCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-2.5">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />

            {[...platformSet.entries()].map(([plat, count]) => (
              <button
                key={plat}
                onClick={() => setFilterPlatform(filterPlatform === plat ? null : plat)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-[11px] cursor-pointer transition-colors",
                  filterPlatform === plat
                    ? "border-primary/50 bg-primary/15 text-primary font-medium"
                    : "border-border/60 text-muted-foreground hover:text-foreground",
                )}
              >
                {PLATFORM_SHORT[plat as Platform] ?? plat} ({count})
              </button>
            ))}

            <span className="mx-1 h-4 w-px bg-border/50" />

            {[...fieldSet.entries()].map(([field, count]) => (
              <button
                key={field}
                onClick={() => setFilterField(filterField === field ? null : field)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-[11px] cursor-pointer transition-colors",
                  filterField === field
                    ? "border-primary/50 bg-primary/15 text-primary font-medium"
                    : "border-border/60 text-muted-foreground hover:text-foreground",
                )}
              >
                {fieldLabels[field] ?? field} ({count})
              </button>
            ))}

            {reasonSet.size > 1 && (
              <>
                <span className="mx-1 h-4 w-px bg-border/50" />
                {[...reasonSet.entries()]
                  .sort(([, a], [, b]) => b - a)
                  .map(([reason, count]) => {
                    const label = reason.length > 40 ? reason.slice(0, 37) + "…" : reason;
                    return (
                      <button
                        key={reason}
                        onClick={() => setFilterReason(filterReason === reason ? null : reason)}
                        title={reason}
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-[11px] cursor-pointer transition-colors max-w-[220px] truncate",
                          filterReason === reason
                            ? "border-primary/50 bg-primary/15 text-primary font-medium"
                            : "border-border/60 text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {label} ({count})
                      </button>
                    );
                  })}
              </>
            )}

            {hasActiveFilter && (
              <button
                onClick={() => { setFilterCategory(null); setFilterPlatform(null); setFilterField(null); setFilterReason(null); }}
                className="ml-auto rounded-md border border-border/60 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        {/* Selection toolbar */}
        {!failedPushesLoading && filtered.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-5 py-2.5 bg-background/30">
            <input
              type="checkbox"
              checked={selectedKeys.size > 0 && selectedKeys.size >= filtered.length}
              onChange={(e) => (e.target.checked ? selectAllFiltered() : clearSelection())}
              className="h-3.5 w-3.5 cursor-pointer rounded border-border"
            />
            <span className="text-xs text-muted-foreground">
              {selectedKeys.size > 0
                ? `${selectedKeys.size} selected`
                : `${filtered.length} showing${hasActiveFilter ? ` (of ${failedPushCount})` : ""}`}
            </span>

            {selectedKeys.size > 0 && (
              <>
                {retryableSelected.length > 0 && (
                  <button
                    onClick={() => onRetryAll(retryableSelected.map(stripExtraFields))}
                    className="rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20 cursor-pointer"
                  >
                    Retry Selected ({retryableSelected.length})
                  </button>
                )}
                {selectedUpcValidationItems.length > 0 && (
                  <button
                    onClick={() => onSaveLocalBatch(selectedUpcValidationItems)}
                    className="flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/20 cursor-pointer"
                  >
                    <Save className="h-3 w-3" />
                    Save UPCs Locally ({selectedUpcValidationItems.length})
                  </button>
                )}
                <button
                  onClick={() => {
                    onDismiss(selectedItems);
                    clearSelection();
                  }}
                  className="flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/20 cursor-pointer"
                >
                  <Trash2 className="h-3 w-3" />
                  Dismiss Selected ({selectedItems.length})
                </button>
              </>
            )}

            {selectedKeys.size === 0 && formatInvalidUpcItems.length > 0 && (
              <button
                onClick={() => onSaveLocalBatch(formatInvalidUpcItems)}
                className="ml-auto flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/20 cursor-pointer"
              >
                <Save className="h-3 w-3" />
                Save Invalid-Format UPCs Locally ({formatInvalidUpcItems.length})
              </button>
            )}
            {selectedKeys.size === 0 && validationUpcItems.length > 0 && formatInvalidUpcItems.length === 0 && (
              <button
                onClick={() => onSaveLocalBatch(validationUpcItems)}
                className="ml-auto flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/20 cursor-pointer"
              >
                <Save className="h-3 w-3" />
                Save All UPCs Locally ({validationUpcItems.length})
              </button>
            )}
          </div>
        )}

        {/* Items list */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {failedPushesLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading failed pushes...</div>
          ) : failedPushCount === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">No failed pushes are waiting for retry.</div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">No pushes match the current filters.</div>
          ) : (
            <div className="space-y-2">
              {filtered.map((failure) => {
                const pushItem = stripExtraFields(failure);
                const isSelected = selectedKeys.has(failure.retryKey);
                const isUpc = failure.field === "upc";
                const isFormatInvalid = failure.isFormatInvalid === true;

                    return (
                      <article
                        key={failure.retryKey}
                        className={cn(
                          "rounded-xl border px-4 py-3 transition-colors",
                          isSelected ? "border-primary/40 bg-primary/5" : isFormatInvalid ? "border-amber-500/20 bg-amber-500/5" : "border-red-500/20 bg-red-500/5",
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(failure.retryKey)}
                            className="mt-1 h-3.5 w-3.5 cursor-pointer rounded border-border"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-300">
                                {PLATFORM_SHORT[failure.platform]}
                              </span>
                              <span className="text-sm font-semibold text-foreground">{failure.sku}</span>
                              <span className="text-xs text-muted-foreground">{failure.fieldLabel}</span>
                              <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                                {categoryLabels[failure.failureCategory] ?? failure.failureCategory.replace("-", " ")}
                              </span>
                              {isFormatInvalid && (
                                <span className="rounded bg-red-600/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-300">
                                  Invalid Format
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-sm text-foreground">
                              {failure.oldDisplay} <span className="text-muted-foreground mx-1">&rarr;</span> {failure.newDisplay}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">{failure.failureSummary}</p>
                            {!isFormatInvalid && <p className="mt-1 text-[11px] text-red-300/80 break-all">{failure.error}</p>}
                          </div>
                          <div className="flex shrink-0 flex-col gap-1.5">
                            {!isFormatInvalid && (
                              <button
                                onClick={() => onRetryOne(pushItem)}
                                className="rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer"
                              >
                                Retry
                              </button>
                            )}
                            {isUpc && (
                              <button
                                onClick={() => onSaveLocalBatch([failure])}
                                className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/20 cursor-pointer"
                              >
                                Save Local
                              </button>
                            )}
                            <button
                              onClick={() => onDismiss([failure])}
                              className="rounded-md border border-border/50 bg-background/50 px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
                            >
                              Dismiss
                            </button>
                          </div>
                        </div>
                      </article>
                    );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <p className="text-xs text-muted-foreground">
            {hasActiveFilter
              ? `Showing ${filtered.length} of ${failedPushCount} alerts`
              : `${failedPushCount} total alert${failedPushCount === 1 ? "" : "s"}`}
          </p>
          <div className="flex items-center gap-2">
            {filtered.length > 1 && selectedKeys.size === 0 && (
              <button
                onClick={() => onRetryAll(filtered.map(stripExtraFields))}
                className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/20 cursor-pointer"
              >
                Retry All{hasActiveFilter ? ` (${filtered.length})` : ""}
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-md border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
