"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import type { GridRow, FilterState, ColumnConfig, StoreValue, Platform } from "@/lib/grid-types";
import { HEADER_TOOLTIPS, DEFAULT_COLUMNS, PLATFORM_SHORT, PLATFORM_FULL, PLATFORM_COLORS, calcProfit, calcFee } from "@/lib/grid-types";
import { StickySearch } from "@/components/grid/sticky-search";
import { FilterBar } from "@/components/grid/filter-bar";
import { UpcCell } from "@/components/grid/cells/upc-cell";
import { PhotoCell, PhotoOverlay } from "@/components/grid/cells/photo-cell";
import { ItemNumberCell } from "@/components/grid/cells/item-number-cell";
import { StoreBlockGroup, EditableStoreBlockGroup, EditableAdRateBlockGroup } from "@/components/grid/store-block";
import { PlatformIcon } from "@/components/grid/platform-icon";
import { CopyValue } from "@/components/grid/copy-value";
import { HeaderTooltip } from "@/components/grid/header-tooltip";
import { ColumnManager } from "@/components/grid/column-manager";
import { EditableCurrencyCell } from "@/components/grid/cells/editable-currency-cell";
import { EditableWeightCell } from "@/components/grid/cells/editable-weight-cell";
import { useShippingRates } from "@/lib/use-shipping-rates";
import { useSettings } from "@/lib/use-settings";
import { getDensityPadding, getRowHeightEstimate } from "@/lib/settings-store";
import { usePlatformFee } from "@/lib/use-platform-fee";
import {
  Plus,
  Minus,
  AlertTriangle,
  Download,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Trash2,
  ArrowRight,
  RefreshCw,
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

const STORAGE_KEY_PREFIX = "reorg_grid_";

function loadUserPref<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveUserPref(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + key, JSON.stringify(value));
  } catch { /* quota exceeded - ignore */ }
}

type SortField = "title" | "sku" | "inventory" | "upc" | null;
type SortDir = "asc" | "desc";

function applyFilters(rows: GridRow[], filters: FilterState): GridRow[] {
  return rows.filter((row) => {
    if (filters.marketplace !== "all") {
      const hasPlatform = row.itemNumbers.some((item) => item.platform === filters.marketplace);
      const childHasPlatform = row.childRows?.some((child) =>
        child.itemNumbers.some((item) => item.platform === filters.marketplace)
      );
      if (!hasPlatform && !childHasPlatform) return false;
    }

    if (filters.stagedOnly && !row.hasStagedChanges) {
      if (!row.childRows?.some((c) => c.hasStagedChanges)) return false;
    }

    if (filters.stockStatus === "in_stock" && row.inventory === 0) return false;
    if (filters.stockStatus === "out_of_stock" && row.inventory !== 0 && row.inventory !== null) return false;
    if (filters.stockStatus === "low_stock") {
      if (row.isParent && row.childRows) {
        const hasLowChild = row.childRows.some((c) => c.inventory != null && c.inventory > 0 && c.inventory < 25);
        if (!hasLowChild) return false;
      } else {
        if (row.inventory == null || row.inventory === 0 || row.inventory >= 25) return false;
      }
    }

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

function applySorting(rows: GridRow[], sortField: SortField, sortDir: SortDir): GridRow[] {
  if (!sortField) return rows;
  return [...rows].sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case "title": cmp = a.title.localeCompare(b.title); break;
      case "sku": cmp = a.sku.localeCompare(b.sku); break;
      case "inventory": cmp = (a.inventory ?? -1) - (b.inventory ?? -1); break;
      case "upc": cmp = (a.upc ?? "").localeCompare(b.upc ?? ""); break;
    }
    return sortDir === "desc" ? -cmp : cmp;
  });
}

type FlatRow = GridRow & { depth: number; parentId?: string };

function flattenForRender(rows: GridRow[], expandedSet: Set<string>, stockFilter?: string, stagedOnly?: boolean): FlatRow[] {
  const flat: FlatRow[] = [];
  for (const row of rows) {
    if (stockFilter === "low_stock" && row.isParent && row.childRows) {
      const lowStockChildren = row.childRows.filter((c) => c.inventory != null && c.inventory > 0 && c.inventory < 25);
      for (const child of lowStockChildren) {
        flat.push({ ...child, depth: 0 });
      }
      continue;
    }

    const autoExpand = stagedOnly && row.isParent && row.childRows?.some((c) => c.hasStagedChanges);
    const isExpanded = expandedSet.has(row.id) || autoExpand;

    flat.push({ ...row, depth: 0 });
    if (row.isParent && row.childRows && isExpanded) {
      let children = row.childRows;
      if (stagedOnly) {
        children = children.filter((c) => c.hasStagedChanges);
      } else if (stockFilter === "low_stock") {
        children = children.filter((c) => c.inventory != null && c.inventory > 0 && c.inventory < 25);
      } else if (stockFilter === "out_of_stock") {
        children = children.filter((c) => c.inventory === 0);
      }
      for (const child of children) {
        flat.push({ ...child, depth: 1, parentId: row.id });
      }
    }
  }
  return flat;
}

const COL_WIDTHS: Record<string, string> = {
  expand: "w-[36px]",
  photo: "w-[112px]",
  upc: "w-[180px]",
  itemIds: "w-[240px]",
  sku: "w-[180px]",
  title: "w-[320px]",
  qty: "w-[100px]",
  salePrice: "w-[240px]",
  weight: "w-[80px]",
  supplierCost: "w-[100px]",
  suppShip: "w-[100px]",
  shipCost: "w-[90px]",
  platformFees: "w-[200px]",
  adRate: "w-[200px]",
  profit: "w-[240px]",
};

function applyShippingLookup(row: GridRow, lookup: (w: string | null) => number | null): GridRow {
  const shipCost = lookup(row.weight);
  const updated = { ...row, shippingCost: shipCost ?? row.shippingCost };

  if (updated.childRows) {
    updated.childRows = updated.childRows.map((child) => applyShippingLookup(child, lookup));
  }

  return recalcRowStatic(updated);
}

