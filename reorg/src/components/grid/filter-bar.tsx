"use client";

import { cn } from "@/lib/utils";
import type { FilterState, MissingDataFilter, Platform } from "@/lib/grid-types";
import { Filter, X } from "lucide-react";

interface FilterBarProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}

const MARKETPLACES: { value: Platform | "all"; label: string }[] = [
  { value: "all", label: "All Stores" },
  { value: "TPP_EBAY", label: "TPP" },
  { value: "TT_EBAY", label: "TT" },
  { value: "BIGCOMMERCE", label: "BC" },
  { value: "SHOPIFY", label: "SHPFY" },
];

const STOCK_OPTIONS = [
  { value: "all" as const, label: "All Stock" },
  { value: "in_stock" as const, label: "In Stock" },
  { value: "out_of_stock" as const, label: "Out of Stock" },
];

const MISSING_DATA_OPTIONS: { value: MissingDataFilter; label: string }[] = [
  { value: "missing_upc", label: "Missing UPC" },
  { value: "missing_image", label: "Missing Image" },
  { value: "missing_weight", label: "Missing Weight" },
  { value: "missing_supplier_cost", label: "Missing Supplier Cost" },
  { value: "missing_supplier_shipping", label: "Missing Supplier Shipping" },
  { value: "missing_shipping_rate", label: "Missing Shipping Rate" },
  { value: "missing_linkage", label: "Missing Linkages" },
];

function hasActiveFilters(f: FilterState): boolean {
  return (
    f.marketplace !== "all" ||
    f.stockStatus !== "all" ||
    f.stagedOnly ||
    f.missingData !== null ||
    f.priceMin !== null ||
    f.priceMax !== null ||
    f.profitMin !== null ||
    f.profitMax !== null
  );
}

export function FilterBar({ filters, onChange }: FilterBarProps) {
  function reset() {
    onChange({
      marketplace: "all",
      stockStatus: "all",
      stagedOnly: false,
      missingData: null,
      priceMin: null,
      priceMax: null,
      profitMin: null,
      profitMax: null,
    });
  }

  const active = hasActiveFilters(filters);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card/50 px-4 py-2">
      <Filter className="h-3.5 w-3.5 text-muted-foreground" />

      {/* Marketplace */}
      <select
        value={filters.marketplace}
        onChange={(e) => onChange({ ...filters, marketplace: e.target.value as Platform | "all" })}
        className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
      >
        {MARKETPLACES.map((m) => (
          <option key={m.value} value={m.value}>{m.label}</option>
        ))}
      </select>

      {/* Stock */}
      <select
        value={filters.stockStatus}
        onChange={(e) => onChange({ ...filters, stockStatus: e.target.value as "all" | "in_stock" | "out_of_stock" })}
        className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
      >
        {STOCK_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Staged Only */}
      <button
        onClick={() => onChange({ ...filters, stagedOnly: !filters.stagedOnly })}
        className={cn(
          "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
          filters.stagedOnly
            ? "border-[var(--staged)] bg-[var(--staged)]/15 text-[var(--staged)]"
            : "border-input bg-background text-muted-foreground hover:text-foreground"
        )}
      >
        Staged Only
      </button>

      {/* Missing Data */}
      <select
        value={filters.missingData ?? ""}
        onChange={(e) =>
          onChange({ ...filters, missingData: (e.target.value || null) as MissingDataFilter | null })
        }
        className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
      >
        <option value="">Missing Data</option>
        {MISSING_DATA_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {active && (
        <button
          onClick={reset}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-destructive cursor-pointer"
        >
          <X className="h-3 w-3" />
          Clear
        </button>
      )}
    </div>
  );
}
