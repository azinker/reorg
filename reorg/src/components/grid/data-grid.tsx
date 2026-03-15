"use client";

import { useState, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import type { GridRow, FilterState } from "@/lib/grid-types";
import { StickySearch } from "@/components/grid/sticky-search";
import { FilterBar } from "@/components/grid/filter-bar";
import { UpcCell } from "@/components/grid/cells/upc-cell";
import { PhotoCell } from "@/components/grid/cells/photo-cell";
import { ItemNumberCell } from "@/components/grid/cells/item-number-cell";
import { StoreBlockGroup } from "@/components/grid/store-block";
import {
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  Download,
} from "lucide-react";

interface DataGridProps {
  rows: GridRow[];
}

const DEFAULT_FILTERS: FilterState = {
  marketplace: "all",
  stockStatus: "all",
  stagedOnly: false,
  missingData: null,
  priceMin: null,
  priceMax: null,
  profitMin: null,
  profitMax: null,
};

function applyFilters(rows: GridRow[], filters: FilterState): GridRow[] {
  return rows.filter((row) => {
    if (filters.stagedOnly && !row.hasStagedChanges) {
      if (!row.childRows?.some((c) => c.hasStagedChanges)) return false;
    }

    if (filters.stockStatus === "in_stock" && row.inventory === 0) return false;
    if (filters.stockStatus === "out_of_stock" && row.inventory !== 0 && row.inventory !== null) return false;

    if (filters.missingData) {
      switch (filters.missingData) {
        case "missing_upc": if (row.upc) return false; break;
        case "missing_image": if (row.imageUrl) return false; break;
        case "missing_weight": if (row.weight) return false; break;
        case "missing_supplier_cost": if (row.supplierCost != null) return false; break;
        case "missing_supplier_shipping": if (row.supplierShipping != null) return false; break;
        case "missing_shipping_rate": if (row.shippingCost != null) return false; break;
      }
    }

    return true;
  });
}

type FlatRow = GridRow & { depth: number; parentId?: string };

function flattenForRender(rows: GridRow[], expandedSet: Set<string>): FlatRow[] {
  const flat: FlatRow[] = [];
  for (const row of rows) {
    flat.push({ ...row, depth: 0 });
    if (row.isParent && row.childRows && expandedSet.has(row.id)) {
      for (const child of row.childRows) {
        flat.push({ ...child, depth: 1, parentId: row.id });
      }
    }
  }
  return flat;
}

export function DataGrid({ rows }: DataGridProps) {
  const [searchVisible, setSearchVisible] = useState(true);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const filteredRows = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const flatRows = useMemo(() => flattenForRender(filteredRows, expandedRows), [filteredRows, expandedRows]);

  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 10,
  });

  function toggleExpand(rowId: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  function scrollToRow(rowId: string) {
    const parentRow = flatRows.find((r) => r.id === rowId);
    if (!parentRow) {
      for (const r of rows) {
        if (r.childRows?.find((c) => c.id === rowId)) {
          if (!expandedRows.has(r.id)) {
            setExpandedRows((prev) => new Set([...prev, r.id]));
          }
          break;
        }
      }
    }
    setTimeout(() => {
      const idx = flatRows.findIndex((r) => r.id === rowId);
      if (idx >= 0) {
        rowVirtualizer.scrollToIndex(idx, { align: "center", behavior: "smooth" });
      }
    }, 100);
  }

  function fmtCurrency(val: number | null): string {
    if (val == null) return "—";
    return `$${val.toFixed(2)}`;
  }

  function fmtWeight(w: string | null): string {
    if (!w) return "—";
    const trimmed = w.trim().toUpperCase();
    if (trimmed.match(/^\d+$/)) return `${trimmed}oz`;
    return trimmed;
  }

  return (
    <div className="flex h-full flex-col">
      <StickySearch
        rows={rows}
        onResultSelect={scrollToRow}
        visible={searchVisible}
        onToggleVisibility={() => setSearchVisible(!searchVisible)}
      />
      <FilterBar filters={filters} onChange={setFilters} />

      <div className="flex items-center justify-between border-b border-border bg-card/30 px-4 py-1.5">
        <span className="text-xs text-muted-foreground">
          {flatRows.length} rows
          {flatRows.length !== rows.length && ` (${rows.length} total)`}
        </span>
        <button className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground cursor-pointer">
          <Download className="h-3 w-3" />
          Export
        </button>
      </div>

      {/* Grid Container */}
      <div ref={parentRef} className="flex-1 overflow-auto">
        {/* Header Row */}
        <div className="sticky top-0 z-10 flex min-w-[1600px] border-b border-border bg-card text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <div className="sticky left-0 z-20 flex shrink-0 border-r border-border bg-card shadow-[2px_0_8px_-2px_rgba(0,0,0,0.15)]">
            <div className="w-[110px] px-3 py-2.5">UPC</div>
            <div className="w-[220px] px-3 py-2.5">Item IDs</div>
            <div className="w-[140px] px-3 py-2.5">SKU</div>
            <div className="w-[280px] px-3 py-2.5">Title</div>
          </div>
          <div className="flex">
            <div className="w-[52px] px-2 py-2.5">Photo</div>
            <div className="w-[60px] px-2 py-2.5 text-right">Qty</div>
            <div className="w-[240px] px-3 py-2.5">Sale Price</div>
            <div className="w-[80px] px-3 py-2.5">Weight</div>
            <div className="w-[90px] px-3 py-2.5 text-right">Supplier</div>
            <div className="w-[90px] px-3 py-2.5 text-right">Supp Ship</div>
            <div className="w-[90px] px-3 py-2.5 text-right">Ship Cost</div>
            <div className="w-[180px] px-3 py-2.5">Ad Rate</div>
            <div className="w-[240px] px-3 py-2.5">Profit</div>
          </div>
        </div>

        {/* Virtualized Rows */}
        <div
          ref={gridRef}
          className="relative min-w-[1600px]"
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = flatRows[virtualRow.index];
            const isChild = row.depth > 0;
            const isParent = row.isParent;
            const isExpanded = expandedRows.has(row.id);

            return (
              <div
                key={row.id}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                className={cn(
                  "absolute left-0 right-0 flex border-b border-border transition-colors",
                  virtualRow.index % 2 === 0 ? "bg-background" : "bg-card/30",
                  isChild && "bg-accent/20",
                  row.hasStagedChanges && "border-l-2 border-l-[var(--staged)]",
                  row.inventory === 0 && "opacity-60"
                )}
                style={{
                  top: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {/* Frozen Columns */}
                <div className="sticky left-0 z-10 flex shrink-0 border-r border-border bg-inherit shadow-[2px_0_8px_-2px_rgba(0,0,0,0.1)]">
                  {/* UPC */}
                  <div className="flex w-[110px] items-center px-3 py-2">
                    {isChild ? (
                      <div className="pl-4">
                        <UpcCell upc={row.upc} />
                      </div>
                    ) : (
                      <UpcCell upc={row.upc} />
                    )}
                  </div>

                  {/* Item IDs */}
                  <div className="flex w-[220px] items-center px-3 py-2">
                    <div className={cn(isChild && "pl-4")}>
                      <ItemNumberCell items={row.itemNumbers} />
                    </div>
                  </div>

                  {/* SKU */}
                  <div className="flex w-[140px] items-center px-3 py-2">
                    <div className={cn("flex items-center gap-1", isChild && "pl-4")}>
                      {isParent && (
                        <button
                          onClick={() => toggleExpand(row.id)}
                          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                      {isChild && (
                        <span className="mr-1 text-muted-foreground/40">└</span>
                      )}
                      <span className="font-mono text-xs font-medium select-all">{row.sku}</span>
                    </div>
                  </div>

                  {/* Title */}
                  <div className="flex w-[280px] items-center px-3 py-2">
                    <div className={cn("min-w-0", isChild && "pl-4")}>
                      <p className="truncate text-sm font-medium leading-tight" title={row.title}>
                        {row.title}
                      </p>
                      {isParent && (
                        <span className="text-[10px] text-muted-foreground">
                          Variation Group{row.childRows ? ` (${row.childRows.length})` : ""}
                        </span>
                      )}
                      {row.alternateTitles && row.alternateTitles.length > 0 && (
                        <div className="mt-0.5 flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
                          <span className="truncate text-[10px] text-amber-500" title={row.alternateTitles[0]}>
                            Alt title exists
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Scrollable Columns */}
                <div className="flex">
                  {/* Photo */}
                  <div className="flex w-[52px] items-center justify-center px-1 py-2">
                    <PhotoCell imageUrl={row.imageUrl} alt={row.title} imageSource={row.imageSource} />
                  </div>

                  {/* Inventory */}
                  <div className="flex w-[60px] items-center justify-end px-2 py-2">
                    <span className={cn(
                      "text-xs tabular-nums",
                      row.inventory === 0 ? "text-amber-500 font-medium" : "text-foreground"
                    )}>
                      {row.inventory ?? "—"}
                    </span>
                  </div>

                  {/* Sale Price */}
                  <div className="flex w-[240px] items-center px-3 py-2">
                    <StoreBlockGroup items={row.salePrices} format="currency" />
                  </div>

                  {/* Weight */}
                  <div className="flex w-[80px] items-center px-3 py-2">
                    {row.weight ? (
                      <span className="text-xs">{fmtWeight(row.weight)}</span>
                    ) : (
                      <span className="text-[11px] text-amber-500 italic">Missing</span>
                    )}
                  </div>

                  {/* Supplier Cost */}
                  <div className="flex w-[90px] items-center justify-end px-3 py-2">
                    <span className="text-xs tabular-nums">{fmtCurrency(row.supplierCost)}</span>
                  </div>

                  {/* Supplier Shipping */}
                  <div className="flex w-[90px] items-center justify-end px-3 py-2">
                    <span className="text-xs tabular-nums">{fmtCurrency(row.supplierShipping)}</span>
                  </div>

                  {/* Shipping Cost */}
                  <div className="flex w-[90px] items-center justify-end px-3 py-2">
                    {row.shippingCost != null ? (
                      <span className="text-xs tabular-nums">{fmtCurrency(row.shippingCost)}</span>
                    ) : row.weight ? (
                      <span className="text-[11px] text-amber-500 italic">No rate</span>
                    ) : (
                      <span className="text-[11px] text-amber-500 italic">No wt</span>
                    )}
                  </div>

                  {/* Ad Rate */}
                  <div className="flex w-[180px] items-center px-3 py-2">
                    <StoreBlockGroup items={row.adRates} format="percent" />
                  </div>

                  {/* Profit */}
                  <div className="flex w-[240px] items-center px-3 py-2">
                    <StoreBlockGroup items={row.profits} format="currency" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
