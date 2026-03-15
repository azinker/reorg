"use client";

import { useEffect, useCallback, useState } from "react";
import { X, AlertTriangle, CheckCircle, Loader2, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { PLATFORM_SHORT, PLATFORM_COLORS, type Platform } from "@/lib/grid-types";

export interface PushItem {
  sku: string;
  title: string;
  platform: Platform;
  listingId: string;
  field: string;
  oldValue: string | number | null;
  newValue: string | number;
}

interface PushConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  items: PushItem[];
  dryRunMode: boolean;
}

type PushPhase = "review" | "dry-run" | "confirmed" | "pushing" | "done";

export function PushConfirmModal({
  open,
  onClose,
  onConfirm,
  items,
  dryRunMode,
}: PushConfirmModalProps) {
  const [phase, setPhase] = useState<PushPhase>("review");

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "pushing") onClose();
    },
    [onClose, phase]
  );

  useEffect(() => {
    if (open) {
      setPhase("review");
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [open, handleKeyDown]);

  if (!open) return null;

  function handleProceed() {
    if (dryRunMode && phase === "review") {
      setPhase("dry-run");
      setTimeout(() => setPhase("confirmed"), 1500);
    } else if (phase === "confirmed" || (!dryRunMode && phase === "review")) {
      setPhase("pushing");
      setTimeout(() => {
        setPhase("done");
        onConfirm();
      }, 2000);
    }
  }

  const groupedByStore = items.reduce<Record<string, PushItem[]>>((acc, item) => {
    const key = `${item.platform}-${item.listingId}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={phase !== "pushing" ? onClose : undefined}
      />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <Send className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                {phase === "done" ? "Push Complete" : "Confirm Push"}
              </h2>
              <p className="text-xs text-muted-foreground">
                {items.length} change{items.length !== 1 ? "s" : ""} across{" "}
                {Object.keys(groupedByStore).length} listing{Object.keys(groupedByStore).length !== 1 ? "s" : ""}
              </p>
            </div>
          </div>
          {phase !== "pushing" && (
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Phase Indicators */}
        {dryRunMode && (
          <div className="border-b border-border px-6 py-2">
            <div className="flex items-center gap-4 text-xs">
              <span className={cn("flex items-center gap-1", phase === "review" ? "text-primary font-medium" : "text-muted-foreground")}>
                1. Review
              </span>
              <span className="text-muted-foreground/30">→</span>
              <span className={cn("flex items-center gap-1", phase === "dry-run" ? "text-primary font-medium" : "text-muted-foreground")}>
                2. Dry Run
              </span>
              <span className="text-muted-foreground/30">→</span>
              <span className={cn("flex items-center gap-1", phase === "confirmed" || phase === "pushing" || phase === "done" ? "text-primary font-medium" : "text-muted-foreground")}>
                3. Push
              </span>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="max-h-[50vh] overflow-y-auto p-6">
          {phase === "dry-run" && (
            <div className="mb-4 flex items-center gap-3 rounded-lg bg-primary/10 p-4">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <div>
                <p className="text-sm font-medium text-foreground">Running dry run...</p>
                <p className="text-xs text-muted-foreground">Validating changes without pushing to marketplaces.</p>
              </div>
            </div>
          )}

          {phase === "confirmed" && (
            <div className="mb-4 flex items-center gap-3 rounded-lg bg-emerald-500/10 p-4">
              <CheckCircle className="h-5 w-5 text-emerald-500" />
              <div>
                <p className="text-sm font-medium text-foreground">Dry run passed</p>
                <p className="text-xs text-muted-foreground">All changes validated successfully. Ready to push live.</p>
              </div>
            </div>
          )}

          {phase === "pushing" && (
            <div className="mb-4 flex items-center gap-3 rounded-lg bg-amber-500/10 p-4">
              <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
              <div>
                <p className="text-sm font-medium text-foreground">Pushing changes...</p>
                <p className="text-xs text-muted-foreground">Writing to marketplaces. Do not close this window.</p>
              </div>
            </div>
          )}

          {phase === "done" && (
            <div className="mb-4 flex items-center gap-3 rounded-lg bg-emerald-500/10 p-4">
              <CheckCircle className="h-5 w-5 text-emerald-500" />
              <div>
                <p className="text-sm font-medium text-foreground">All changes pushed successfully</p>
                <p className="text-xs text-muted-foreground">Live values have been updated. A sync will refresh the data shortly.</p>
              </div>
            </div>
          )}

          {/* Change List */}
          <div className="space-y-3">
            {Object.entries(groupedByStore).map(([key, storeItems]) => {
              const first = storeItems[0];
              return (
                <div key={key} className="rounded-lg border border-border bg-background p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                        PLATFORM_COLORS[first.platform]
                      )}
                    >
                      {PLATFORM_SHORT[first.platform]}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {first.listingId}
                    </span>
                    <span className="text-xs text-muted-foreground">—</span>
                    <span className="truncate text-xs text-foreground">{first.sku}</span>
                  </div>
                  {storeItems.map((item, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 py-1.5 text-sm"
                    >
                      <span className="w-24 shrink-0 text-xs text-muted-foreground">
                        {item.field}
                      </span>
                      <span className="text-muted-foreground line-through">
                        {item.oldValue != null ? fmtVal(item.field, item.oldValue) : "—"}
                      </span>
                      <span className="text-muted-foreground/40">→</span>
                      <span className="font-medium text-foreground">
                        {fmtVal(item.field, item.newValue)}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border px-6 py-4">
          {phase === "done" ? (
            <button
              onClick={onClose}
              className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer"
            >
              Done
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={handleProceed}
                disabled={phase === "pushing" || phase === "dry-run"}
                className={cn(
                  "flex-1 rounded-md px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
                  phase === "confirmed"
                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                    : "bg-primary text-primary-foreground hover:bg-primary/90"
                )}
              >
                {phase === "review" && dryRunMode && "Run Dry Run"}
                {phase === "review" && !dryRunMode && "Push Now"}
                {phase === "confirmed" && "Push Live"}
                {phase === "dry-run" && "Validating..."}
                {phase === "pushing" && "Pushing..."}
              </button>

              {phase !== "pushing" && (
                <button
                  onClick={onClose}
                  className="rounded-md border border-border px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
                >
                  Cancel
                </button>
              )}
            </div>
          )}

          {phase === "review" && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-500">
              <AlertTriangle className="h-3 w-3" />
              This will modify live marketplace listings. Changes cannot be undone automatically.
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function fmtVal(field: string, val: string | number | null): string {
  if (val == null) return "—";
  if (typeof val === "number") {
    if (field.toLowerCase().includes("rate")) return `${(val * 100).toFixed(1)}%`;
    return `$${val.toFixed(2)}`;
  }
  return String(val);
}