function recalcRowStatic(row: GridRow, overrideFeeRate?: number): GridRow {
  const ebayFeeRate = overrideFeeRate ?? row.platformFeeRate;

  const getAdRate = (platform: string, listingId: string) => {
    const ar = row.adRates.find((a) => a.platform === platform && a.listingId === listingId);
    if (!ar) return 0;
    return ar.stagedValue != null ? Number(ar.stagedValue) : ar.value != null ? Number(ar.value) : 0;
  };

  const newFees: StoreValue[] = row.salePrices.map((sp) => {
    const sale = sp.stagedValue != null ? Number(sp.stagedValue) : sp.value != null ? Number(sp.value) : 0;
    const feeRate = sp.platform === "BIGCOMMERCE" || sp.platform === "SHOPIFY" ? 0 : ebayFeeRate;
    return { platform: sp.platform, listingId: sp.listingId, variantId: sp.variantId, value: calcFee(sale, feeRate) };
  });

  const newProfits: StoreValue[] = row.salePrices.map((sp) => {
    const sale = sp.stagedValue != null ? Number(sp.stagedValue) : sp.value != null ? Number(sp.value) : 0;
    const feeRate = sp.platform === "BIGCOMMERCE" || sp.platform === "SHOPIFY" ? 0 : ebayFeeRate;
    const adRate = getAdRate(sp.platform, sp.listingId);
    return {
      platform: sp.platform,
      listingId: sp.listingId,
      variantId: sp.variantId,
      value: calcProfit(sale, row.supplierCost ?? 0, row.supplierShipping ?? 0, row.shippingCost ?? 0, feeRate, adRate),
    };
  });

  const hasStaged = row.salePrices.some((sp) => sp.stagedValue != null && sp.stagedValue !== sp.value)
    || row.adRates.some((ar) => ar.stagedValue != null && ar.stagedValue !== ar.value);
  return { ...row, platformFeeRate: ebayFeeRate, platformFees: newFees, profits: newProfits, hasStagedChanges: hasStaged };
}

