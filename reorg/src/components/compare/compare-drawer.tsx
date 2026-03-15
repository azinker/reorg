"use client";

import { useEffect, useCallback } from "react";
import { X, ArrowRight, Clock, User, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { PLATFORM_SHORT, PLATFORM_COLORS, type StoreValue, type Platform } from "@/lib/grid-types";

export interface CompareItem {
  field: string;
  platform: Platform;
  listingId: string;
  stagedValue: string | number;
  liveValue: string | number | null;
  lastSyncedAt?: string;
  changedBy?: string;
  changedAt?: string;
}

interface CompareDrawerProps {
  open: boolean;
  onClose: () => void;
  sku: string;
  title: string;
  items: CompareItem[];
}

export function CompareDrawer({ open, onClose, sku, title, items }: CompareDrawerProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (open) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="fixed bottom-0 right-0 top-0 z-50 flex w-full max-w-lg flex-col border-l border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              Compare Staged vs Live
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <span className="font-mono">{sku}</span> — {title}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {items.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              No staged changes for this row.
            </div>
          ) : (
            <div className="space-y-4">
              {items.map((item, i) => (
                <div
                  key={`${item.field}-${item.platform}-${item.listingId}-${i}`}
                  className="rounded-lg border border-border bg-background p-4"
                >
                  {/* Field & Store */}
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-sm font-semibold text-foreground">
                      {item.field}
                    </span>
                    <span
                      className={cn(
                        "rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase",
                        PLATFORM_COLORS[item.platform]
                      )}
                    >
                      {PLATFORM_SHORT[item.platform]}
                    </span>
                  </div>

                  {/* Comparison */}
                  <div className="flex items-center gap-3">
                    {/* Live Value */}
                    <div className="flex-1 rounded-md bg-muted/50 p-3">
                      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                        Live
                      </span>
                      <span className="mt-1 block text-lg font-medium text-muted-foreground">
                        {item.liveValue != null ? formatValue(item.field, item.liveValue) : "—"}
                      </span>
                    </div>

                    <ArrowRight className="h-4 w-4 shrink-0 text-[var(--staged)]" />

                    {/* Staged Value */}
                    <div className="flex-1 rounded-md border border-[var(--staged)]/30 bg-[var(--staged)]/10 p-3">
                      <span className="block text-[10px] uppercase tracking-wider text-[var(--staged)]">
                        Staged
                      </span>
                      <span className="mt-1 block text-lg font-semibold text-foreground">
                        {formatValue(item.field, item.stagedValue)}
                      </span>
                    </div>
                  </div>

                  {/* Metadata */}
                  <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1 font-mono">
                      <ExternalLink className="h-3 w-3" />
                      {item.listingId}
                    </span>
                    {item.lastSyncedAt && (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Synced: {item.lastSyncedAt}
                      </span>
                    )}
                    {item.changedBy && (
                      <span className="inline-flex items-center gap-1">
                        <User className="h-3 w-3" />
                        {item.changedBy}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="border-t border-border px-6 py-4">
          <div className="flex gap-2">
            <button
              className="flex-1 rounded-md bg-[var(--staged)] px-4 py-2.5 text-sm font-medium text-[var(--staged-foreground)] transition-colors hover:bg-[var(--staged)]/90 cursor-pointer"
            >
              Confirm & Push
            </button>
            <button
              className="rounded-md border border-border px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent cursor-pointer"
            >
              Keep Staged
            </button>
            <button
              onClick={onClose}
              className="rounded-md px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function formatValue(field: string, val: string | number): string {
  if (typeof val === "number") {
    if (field.toLowerCase().includes("rate")) return `${(val * 100).toFixed(1)}%`;
    return `$${val.toFixed(2)}`;
  }
  return String(val);
}
