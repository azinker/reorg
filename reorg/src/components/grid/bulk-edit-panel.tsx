"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { X, Check, ArrowRight, Zap, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type Platform,
  PLATFORM_SHORT,
  PLATFORM_COLORS,
  type GridRow,
} from "@/lib/grid-types";
import { PlatformIcon } from "@/components/grid/platform-icon";

export type NumericBulkEditField =
  | "salePrice"
  | "adRate"
  | "weight"
  | "supplierCost"
  | "supplierShipping";

export type BulkEditField = NumericBulkEditField | "printBinLabels";

const FIELD_OPTIONS: { value: BulkEditField; label: string; storeSpecific: boolean }[] = [
  { value: "salePrice", label: "Sale Price", storeSpecific: true },
  { value: "adRate", label: "Ad Rate", storeSpecific: true },
  { value: "weight", label: "Weight", storeSpecific: false },
  { value: "supplierCost", label: "Supplier Cost", storeSpecific: false },
  { value: "supplierShipping", label: "Supplier Shipping", storeSpecific: false },
  { value: "printBinLabels", label: "Print Bin Labels", storeSpecific: false },
];

const ALL_PLATFORMS: Platform[] = ["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"];

interface BulkEditPanelProps {
  selectedRowIds: Set<string>;
  findRow: (id: string) => GridRow | undefined;
  onClose: () => void;
  onApply: (params: BulkEditApplyParams) => void;
  onPrintBinLabels?: (rowIds: string[]) => Promise<void>;
}

export interface BulkEditApplyParams {
  field: NumericBulkEditField;
  platform: Platform | null;
  value: number;
  mode: "stage" | "push" | "fastPush";
  rowIds: string[];
}

