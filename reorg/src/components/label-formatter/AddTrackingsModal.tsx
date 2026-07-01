"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, PackageCheck, Truck, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LabelFormatterSourceStore } from "@/lib/label-formatter/types";

export type AddTrackingsRow = {
  id: string;
  orderNumber: string;
  sourceStore: LabelFormatterSourceStore;
  sourceStoreLabel: string;
  buyerName: string;
  trackingNumber: string | null;
  status: string;
};

type StoreKey = "TPP_EBAY" | "TT_EBAY";

type PlanRow = {
  sourceRow: number;
  reshipRowId?: string | null;
  orderId: string;
  trackingNumber: string;
  status: "ready" | "blocked";
  store: StoreKey | null;
  blockers: string[];
};

type PlanResponse = {
  data?: {
    summary: {
      inputRows: number;
      readyCount: number;
      blockedCount: number;
      storeCounts: Record<StoreKey, number>;
    };
    plan: PlanRow[];
    confirmationToken?: string;
  };
  error?: string;
};

type ResultRow = {
  sourceRow: number;
  reshipRowId?: string | null;
  orderId: string;
  trackingNumber: string;
  store: StoreKey | null;
  success: boolean;
  verificationStatus?: "verified" | "unverified";
  error?: string;
};

type ExecuteResponse = {
  data?: {
    generatedAt: string;
    attemptedCount: number;
    successCount: number;
    failureCount: number;
    verifiedCount: number;
    unverifiedCount: number;
    storeCounts: Record<StoreKey, number>;
    results: ResultRow[];
  };
  error?: string;
};

function storeLabel(store: StoreKey | null) {
  if (store === "TPP_EBAY") return "eBay TPP";
  if (store === "TT_EBAY") return "eBay TT";
  return "Unknown";
}

function selectionPayload(rows: AddTrackingsRow[]) {
  return rows.map((row) => ({
    reshipRowId: row.id,
    orderNumber: row.orderNumber,
    sourceStore: row.sourceStore,
    trackingNumber: row.trackingNumber,
  }));
}

export function AddTrackingsModal({
  rows,
  onClose,
}: {
  rows: AddTrackingsRow[];
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<PlanResponse["data"] | null>(null);
  const [result, setResult] = useState<ExecuteResponse["data"] | null>(null);
  const [confirmationToken, setConfirmationToken] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payloadRows = useMemo(() => selectionPayload(rows), [rows]);

  useEffect(() => {
    let cancelled = false;

    async function loadPreview() {
      setLoadingPreview(true);
      setError(null);
      try {
        const res = await fetch("/api/label-formatter/add-trackings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "preview", rows: payloadRows }),
        });
        const json = (await res.json()) as PlanResponse;
        if (!res.ok || !json.data) throw new Error(json.error ?? "Preview failed.");
        if (cancelled) return;
        setPreview(json.data);
        setConfirmationToken(json.data.confirmationToken ?? null);
      } catch (previewError) {
        if (cancelled) return;
        setError(previewError instanceof Error ? previewError.message : "Preview failed.");
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    }

    void loadPreview();

    return () => {
      cancelled = true;
    };
  }, [payloadRows]);

  async function execute() {
    if (!confirmationToken || executing) return;
    setExecuting(true);
    setError(null);
    try {
      const res = await fetch("/api/label-formatter/add-trackings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "execute",
          rows: payloadRows,
          confirmationToken,
        }),
      });
      const json = (await res.json()) as ExecuteResponse;
      if (!res.ok || !json.data) throw new Error(json.error ?? "Add tracking failed.");
      setResult(json.data);
    } catch (executeError) {
      setError(executeError instanceof Error ? executeError.message : "Add tracking failed.");
    } finally {
      setExecuting(false);
    }
  }

  const blocked = preview?.summary.blockedCount ?? 0;
  const ready = preview?.summary.readyCount ?? 0;
  const canExecute = Boolean(confirmationToken && preview && blocked === 0 && !result);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Truck className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Add Trackings to Orders</h2>
            <span className="text-xs text-muted-foreground">({rows.length} selected)</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={executing}
            className="cursor-pointer rounded p-1 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {error ? (
            <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-100">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {loadingPreview ? (
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking selected rows
            </div>
          ) : null}

          {preview && !result ? (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                <Metric label="Ready" value={ready} tone={blocked === 0 ? "success" : "default"} />
                <Metric label="Blocked" value={blocked} tone={blocked > 0 ? "danger" : "default"} />
                <Metric label="eBay TPP" value={preview.summary.storeCounts.TPP_EBAY} />
                <Metric label="eBay TT" value={preview.summary.storeCounts.TT_EBAY} />
              </div>

              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="border-b border-border bg-muted/30 uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Order Number</th>
                      <th className="px-3 py-2">Store</th>
                      <th className="px-3 py-2">Tracking Added</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {preview.plan.map((row) => (
                      <tr key={`${row.reshipRowId ?? row.sourceRow}-${row.orderId}`}>
                        <td className="px-3 py-2 font-mono">{row.orderId}</td>
                        <td className="px-3 py-2">{storeLabel(row.store)}</td>
                        <td className="px-3 py-2 font-mono">{row.trackingNumber || "-"}</td>
                        <td className="px-3 py-2">
                          {row.status === "ready" ? (
                            <span className="text-emerald-400">Ready</span>
                          ) : (
                            <span className="text-amber-300">{row.blockers.join("; ")}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {result ? (
            <>
              <div className="grid gap-3 sm:grid-cols-5">
                <Metric label="Attempted" value={result.attemptedCount} />
                <Metric label="Successful" value={result.successCount} tone="success" />
                <Metric label="Failed" value={result.failureCount} tone={result.failureCount > 0 ? "danger" : "default"} />
                <Metric label="Verified" value={result.verifiedCount} />
                <Metric label="Unverified" value={result.unverifiedCount} tone={result.unverifiedCount > 0 ? "warning" : "default"} />
              </div>

              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full min-w-[820px] text-left text-xs">
                  <thead className="border-b border-border bg-muted/30 uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Order Number</th>
                      <th className="px-3 py-2">Store</th>
                      <th className="px-3 py-2">Tracking Added</th>
                      <th className="px-3 py-2">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {result.results.map((row) => (
                      <tr key={`${row.reshipRowId ?? row.sourceRow}-${row.orderId}`}>
                        <td className="px-3 py-2 font-mono">{row.orderId}</td>
                        <td className="px-3 py-2">{storeLabel(row.store)}</td>
                        <td className="px-3 py-2 font-mono">{row.trackingNumber}</td>
                        <td className="px-3 py-2">
                          {row.success ? (
                            <span className={cn(row.verificationStatus === "verified" ? "text-emerald-400" : "text-amber-300")}>
                              {row.verificationStatus === "verified" ? "Verified" : "Unverified"}
                            </span>
                          ) : (
                            <span className="text-red-300">{row.error ?? "Failed"}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          {!result ? (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={executing}
                className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void execute()}
                disabled={!canExecute || executing}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {executing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}
                Add {ready} Tracking{ready === 1 ? "" : "s"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
            >
              <Check className="h-3.5 w-3.5" />
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
      <div className="text-[11px] uppercase text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 font-mono text-lg font-semibold",
          tone === "success" && "text-emerald-400",
          tone === "warning" && "text-amber-300",
          tone === "danger" && "text-red-300",
        )}
      >
        {value}
      </div>
    </div>
  );
}