function PlatformFeeHeader({ feeRate, onSave }: { feeRate: number; onSave: (rate: number) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  function handleOpen() {
    setDraft(String(Math.round(feeRate * 1000) / 10));
    setOpen((prev) => !prev);
  }

  function handleSave() {
    const num = parseFloat(draft);
    if (isNaN(num) || num < 0 || num > 100) return;
    onSave(num / 100);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={handleOpen}
        className="flex items-center gap-0.5 cursor-pointer hover:text-primary transition-colors"
        title="Click to change platform fee rate"
      >
        <span>Total Platform Fees</span>
        <span className="ml-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-primary">
          {Math.round(feeRate * 1000) / 10}%
        </span>
      </button>
      {open && (
        <div className="absolute top-full left-0 z-50 mt-2 w-64 rounded-lg border border-border bg-card p-4 shadow-xl">
          <p className="mb-2 text-xs font-semibold text-foreground">eBay Fee Rate</p>
          <p className="mb-3 text-[11px] text-muted-foreground">
            Applied to all eBay listings. BigCommerce &amp; Shopify remain at 0%.
          </p>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
                className="h-8 w-full rounded-md border border-input bg-background pl-3 pr-7 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
                autoFocus
              />
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                %
              </span>
            </div>
            <button
              onClick={handleSave}
              className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function DataGrid({ rows: initialRows }: DataGridProps) {
  const { lookupShippingCost } = useShippingRates();
  const { settings } = useSettings();
  const { feeRate: globalFeeRate, setFeeRate: setGlobalFeeRate } = usePlatformFee();
  const densityPad = getDensityPadding(settings.density);
  const rowEstimate = getRowHeightEstimate(settings.rowHeight);
  const [gridRows, setGridRows] = useState<GridRow[]>(() => structuredClone(initialRows));

  useEffect(() => {
    setGridRows(structuredClone(initialRows));
  }, [initialRows]);

  useEffect(() => {
    setGridRows((prev) =>
      prev.map((row) => applyShippingLookup(row, lookupShippingCost))
    );
  }, [lookupShippingCost]);

  useEffect(() => {
    setGridRows((prev) =>
      prev.map((row) => {
        const updated = recalcRowStatic(row, globalFeeRate);
        if (updated.childRows) {
          updated.childRows = updated.childRows.map((child) => recalcRowStatic(child, globalFeeRate));
        }
        return updated;
      })
    );
  }, [globalFeeRate]);
  const [searchVisible, setSearchVisible] = useState(() => settings.searchBar);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => {
    if (settings.autoExpandVariations) {
      const parentIds = initialRows.filter((r) => r.isParent).map((r) => r.id);
      return new Set(parentIds);
    }
    return new Set();
  });
  const [expandedPhotoId, setExpandedPhotoId] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>(() => settings.defaultSort as SortField);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [columns, setColumns] = useState<ColumnConfig[]>(() =>
    loadUserPref("columns", DEFAULT_COLUMNS)
  );
  const [highlightedRowId, setHighlightedRowId] = useState<string | null>(null);
    const [toast, setToast] = useState<string | null>(null);
    const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const parentRef = useRef<HTMLDivElement>(null);
    const bottomScrollRef = useRef<HTMLDivElement>(null);
    const syncSourceRef = useRef<"main" | "bottom" | null>(null);
    const [horizontalOverflow, setHorizontalOverflow] = useState({
      active: false,
      scrollWidth: 0,
    });

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  function findRow(rowId: string): GridRow | undefined {
    for (const r of gridRows) {
      if (r.id === rowId) return r;
      if (r.childRows) {
        const child = r.childRows.find((c) => c.id === rowId);
        if (child) return child;
      }
    }
    return undefined;
  }

  function fmtDollar(v: number | null): string {
    return v != null ? `$${v.toFixed(2)}` : "—";
  }

  function recalcRow(row: GridRow): GridRow {
    const shipCost = lookupShippingCost(row.weight);
    const withShip = shipCost != null ? { ...row, shippingCost: shipCost } : row;
    return recalcRowStatic(withShip, globalFeeRate);
  }

  function updateRowById(rowId: string, updater: (r: GridRow) => GridRow) {
    setGridRows((prev) =>
      prev.map((r) => {
        if (r.id === rowId) return updater(r);
        if (r.childRows) {
          const childIdx = r.childRows.findIndex((c) => c.id === rowId);
          if (childIdx >= 0) {
            const newChildren = [...r.childRows];
            newChildren[childIdx] = updater(newChildren[childIdx]);
            return { ...r, childRows: newChildren, hasStagedChanges: r.hasStagedChanges || newChildren.some((c) => c.hasStagedChanges) };
          }
        }
        return r;
      })
    );
  }

  function persistMasterEdit(sku: string, field: string, value: number | string | null) {
    fetch("/api/grid/edit", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku, field, value }),
    }).catch((err) => console.error("Failed to persist edit:", err));
  }

  function persistStageAction(sku: string, platform: string, listingId: string, action: string, newPrice?: number) {
    fetch("/api/grid/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, sku, platform, listingId, newPrice }),
    }).catch((err) => console.error("Failed to persist stage action:", err));
  }

  function handleWeightSave(rowId: string, weight: string) {
    const row = findRow(rowId);
    const oldWeight = row?.weight ?? "none";
    const sku = row?.sku ?? rowId;
    updateRowById(rowId, (r) => {
      const updated = { ...r, weight };
      return recalcRow(updated);
    });
    persistMasterEdit(sku, "weight", weight);
    showToast(`Weight Updated — SKU ${sku} from ${oldWeight} to ${weight}`);
  }

  function handleCellSave(rowId: string, field: string, value: number | null) {
    const row = findRow(rowId);
    const sku = row?.sku ?? rowId;
    const label = field === "supplierCost" ? "Supplier Cost" : "Supplier Shipping";
    const oldVal = row ? fmtDollar(field === "supplierCost" ? row.supplierCost : row.supplierShipping) : "—";
    updateRowById(rowId, (r) => {
      const updated = { ...r, [field]: value };
      return recalcRow(updated);
    });
    persistMasterEdit(sku, field, value);
    showToast(`${label} Updated — SKU ${sku} from ${oldVal} to ${fmtDollar(value)}`);
  }

  function handleSalePriceEdit(rowId: string, platform: string, listingId: string, newPrice: number, mode: "stage" | "push") {
    const row = findRow(rowId);
    const sku = row?.sku ?? rowId;
    const platLabel = PLATFORM_SHORT[platform as keyof typeof PLATFORM_SHORT] ?? platform;
    const oldSp = row?.salePrices.find((sp) => sp.platform === platform && sp.listingId === listingId);
    const oldVal = oldSp ? fmtDollar(Number(oldSp.stagedValue ?? oldSp.value)) : "—";
    updateRowById(rowId, (r) => {
      const newSalePrices = r.salePrices.map((sp) => {
        if (sp.platform === platform && sp.listingId === listingId) {
          if (mode === "push") {
            return { ...sp, value: newPrice, stagedValue: undefined };
          }
          return { ...sp, stagedValue: newPrice };
        }
        return sp;
      });
      const updated = { ...r, salePrices: newSalePrices };
      return recalcRow(updated);
    });
    persistStageAction(sku, platform, listingId, mode, newPrice);
    showToast(
      mode === "push"
        ? `Price Pushed Live — SKU ${sku} (${platLabel}) from ${oldVal} to ${fmtDollar(newPrice)}`
        : `Price Staged — SKU ${sku} (${platLabel}) from ${oldVal} to ${fmtDollar(newPrice)}`
    );
  }

  function handleAdRateEdit(rowId: string, platform: string, listingId: string, newRate: number, mode: "stage" | "push") {
    const row = findRow(rowId);
    const sku = row?.sku ?? rowId;
    const platLabel = PLATFORM_SHORT[platform as keyof typeof PLATFORM_SHORT] ?? platform;
    const oldAr = row?.adRates.find((a) => a.platform === platform && a.listingId === listingId);
    const fmtPct = (v: number | null | undefined) => v != null ? `${(Number(v) * 100).toFixed(1)}%` : "N/A";
    const oldVal = fmtPct(oldAr ? Number(oldAr.stagedValue ?? oldAr.value) : null);
    updateRowById(rowId, (r) => {
      const newAdRates = r.adRates.map((ar) => {
        if (ar.platform === platform && ar.listingId === listingId) {
          if (mode === "push") {
            return { ...ar, value: newRate, stagedValue: undefined };
          }
          return { ...ar, stagedValue: newRate };
        }
        return ar;
      });
      const updated = { ...r, adRates: newAdRates };
      return recalcRow(updated);
    });
    persistAdRateAction(sku, platform, listingId, mode, newRate);
    showToast(
      mode === "push"
        ? `Ad Rate Pushed Live — SKU ${sku} (${platLabel}) from ${oldVal} to ${fmtPct(newRate)}`
        : `Ad Rate Staged — SKU ${sku} (${platLabel}) from ${oldVal} to ${fmtPct(newRate)}`
    );
  }

  function persistAdRateAction(sku: string, platform: string, listingId: string, action: string, newRate?: number) {
    fetch("/api/grid/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, sku, platform, listingId, newPrice: newRate, field: "adRate" }),
    }).catch((err) => console.error("Failed to persist ad rate action:", err));
  }

  function handlePushStaged(rowId: string, platform: string, listingId: string) {
    const row = findRow(rowId);
    const sku = row?.sku ?? rowId;
    const platLabel = PLATFORM_SHORT[platform as keyof typeof PLATFORM_SHORT] ?? platform;
    const sp = row?.salePrices.find((s) => s.platform === platform && s.listingId === listingId);
    const stagedVal = sp?.stagedValue != null ? fmtDollar(Number(sp.stagedValue)) : "—";
    const pushPrice = sp?.stagedValue != null ? Number(sp.stagedValue) : undefined;
    updateRowById(rowId, (r) => {
      const newSalePrices = r.salePrices.map((s) => {
        if (s.platform === platform && s.listingId === listingId && s.stagedValue != null) {
          return { ...s, value: s.stagedValue, stagedValue: undefined };
        }
        return s;
      });
      const updated = { ...r, salePrices: newSalePrices };
      return recalcRow(updated);
    });
    if (pushPrice != null) persistStageAction(sku, platform, listingId, "push", pushPrice);
    showToast(`Price Pushed Live — SKU ${sku} (${platLabel}) ${stagedVal} is now live`);
  }

  function handleDiscardStaged(rowId: string, platform: string, listingId: string) {
    const row = findRow(rowId);
    const sku = row?.sku ?? rowId;
    const platLabel = PLATFORM_SHORT[platform as keyof typeof PLATFORM_SHORT] ?? platform;
    const sp = row?.salePrices.find((s) => s.platform === platform && s.listingId === listingId);
    const stagedVal = sp?.stagedValue != null ? fmtDollar(Number(sp.stagedValue)) : "—";
    const liveVal = sp?.value != null ? fmtDollar(Number(sp.value)) : "—";
    updateRowById(rowId, (r) => {
      const newSalePrices = r.salePrices.map((s) => {
        if (s.platform === platform && s.listingId === listingId) {
          return { ...s, stagedValue: undefined };
        }
        return s;
      });
      const updated = { ...r, salePrices: newSalePrices };
      return recalcRow(updated);
    });
    persistStageAction(sku, platform, listingId, "discard");
    showToast(`Staged Price Discarded — SKU ${sku} (${platLabel}) reverted from ${stagedVal} to ${liveVal}`);
  }

  useEffect(() => {
    saveUserPref("columns", columns);
  }, [columns]);

  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape" && expandedPhotoId) {
        setExpandedPhotoId(null);
      }
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [expandedPhotoId]);

  const filteredRows = useMemo(() => applyFilters(gridRows, filters), [gridRows, filters]);
  const sortedRows = useMemo(() => applySorting(filteredRows, sortField, sortDir), [filteredRows, sortField, sortDir]);
  const flatRows = useMemo(
    () => flattenForRender(sortedRows, expandedRows, filters.stockStatus, filters.stagedOnly),
    [sortedRows, expandedRows, filters.stockStatus, filters.stagedOnly]
  );

  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowEstimate,
    overscan: 5,
    getItemKey: (index) => flatRows[index]?.id ?? index,
  });

  function toggleExpand(rowId: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  function toggleColumn(colId: string) {
    setColumns((prev) =>
      prev.map((c) => (c.id === colId ? { ...c, visible: !c.visible } : c))
    );
  }

  function highlightRow(rowId: string) {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedRowId(null);
    requestAnimationFrame(() => {
      setHighlightedRowId(rowId);
      highlightTimerRef.current = setTimeout(() => {
        setHighlightedRowId(null);
        highlightTimerRef.current = null;
      }, 3500);
    });
  }

  function scrollToRow(rowId: string) {
    const idx = flatRows.findIndex((r) => r.id === rowId);
    if (idx >= 0) {
      rowVirtualizer.scrollToIndex(idx, { align: "center", behavior: "smooth" });
      setTimeout(() => highlightRow(rowId), 300);
      return;
    }
    for (const r of gridRows) {
      if (r.childRows?.find((c) => c.id === rowId)) {
        if (!expandedRows.has(r.id)) {
          setExpandedRows((prev) => new Set([...prev, r.id]));
        }
        break;
      }
    }
    setTimeout(() => {
      const i = flatRows.findIndex((r) => r.id === rowId);
      if (i >= 0) {
        rowVirtualizer.scrollToIndex(i, { align: "center", behavior: "smooth" });
        setTimeout(() => highlightRow(rowId), 300);
      }
    }, 100);
  }

  function isColVisible(id: string) {
    return columns.find((c) => c.id === id)?.visible ?? true;
  }

  const [clearStagedOpen, setClearStagedOpen] = useState(false);
  const [clearStagedInput, setClearStagedInput] = useState("");

  const stagedCount = useMemo(() => {
    let count = 0;
    for (const row of gridRows) {
      for (const sp of row.salePrices) {
        if (sp.stagedValue != null && sp.stagedValue !== sp.value) count++;
      }
      if (row.childRows) {
        for (const child of row.childRows) {
          for (const sp of child.salePrices) {
            if (sp.stagedValue != null && sp.stagedValue !== sp.value) count++;
          }
        }
      }
    }
    return count;
  }, [gridRows]);

  function handleClearAllStaged() {
    setGridRows((prev) =>
      prev.map((row) => {
        const newSalePrices = row.salePrices.map((sp) => ({ ...sp, stagedValue: undefined }));
        let newChildren = row.childRows;
        if (newChildren) {
          newChildren = newChildren.map((child) => {
            const cPrices = child.salePrices.map((sp) => ({ ...sp, stagedValue: undefined }));
            return recalcRowStatic({ ...child, salePrices: cPrices, hasStagedChanges: false }, globalFeeRate);
          });
        }
        return recalcRowStatic({ ...row, salePrices: newSalePrices, hasStagedChanges: false, childRows: newChildren ?? row.childRows }, globalFeeRate);
      })
    );
    setClearStagedOpen(false);
    setClearStagedInput("");
    fetch("/api/grid/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear_all" }),
    }).catch((err) => console.error("Failed to clear staged in DB:", err));
    showToast(`All ${stagedCount} staged values cleared — live values restored`);
  }

  const ALL_PLATFORMS: Platform[] = ["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"];

  const [globalPriceOpen, setGlobalPriceOpen] = useState(false);
  const [gpSource, setGpSource] = useState<Platform | null>(null);
  const [gpDest, setGpDest] = useState<Set<Platform>>(new Set());
  const [gpMode, setGpMode] = useState<"stage" | "push" | null>(null);

  const gpAffectedCount = useMemo(() => {
    if (!gpSource || gpDest.size === 0) return 0;
    let count = 0;
    function countInRow(row: GridRow) {
      const sourceSp = row.salePrices.find((sp) => sp.platform === gpSource);
      if (!sourceSp) return;
      for (const sp of row.salePrices) {
        if (gpDest.has(sp.platform as Platform) && sp.platform !== gpSource) count++;
      }
    }
    for (const row of gridRows) {
      countInRow(row);
      if (row.childRows) {
        for (const child of row.childRows) countInRow(child);
      }
    }
    return count;
  }, [gridRows, gpSource, gpDest]);

  function handleGlobalPriceUpdate(mode: "stage" | "push") {
    if (!gpSource || gpDest.size === 0) return;
    const srcShort = PLATFORM_SHORT[gpSource];
    const destShorts = [...gpDest].map((p) => PLATFORM_SHORT[p]).join(", ");
    let updated = 0;

    setGridRows((prev) =>
      prev.map((row) => {
        function applyToRow(r: GridRow): GridRow {
          const sourceSp = r.salePrices.find((sp) => sp.platform === gpSource);
          if (!sourceSp) return r;
          const sourcePrice = sourceSp.stagedValue != null ? Number(sourceSp.stagedValue) : Number(sourceSp.value);
          let changed = false;
          const newSalePrices = r.salePrices.map((sp) => {
            if (gpDest.has(sp.platform as Platform) && sp.platform !== gpSource) {
              changed = true;
              updated++;
              if (mode === "push") return { ...sp, value: sourcePrice, stagedValue: undefined };
              return { ...sp, stagedValue: sourcePrice };
            }
            return sp;
          });
          if (!changed) return r;
          return recalcRowStatic({ ...r, salePrices: newSalePrices, hasStagedChanges: mode === "stage" || r.hasStagedChanges }, globalFeeRate);
        }

        const newRow = applyToRow(row);
        let newChildren = row.childRows;
        if (newChildren) {
          newChildren = newChildren.map((child) => applyToRow(child));
        }
        return { ...newRow, childRows: newChildren ?? newRow.childRows };
      })
    );

    setGlobalPriceOpen(false);
    setGpSource(null);
    setGpDest(new Set());
    setGpMode(null);
    showToast(
      mode === "push"
        ? `Global Price Push — ${srcShort} → ${destShorts} (${updated} listings updated live)`
        : `Global Price Staged — ${srcShort} → ${destShorts} (${updated} listings staged)`
    );
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

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return <ArrowUpDown className="ml-1 h-3 w-3 opacity-30" />;
    return sortDir === "asc"
      ? <ArrowUp className="ml-1 h-3 w-3 text-primary" />
      : <ArrowDown className="ml-1 h-3 w-3 text-primary" />;
  }

  const expandedPhoto = expandedPhotoId
    ? flatRows.find((r) => r.id === expandedPhotoId)
    : null;

  const frozenCols = columns.filter((c) => c.frozen && c.visible);
  const scrollCols = columns.filter((c) => !c.frozen && c.visible);

  const expandColWidth = parseInt(COL_WIDTHS.expand.replace(/\D/g, ""));
  const frozenWidth = frozenCols.reduce((sum, c) => {
    const w = COL_WIDTHS[c.id];
    if (!w) return sum;
    const num = parseInt(w.replace(/\D/g, ""));
    return sum + num;
  }, expandColWidth);

  const scrollWidth = scrollCols.reduce((sum, c) => {
    const w = COL_WIDTHS[c.id];
    if (!w) return sum;
    const num = parseInt(w.replace(/\D/g, ""));
    return sum + num;
  }, 0);

  const totalMinWidth = frozenWidth + scrollWidth;

  const cellPy = settings.density === "compact" ? "py-0.5" : settings.density === "spacious" ? "py-3" : "py-2";

  const rowFontStyle = { '--row-font-size': `${settings.rowTextSize}px` } as React.CSSProperties;

  useEffect(() => {
    const main = parentRef.current;
    if (!main) return;

    const updateOverflow = () => {
      const overflowWidth = Math.max(0, main.scrollWidth - main.clientWidth);
      setHorizontalOverflow({
        active: overflowWidth > 24,
        scrollWidth: Math.max(main.scrollWidth, main.clientWidth),
      });
    };

    updateOverflow();

    const observer = new ResizeObserver(updateOverflow);
    observer.observe(main);
    Array.from(main.children).forEach((child) => observer.observe(child));
    window.addEventListener("resize", updateOverflow);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateOverflow);
    };
  }, [totalMinWidth, flatRows.length, settings.density, columns]);

  useEffect(() => {
    const main = parentRef.current;
    const bottom = bottomScrollRef.current;
    if (!main || !bottom || !horizontalOverflow.active) return;

    const releaseSync = () => {
      requestAnimationFrame(() => {
        syncSourceRef.current = null;
      });
    };

    const syncFromMain = () => {
      if (syncSourceRef.current === "bottom") return;
      syncSourceRef.current = "main";
      bottom.scrollLeft = main.scrollLeft;
      releaseSync();
    };

    const syncFromBottom = () => {
      if (syncSourceRef.current === "main") return;
      syncSourceRef.current = "bottom";
      main.scrollLeft = bottom.scrollLeft;
      releaseSync();
    };

    bottom.scrollLeft = main.scrollLeft;

    main.addEventListener("scroll", syncFromMain);
    bottom.addEventListener("scroll", syncFromBottom);

    return () => {
      main.removeEventListener("scroll", syncFromMain);
      bottom.removeEventListener("scroll", syncFromBottom);
    };
  }, [horizontalOverflow.active, horizontalOverflow.scrollWidth]);

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_auto_auto_minmax(0,1fr)_auto]">
      {settings.searchBar && (
        <StickySearch
          rows={gridRows}
          onResultSelect={scrollToRow}
          visible={searchVisible}
          onToggleVisibility={() => setSearchVisible(!searchVisible)}
        />
      )}
      <FilterBar filters={filters} onChange={(f) => {
        setFilters(f);
        parentRef.current?.scrollTo({ top: 0 });
      }} />

      <div className="flex items-center justify-between border-b border-border bg-card/30 px-4 py-1.5">
        <span className="text-xs text-muted-foreground">
          {flatRows.length} rows
          {flatRows.length !== gridRows.length && ` (${gridRows.length} total)`}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setGpSource(null); setGpDest(new Set()); setGpMode(null); setGlobalPriceOpen(true); }}
            className="flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20 cursor-pointer"
          >
            <RefreshCw className="h-3 w-3" />
            Global Price Update
          </button>
          {stagedCount > 0 && (
            <button
              onClick={() => { setClearStagedInput(""); setClearStagedOpen(true); }}
              className="flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/20 cursor-pointer"
            >
              <Trash2 className="h-3 w-3" />
              Clear Staged ({stagedCount})
            </button>
          )}
          <ColumnManager columns={columns} onToggle={toggleColumn} />
          <button className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground cursor-pointer">
            <Download className="h-3 w-3" />
            Export
          </button>
        </div>
      </div>

      <div className="relative h-full min-h-0">
      <div ref={parentRef} className="app-grid-scroll min-h-0 h-full overflow-scroll">
        {/* Header */}
        <div
          className="sticky top-0 z-20 flex border-b-2 border-border bg-card text-xs font-bold uppercase tracking-wide text-foreground/80"
          style={{ minWidth: totalMinWidth }}
        >
          {/* Frozen headers */}
          <div className="sticky left-0 z-30 flex shrink-0 bg-card shadow-[2px_0_8px_-2px_rgba(0,0,0,0.15)]">
            {/* Expand/collapse column — always visible, no header text */}
            <div className={cn(COL_WIDTHS.expand, "flex items-center justify-center py-3")} />
            {isColVisible("photo") && (
              <div className={cn(COL_WIDTHS.photo, "flex items-center gap-0.5 px-2 py-3")}>
                <span>Photo</span>
                <HeaderTooltip text={HEADER_TOOLTIPS.photo} />
              </div>
            )}
            {isColVisible("upc") && (
              <div className={cn(COL_WIDTHS.upc, "flex items-center gap-0.5 px-3 py-3")}>
                <span>UPC</span>
                <HeaderTooltip text={HEADER_TOOLTIPS.upc} />
              </div>
            )}
            {isColVisible("itemIds") && (
              <div className={cn(COL_WIDTHS.itemIds, "flex items-center gap-0.5 px-3 py-3")}>
                <span>Item IDs</span>
                <HeaderTooltip text={HEADER_TOOLTIPS.itemIds} />
              </div>
            )}
            {isColVisible("sku") && (
              <button
                onClick={() => toggleSort("sku")}
                className={cn(COL_WIDTHS.sku, "flex items-center gap-0.5 px-3 py-3 cursor-pointer hover:text-foreground")}
              >
                <span>SKU</span>
                <SortIcon field="sku" />
                <HeaderTooltip text={HEADER_TOOLTIPS.sku} />
              </button>
            )}
            {isColVisible("title") && (
              <button
                onClick={() => toggleSort("title")}
                className={cn(COL_WIDTHS.title, "flex items-center gap-0.5 px-3 py-3 cursor-pointer hover:text-foreground")}
              >
                <span>Title</span>
                <SortIcon field="title" />
                <HeaderTooltip text={HEADER_TOOLTIPS.title} />
              </button>
            )}
          </div>

          {/* Scrollable headers */}
          <div className="flex">
            {isColVisible("qty") && (
              <button
                onClick={() => toggleSort("inventory")}
                className={cn(COL_WIDTHS.qty, "flex items-center justify-end gap-0.5 px-2 py-3 cursor-pointer hover:text-foreground")}
              >
                <span>Live Quantity</span>
                <SortIcon field="inventory" />
                <HeaderTooltip text={HEADER_TOOLTIPS.qty} />
              </button>
            )}
            {isColVisible("salePrice") && (
              <div className={cn(COL_WIDTHS.salePrice, "flex items-center gap-0.5 px-3 py-3")}>
                <span>Sale Price</span>
                <HeaderTooltip text={HEADER_TOOLTIPS.salePrice} />
              </div>
            )}
            {isColVisible("weight") && (
              <div className={cn(COL_WIDTHS.weight, "flex items-center gap-0.5 px-3 py-3")}>
                <span>Weight</span>
                <HeaderTooltip text={HEADER_TOOLTIPS.weight} />
              </div>
            )}
            {isColVisible("supplierCost") && (
              <div className={cn(COL_WIDTHS.supplierCost, "flex items-center gap-0.5 px-3 py-3")}>
                <span>Supplier Cost of Good</span>
                <HeaderTooltip text={HEADER_TOOLTIPS.supplierCost} />
              </div>
            )}
            {isColVisible("suppShip") && (
              <div className={cn(COL_WIDTHS.suppShip, "flex items-center gap-0.5 px-3 py-3")}>
                <span>Supplier Shipping Cost</span>
                <HeaderTooltip text={HEADER_TOOLTIPS.suppShip} />
              </div>
            )}
            {isColVisible("shipCost") && (
              <div className={cn(COL_WIDTHS.shipCost, "flex items-center gap-0.5 px-3 py-3")}>
                <span>Shipping Cost</span>
                <HeaderTooltip text={HEADER_TOOLTIPS.shipCost} />
              </div>
            )}
            {isColVisible("platformFees") && (
              <div className={cn(COL_WIDTHS.platformFees, "flex items-center gap-0.5 px-3 py-3")}>
                <PlatformFeeHeader
                  feeRate={globalFeeRate}
                  onSave={(rate) => {
                    const oldRate = globalFeeRate;
                    setGlobalFeeRate(rate);
                    showToast(`Platform Fee Updated — from ${Math.round(oldRate * 1000) / 10}% to ${Math.round(rate * 1000) / 10}% (all eBay listings)`);
                  }}
                />
                <HeaderTooltip text={HEADER_TOOLTIPS.platformFees} />
              </div>
            )}
            {isColVisible("adRate") && (
              <div className={cn(COL_WIDTHS.adRate, "flex items-center gap-0.5 px-3 py-3")}>
                <span>Promoted General Ad Rate</span>
                <HeaderTooltip text={HEADER_TOOLTIPS.adRate} />
              </div>
            )}
            {isColVisible("profit") && (
              <div className={cn(COL_WIDTHS.profit, "flex items-center gap-0.5 px-3 py-3")}>
                <span>Profit</span>
                <HeaderTooltip text={HEADER_TOOLTIPS.profit} />
              </div>
            )}
          </div>
        </div>

        {/* Virtualized Rows */}
        <div
          className="relative"
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            minWidth: totalMinWidth,
          }}
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
                  "absolute left-0 right-0 flex border-b border-border transition-colors grid-row-data",
                  virtualRow.index % 2 === 0 ? "bg-background" : "bg-card",
                  isChild && "bg-muted",
                  row.hasStagedChanges && "border-l-2 border-l-[var(--staged)]",
                  highlightedRowId === row.id && "row-highlight"
                )}
                style={{
                  top: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                  ...rowFontStyle,
                }}
              >
                {/* Frozen Columns — no extra padding on container so child row columns stay aligned with parent */}
                <div className={cn(
                  "sticky left-0 z-10 flex shrink-0 bg-inherit shadow-[2px_0_8px_-2px_rgba(0,0,0,0.1)]",
                  isChild && "pl-10 border-l-[3px] border-l-emerald-400/50"
                )}>
                  {/* Expand / Collapse — indent and hierarchy bar only in this column for children */}
                  <div className={cn(
                    COL_WIDTHS.expand,
                    "flex items-center justify-center",
                    cellPy
                  )}>
                    {isParent && (
                      <button
                        onClick={() => toggleExpand(row.id)}
                        className={cn(
                          "flex h-5 w-5 items-center justify-center rounded text-white transition-colors cursor-pointer",
                          isExpanded
                            ? "bg-emerald-600 hover:bg-emerald-700"
                            : "bg-emerald-500 hover:bg-emerald-600"
                        )}
                        title={isExpanded ? "Collapse variations" : "Expand variations"}
                      >
                        {isExpanded ? (
                          <Minus className="h-3.5 w-3.5" strokeWidth={3} />
                        ) : (
                          <Plus className="h-3.5 w-3.5" strokeWidth={3} />
                        )}
                      </button>
                    )}
                    {isChild && (
                      <span className="text-base font-semibold text-emerald-400">↳</span>
                    )}
                  </div>

                  {/* Photo */}
                  {isColVisible("photo") && (
                    <div className={cn(COL_WIDTHS.photo, "flex items-center justify-center px-1.5", cellPy)}>
                      <PhotoCell
                        imageUrl={row.imageUrl}
                        alt={row.title}
                        imageSource={row.imageSource}
                        rowId={row.id}
                        expandedPhotoId={expandedPhotoId}
                        onToggleExpand={setExpandedPhotoId}
                      />
                    </div>
                  )}

                  {/* UPC */}
                  {isColVisible("upc") && (
                    <div className={cn(COL_WIDTHS.upc, "flex items-center px-2", cellPy)}>
                      <div className={cn("w-full min-w-0", isChild && "pl-4")}>
                        <UpcCell upc={row.upc} />
                      </div>
                    </div>
                  )}

                  {/* Item IDs */}
                  {isColVisible("itemIds") && (
                    <div className={cn(COL_WIDTHS.itemIds, "flex items-center px-2", cellPy)}>
                      <div className={cn("w-full min-w-0", isChild && "pl-4")}>
                        <ItemNumberCell items={row.itemNumbers} />
                      </div>
                    </div>
                  )}

                  {/* SKU */}
                  {isColVisible("sku") && (
                    <div className={cn(COL_WIDTHS.sku, "flex items-center px-3 overflow-hidden", cellPy)}>
                      {isParent ? (
                        <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">
                          <span>Variation Parent</span>
                          {row.childRows && (
                            <span className="rounded bg-emerald-500/20 px-1 text-[10px] tabular-nums">
                              {row.childRows.length}
                            </span>
                          )}
                        </span>
                      ) : (
                        <CopyValue value={row.sku}>
                          <span className="scalable-text font-mono font-medium truncate block max-w-full">{row.sku}</span>
                        </CopyValue>
                      )}
                    </div>
                  )}

                  {/* Title */}
                  {isColVisible("title") && (
                    <div className={cn(COL_WIDTHS.title, "flex items-center px-3", cellPy)}>
                      <div className={cn("min-w-0 w-full", isChild && "pl-4")}>
                        <CopyValue value={row.title}>
                          <p className="scalable-text font-medium leading-snug break-words whitespace-normal">
                            {row.title}
                          </p>
                        </CopyValue>
                        {isParent && (
                          <span className={cn(
                            "inline-flex items-center gap-1 mt-0.5 text-[10px]",
                            isExpanded ? "text-emerald-500" : "text-muted-foreground"
                          )}>
                            <span className="font-semibold">Variation Listing</span>
                            {row.childRows ? ` · ${row.childRows.length} SKUs` : ""}
                            {!isExpanded && <span className="text-emerald-500 font-medium ml-0.5">(click + to expand)</span>}
                          </span>
                        )}
                        {settings.showAlternateTitles && row.alternateTitles && row.alternateTitles.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            <div className="flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
                              <span className="text-[10px] font-semibold text-amber-500">
                                Title Mismatch ({row.alternateTitles.length} store{row.alternateTitles.length > 1 ? "s" : ""})
                              </span>
                            </div>
                            {row.alternateTitles.map((alt, i) => (
                              <div key={i} className="flex items-start gap-1 rounded bg-amber-500/10 px-1.5 py-1 text-[10px] text-amber-400 leading-tight">
                                <img
                                  src={alt.platform === "BIGCOMMERCE" ? "/logos/bigcommerce.svg" : alt.platform === "SHOPIFY" ? "/logos/shopify.svg" : "/logos/ebay.svg"}
                                  alt="" width={12} height={12} className="mt-px shrink-0" style={{ width: 12, height: 12 }}
                                />
                                <span className="break-words whitespace-normal">
                                  <span className="font-bold text-foreground/70">{alt.listingId}</span>
                                  {" · "}
                                  <span className="italic">{alt.title}</span>
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Scrollable Columns */}
                <div className="flex">
                  {/* Inventory */}
                  {isColVisible("qty") && (
                    <div className={cn(COL_WIDTHS.qty, "flex items-center justify-end px-2", cellPy)}>
                      <CopyValue value={String(row.inventory ?? "")}>
                        <span className={cn(
                          "scalable-text tabular-nums font-semibold",
                          row.inventory == null
                            ? "text-muted-foreground"
                            : row.inventory < 5
                              ? "text-red-500"
                              : row.inventory < 25
                                ? "text-amber-400"
                                : "text-emerald-500"
                        )}>
                          {row.inventory == null ? "—" : row.inventory}
                          {isParent && row.inventory != null && (
                            <span className="ml-0.5 text-[9px] font-normal text-muted-foreground">Σ</span>
                          )}
                        </span>
                      </CopyValue>
                    </div>
                  )}

                  {/* Sale Price (editable per item) */}
                  {isColVisible("salePrice") && (
                    <div className={cn(COL_WIDTHS.salePrice, "flex items-center px-3", cellPy)}>
                      <EditableStoreBlockGroup
                        items={row.salePrices}
                        rowId={row.id}
                        onSave={handleSalePriceEdit}
                        onPush={handlePushStaged}
                        onDiscard={handleDiscardStaged}
                      />
                    </div>
                  )}

                  {/* Weight */}
                  {isColVisible("weight") && (
                    <div className={cn(COL_WIDTHS.weight, "flex items-center px-3", cellPy)}>
                      <EditableWeightCell
                        value={row.weight}
                        rowId={row.id}
                        onSave={handleWeightSave}
                      />
                    </div>
                  )}

                  {/* Supplier Cost (editable) */}
                  {isColVisible("supplierCost") && (
                    <div className={cn(COL_WIDTHS.supplierCost, "flex items-center justify-end px-3", cellPy)}>
                      <EditableCurrencyCell
                        value={row.supplierCost}
                        rowId={row.id}
                        field="supplierCost"
                        onSave={handleCellSave}
                      />
                    </div>
                  )}

                  {/* Supplier Shipping (editable) */}
                  {isColVisible("suppShip") && (
                    <div className={cn(COL_WIDTHS.suppShip, "flex items-center justify-end px-3", cellPy)}>
                      <EditableCurrencyCell
                        value={row.supplierShipping}
                        rowId={row.id}
                        field="supplierShipping"
                        onSave={handleCellSave}
                      />
                    </div>
                  )}

                  {/* Shipping Cost */}
                  {isColVisible("shipCost") && (
                    <div className={cn(COL_WIDTHS.shipCost, "flex items-center justify-end px-3", cellPy)}>
                      {row.shippingCost != null ? (
                        <CopyValue value={String(row.shippingCost)}>
                          <span className="scalable-text tabular-nums">{fmtCurrency(row.shippingCost)}</span>
                        </CopyValue>
                      ) : row.weight ? (
                        <span className="text-[11px] text-amber-500 italic">No rate</span>
                      ) : (
                        <span className="text-[11px] text-amber-500 italic">No wt</span>
                      )}
                    </div>
                  )}

                  {/* Platform Fees */}
                  {isColVisible("platformFees") && (
                    <div className={cn(COL_WIDTHS.platformFees, "flex items-center px-3", cellPy)}>
                      <StoreBlockGroup items={row.platformFees} format="currency" showStaged={false} />
                    </div>
                  )}

                  {/* Ad Rate: editable only on parent/standalone rows; child SKUs show rate read-only */}
                  {isColVisible("adRate") && (
                    <div className={cn(COL_WIDTHS.adRate, "flex items-center px-3", cellPy)}>
                      {row.isVariation && !row.isParent ? (
                        <StoreBlockGroup items={row.adRates} format="percent" showStaged={false} />
                      ) : (
                        <EditableAdRateBlockGroup
                          items={row.adRates}
                          rowId={row.id}
                          onSave={handleAdRateEdit}
                        />
                      )}
                    </div>
                  )}

                  {/* Profit */}
                  {isColVisible("profit") && (
                    <div className={cn(COL_WIDTHS.profit, "flex items-center px-3", cellPy)}>
                      <StoreBlockGroup items={row.profits} format="currency" />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      </div>

      {/* Photo overlay — only one at a time */}
      {horizontalOverflow.active && (
        <div className="sticky bottom-0 z-30 border-t border-border bg-gradient-to-r from-card/95 via-muted/85 to-card/95 px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_-10px_24px_rgba(0,0,0,0.18)]">
          <div
            ref={bottomScrollRef}
            className="app-grid-scrollbar h-10 overflow-x-auto overflow-y-hidden rounded-full border border-border/80 bg-gradient-to-b from-card/95 via-muted/85 to-card/95 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_8px_18px_rgba(0,0,0,0.18)]"
          >
            <div style={{ width: horizontalOverflow.scrollWidth, height: 1 }} />
          </div>
        </div>
      )}

      {expandedPhoto && expandedPhoto.imageUrl && (
        <PhotoOverlay
          imageUrl={expandedPhoto.imageUrl}
          alt={expandedPhoto.title}
          onClose={() => setExpandedPhotoId(null)}
        />
      )}

      {/* Clear All Staged Confirmation */}
      {clearStagedOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl">
            <h3 className="text-base font-bold text-foreground">Clear All Staged Values</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              There {stagedCount === 1 ? "is" : "are"} <span className="font-bold text-amber-400">{stagedCount}</span> staged
              {stagedCount === 1 ? " value" : " values"}. Clearing will discard all staged prices and restore live values.
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              To confirm, type <span className="font-bold text-foreground">{stagedCount}</span> below and click confirm.
            </p>
            <input
              type="text"
              value={clearStagedInput}
              onChange={(e) => setClearStagedInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && clearStagedInput === String(stagedCount)) handleClearAllStaged();
                if (e.key === "Escape") setClearStagedOpen(false);
              }}
              placeholder={String(stagedCount)}
              className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm tabular-nums text-foreground outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setClearStagedOpen(false)}
                className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleClearAllStaged}
                disabled={clearStagedInput !== String(stagedCount)}
                className={cn(
                  "rounded-md px-4 py-2 text-sm font-bold transition-colors cursor-pointer",
                  clearStagedInput === String(stagedCount)
                    ? "bg-red-500 text-white hover:bg-red-600"
                    : "bg-muted text-muted-foreground cursor-not-allowed opacity-50"
                )}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Sale Price Update */}
      {globalPriceOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
            <h3 className="text-base font-bold text-foreground">Global Sale Price Update</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Copy one store&apos;s sale price to other stores across all rows.
            </p>

            {/* Step 1: Source */}
            <div className="mt-4">
              <span className="text-xs font-bold uppercase text-muted-foreground">1. Source — copy prices from:</span>
              <div className="mt-2 flex flex-wrap gap-2">
                {ALL_PLATFORMS.map((p) => (
                  <button
                    key={`src-${p}`}
                    onClick={() => { setGpSource(p); setGpDest(new Set()); setGpMode(null); }}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-bold transition-all cursor-pointer",
                      PLATFORM_COLORS[p],
                      gpSource === p
                        ? "ring-2 ring-primary shadow-md scale-105"
                        : "opacity-70 hover:opacity-100"
                    )}
                  >
                    <PlatformIcon platform={p} className="h-4 w-4 shrink-0" />
                    <span className="font-extrabold uppercase">{PLATFORM_SHORT[p]}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Step 2: Destinations */}
            {gpSource && (
              <div className="mt-4">
                <span className="text-xs font-bold uppercase text-muted-foreground">2. Destination — apply prices to:</span>
                <div className="mt-2 flex flex-wrap gap-2">
                  {ALL_PLATFORMS.filter((p) => p !== gpSource).map((p) => {
                    const isSelected = gpDest.has(p);
                    return (
                      <button
                        key={`dest-${p}`}
                        onClick={() => {
                          setGpDest((prev) => {
                            const next = new Set(prev);
                            if (next.has(p)) next.delete(p);
                            else next.add(p);
                            return next;
                          });
                          setGpMode(null);
                        }}
                        className={cn(
                          "flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-bold transition-all cursor-pointer",
                          PLATFORM_COLORS[p],
                          isSelected
                            ? "ring-2 ring-emerald-400 shadow-md scale-105"
                            : "opacity-50 hover:opacity-100"
                        )}
                      >
                        <PlatformIcon platform={p} className="h-4 w-4 shrink-0" />
                        <span className="font-extrabold uppercase">{PLATFORM_SHORT[p]}</span>
                        {isSelected && <span className="text-emerald-400 text-[10px]">✓</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Summary & Actions */}
            {gpSource && gpDest.size > 0 && (
              <div className="mt-4 rounded-md border border-border bg-background/50 p-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-bold text-foreground">{PLATFORM_SHORT[gpSource]}</span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  <span className="font-bold text-foreground">
                    {[...gpDest].map((p) => PLATFORM_SHORT[p]).join(", ")}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  This will update <span className="font-bold text-foreground">{gpAffectedCount}</span> listing
                  {gpAffectedCount !== 1 ? "s" : ""} across all rows.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => handleGlobalPriceUpdate("stage")}
                    className="flex items-center gap-1 rounded-md bg-[var(--staged)] px-3 py-1.5 text-xs font-bold text-[var(--staged-foreground)] hover:opacity-80 cursor-pointer"
                  >
                    Stage All
                  </button>
                  <button
                    onClick={() => handleGlobalPriceUpdate("push")}
                    className="flex items-center gap-1 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-600 cursor-pointer"
                  >
                    Push All Live
                  </button>
                </div>
              </div>
            )}

            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setGlobalPriceOpen(false)}
                className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] animate-in fade-in slide-in-from-top-2 rounded-lg border border-border bg-card px-5 py-2 text-sm font-medium text-foreground shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