export function BulkEditPanel({
  selectedRowIds,
  findRow,
  onClose,
  onApply,
  onPrintBinLabels,
}: BulkEditPanelProps) {
  const [field, setField] = useState<BulkEditField | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [rawValue, setRawValue] = useState("");
  const [printLoading, setPrintLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedField = FIELD_OPTIONS.find((f) => f.value === field);
  const isStoreSpecific = selectedField?.storeSpecific ?? false;

  const printEligibleRowIds = useMemo(() => {
    const out: string[] = [];
    for (const id of selectedRowIds) {
      const row = findRow(id);
      if (row && !row.isParent) out.push(id);
    }
    return out;
  }, [selectedRowIds, findRow]);

  const availablePlatforms = (() => {
    if (!isStoreSpecific) return [];
    const platformSet = new Set<Platform>();
    for (const rowId of selectedRowIds) {
      const row = findRow(rowId);
      if (!row) continue;
      const storeValues = field === "adRate" ? row.adRates : row.salePrices;
      for (const sv of storeValues) {
        platformSet.add(sv.platform as Platform);
      }
    }
    return ALL_PLATFORMS.filter((p) => platformSet.has(p));
  })();

  useEffect(() => {
    if (field && field !== "printBinLabels" && (!isStoreSpecific || platform) && inputRef.current) {
      inputRef.current.focus();
    }
  }, [field, platform, isStoreSpecific]);

  const handleFieldSelect = useCallback((f: BulkEditField) => {
    setField(f);
    setPlatform(null);
    setRawValue("");
  }, []);

  const parsedValue = (() => {
    if (!rawValue.trim()) return null;
    const cleaned = rawValue.replace(/[^0-9.]/g, "");
    const num = parseFloat(cleaned);
    if (!Number.isFinite(num) || num < 0) return null;
    if (field === "adRate") return num / 100;
    return num;
  })();

  const canApply =
    field != null &&
    field !== "printBinLabels" &&
    parsedValue != null &&
    (!isStoreSpecific || platform != null);

  function handleApply(mode: "stage" | "push" | "fastPush") {
    if (!field || field === "printBinLabels" || parsedValue == null) return;
    onApply({
      field,
      platform: isStoreSpecific ? platform : null,
      value: parsedValue,
      mode,
      rowIds: [...selectedRowIds],
    });
    onClose();
  }

  async function handlePrintBinLabels() {
    if (!onPrintBinLabels || printEligibleRowIds.length === 0) return;
    setPrintLoading(true);
    try {
      await onPrintBinLabels(printEligibleRowIds);
      onClose();
    } finally {
      setPrintLoading(false);
    }
  }

  const fieldLabel = selectedField?.label ?? "field";
  const platformLabel = platform ? PLATFORM_SHORT[platform] : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold text-foreground">
            Bulk Edit — {selectedRowIds.size} row{selectedRowIds.size !== 1 ? "s" : ""}
          </h2>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* Step 1: Field */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Field to Update
            </label>
            <div className="flex flex-wrap gap-1.5">
              {FIELD_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleFieldSelect(opt.value)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer",
                    field === opt.value
                      ? "border-violet-500 bg-violet-600/15 text-violet-700 dark:text-violet-300"
                      : "border-border bg-background text-foreground hover:border-violet-400 hover:bg-violet-50 dark:hover:bg-violet-500/10",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Step 2: Platform (only for store-specific fields) */}
          {field && field !== "printBinLabels" && isStoreSpecific && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Target Marketplace
              </label>
              {availablePlatforms.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No selected rows have listings for this field.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {availablePlatforms.map((p) => {
                    const colorClass = PLATFORM_COLORS[p];
                    return (
                      <button
                        key={p}
                        onClick={() => { setPlatform(p); setRawValue(""); }}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer",
                          platform === p
                            ? cn("border-current bg-opacity-20", colorClass)
                            : "border-border bg-background text-foreground hover:border-violet-400",
                        )}
                      >
                        <PlatformIcon platform={p} className="h-3.5 w-3.5" />
                        {PLATFORM_SHORT[p]}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Step 3: Value */}
          {field && field !== "printBinLabels" && (!isStoreSpecific || platform) && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground uppercase tracking-wide">
                New {fieldLabel} Value
                {platformLabel && <span className="ml-1 text-violet-500">({platformLabel})</span>}
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  {field === "adRate" ? "%" : "$"}
                </span>
                <input
                  ref={inputRef}
                  type="text"
                  inputMode="decimal"
                  value={rawValue}
                  onChange={(e) => setRawValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") onClose();
                    if (e.key === "Enter" && canApply) handleApply("stage");
                  }}
                  placeholder={field === "adRate" ? "e.g. 5.0" : field === "weight" ? "e.g. 8 or 2" : "e.g. 9.99"}
                  className="w-full rounded-md border border-border bg-background py-2 pl-7 pr-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
              </div>
              {field === "adRate" && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Enter as percentage (e.g. 5 = 5%). Applied to all {platformLabel} listings on selected rows.
                </p>
              )}
              {field === "salePrice" && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Enter dollar amount (e.g. 9.99). Applied to all {platformLabel} listings on selected rows.
                </p>
              )}
              {field === "weight" && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Enter weight in ounces (1–16) or pounds (e.g. 2LBS). Applied to all selected rows.
                </p>
              )}
            </div>
          )}

          {field === "printBinLabels" && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
              <p className="text-xs leading-relaxed text-foreground">
                Download a 6×4&quot; PDF with one label per eligible row, in selection order. Variation parent rows
                are skipped.
              </p>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Eligible:{" "}
                <span className="font-semibold tabular-nums text-foreground">
                  {printEligibleRowIds.length}
                </span>{" "}
                of {selectedRowIds.size} selected
                {selectedRowIds.size > 0 && printEligibleRowIds.length === 0
                  ? " (only parent rows selected — choose single-SKU or child rows)"
                  : ""}
              </p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted cursor-pointer"
          >
            Cancel
          </button>
          {field === "printBinLabels" ? (
            <button
              type="button"
              onClick={() => void handlePrintBinLabels()}
              disabled={
                printLoading ||
                printEligibleRowIds.length === 0 ||
                !onPrintBinLabels
              }
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer",
                printLoading || printEligibleRowIds.length === 0 || !onPrintBinLabels
                  ? "border-border text-muted-foreground opacity-50 cursor-not-allowed"
                  : "border-violet-400 bg-violet-600/15 text-violet-700 dark:text-violet-300 hover:bg-violet-600/25",
              )}
            >
              <Download className="h-3.5 w-3.5" />
              {printLoading ? "Generating…" : "Download PDF"}
            </button>
          ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleApply("stage")}
              disabled={!canApply}
              className={cn(
                "flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer",
                canApply
                  ? "border-violet-400 bg-violet-600/15 text-violet-700 dark:text-violet-300 hover:bg-violet-600/25"
                  : "border-border text-muted-foreground opacity-50 cursor-not-allowed",
              )}
            >
              <Check className="h-3 w-3" />
              Stage All
            </button>
            <button
              onClick={() => handleApply("push")}
              disabled={!canApply}
              className={cn(
                "flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer",
                canApply
                  ? "border-emerald-400 bg-emerald-600/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-600/25"
                  : "border-border text-muted-foreground opacity-50 cursor-not-allowed",
              )}
            >
              <ArrowRight className="h-3 w-3" />
              Review Push
            </button>
            <button
              onClick={() => handleApply("fastPush")}
              disabled={!canApply}
              className={cn(
                "flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer",
                canApply
                  ? "border-amber-400 bg-amber-600/15 text-amber-700 dark:text-amber-300 hover:bg-amber-600/25"
                  : "border-border text-muted-foreground opacity-50 cursor-not-allowed",
              )}
            >
              <Zap className="h-3 w-3" />
              Fast Push
            </button>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
