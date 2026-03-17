"use client";

import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import type { FilterState, MissingDataFilter, Platform, StockFilter } from "@/lib/grid-types";
import { Filter, X, ChevronDown } from "lucide-react";

interface FilterBarProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}

const PLATFORM_LOGO: Record<string, string> = {
  TPP_EBAY: "/logos/ebay.svg",
  TT_EBAY: "/logos/ebay.svg",
  BIGCOMMERCE: "/logos/bigcommerce.svg",
  SHOPIFY: "/logos/shopify.svg",
};

const MARKETPLACES: { value: Platform | "all"; label: string; logo?: string }[] = [
  { value: "all", label: "All Stores" },
  { value: "TPP_EBAY", label: "The Perfect Part (eBay)", logo: PLATFORM_LOGO.TPP_EBAY },
  { value: "TT_EBAY", label: "Telitetech (eBay)", logo: PLATFORM_LOGO.TT_EBAY },
  { value: "BIGCOMMERCE", label: "BigCommerce", logo: PLATFORM_LOGO.BIGCOMMERCE },
  { value: "SHOPIFY", label: "Shopify", logo: PLATFORM_LOGO.SHOPIFY },
];

const STOCK_OPTIONS: { value: StockFilter; label: string }[] = [
  { value: "all", label: "All Stock" },
  { value: "in_stock", label: "In Stock" },
  { value: "low_stock", label: "Low Stock (<25)" },
  { value: "out_of_stock", label: "Out of Stock" },
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

function MarketplaceDropdown({ value, onChange }: { value: Platform | "all"; onChange: (v: Platform | "all") => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const selected = MARKETPLACES.find((m) => m.value === value) ?? MARKETPLACES[0];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
      >
        {selected.logo && (
          <img src={selected.logo} alt="" width={14} height={14} className="shrink-0" style={{ width: 14, height: 14 }} />
        )}
        <span>{selected.label}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[200px] rounded-md border border-border bg-popover py-1 shadow-lg">
          {MARKETPLACES.map((m) => (
            <button
              key={m.value}
              onClick={() => { onChange(m.value); setOpen(false); }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent cursor-pointer",
                m.value === value ? "bg-accent text-foreground font-medium" : "text-foreground/80"
              )}
            >
              {m.logo ? (
                <img src={m.logo} alt="" width={16} height={16} className="shrink-0" style={{ width: 16, height: 16 }} />
              ) : (
                <span className="inline-block w-4" />
              )}
              <span>{m.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
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

      <MarketplaceDropdown
        value={filters.marketplace}
        onChange={(v) => onChange({ ...filters, marketplace: v })}
      />

      <select
        value={filters.stockStatus}
        onChange={(e) => onChange({ ...filters, stockStatus: e.target.value as StockFilter })}
        className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
      >
        {STOCK_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

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
