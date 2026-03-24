"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import type { GridRow, FilterState, ColumnConfig, StoreValue, Platform, UpcPushTarget } from "@/lib/grid-types";
import { DEFAULT_COLUMNS, PLATFORM_SHORT, PLATFORM_FULL, PLATFORM_COLORS, calcProfit, calcFee } from "@/lib/grid-types";
import { StickySearch } from "@/components/grid/sticky-search";
import { FilterBar } from "@/components/grid/filter-bar";
import { UpcCell, type LiveUpcChoice } from "@/components/grid/cells/upc-cell";
import { PhotoCell, PhotoOverlay } from "@/components/grid/cells/photo-cell";
import { ItemNumberCell } from "@/components/grid/cells/item-number-cell";
import {
  StoreBlockGroup,
  EditableStoreBlockGroup,
  EditableAdRateBlockGroup,
  type QuickPushState,
  type FailedPushState,
} from "@/components/grid/store-block";
import { PlatformIcon } from "@/components/grid/platform-icon";
import { CopyValue } from "@/components/grid/copy-value";
import { ColumnManager } from "@/components/grid/column-manager";
import { EditableCurrencyCell } from "@/components/grid/cells/editable-currency-cell";
import { EditableWeightCell } from "@/components/grid/cells/editable-weight-cell";
import {
  PushConfirmModal,
  type PushApiData,
  type PushItem,
} from "@/components/push/push-confirm-modal";
import { useShippingRates } from "@/lib/use-shipping-rates";
import { useSettings } from "@/lib/use-settings";
import { getDensityPadding, getRowHeightEstimate } from "@/lib/settings-store";
import { usePlatformFee } from "@/lib/use-platform-fee";
import {
  GRID_INTERACTION_EVENT,
  type GridInteractionDetail,
} from "@/lib/grid-interaction-lock";
import {
  Plus,
  Minus,
  Check,
  AlertTriangle,
  Download,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Trash2,
  ArrowRight,
  RefreshCw,
  X,
} from "lucide-react";

interface DataGridProps {
  rows: GridRow[];
}

type PushField = "salePrice" | "adRate" | "upc";
type PushLaunchMode = "review" | "fast";
type RowRefreshPhase = "loading" | "success";

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
};

type NormalizedLiveUpcChoice = LiveUpcChoice & {
  normalizedValue: string;
};

type MatchUpcPlan = {
  rowId: string;
  sku: string;
  title: string;
  majorityUpc: string;
  allowSingleSource: boolean;
  sourceChoices: NormalizedLiveUpcChoice[];
  mismatchChoices: NormalizedLiveUpcChoice[];
  actionableMismatchChoices: NormalizedLiveUpcChoice[];
  lockedMismatchChoices: NormalizedLiveUpcChoice[];
  stageTargets: UpcPushTarget[];
  previewItems: PushItem[];
};

type MatchUpcPlanResult =
  | {
      ok: true;
      plan: MatchUpcPlan;
    }
  | {
      ok: false;
      message: string;
      canMatchAnyway: boolean;
    };

type BulkMatchUpcCandidate = {
  id: string;
  sku: string;
  title: string;
  majorityUpc: string;
  modeLabel: string;
  sourceChoices: NormalizedLiveUpcChoice[];
  mismatchChoices: NormalizedLiveUpcChoice[];
  actionableCount: number;
  previewCount: number;
  lockedCount: number;
  note: string | null;
  plan: MatchUpcPlan;
};

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
      if (!row.childRowsHydrated) {
        continue;
      }
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
  expand: "w-[72px]",
  photo: "w-[112px]",
  upc: "w-[240px]",
  itemIds: "w-[240px]",
  sku: "w-[240px]",
  title: "w-[320px]",
  qty: "w-[100px]",
  salePrice: "w-[240px]",
  weight: "w-[80px]",
  supplierCost: "w-[100px]",
  suppShip: "w-[100px]",
  shipCost: "w-[90px]",
  platformFees: "w-[200px]",
  adRate: "w-[240px]",
  profit: "w-[240px]",
};

const ITEM_NUMBER_PLATFORM_ORDER: Record<Platform, number> = {
  TPP_EBAY: 0,
  TT_EBAY: 1,
  SHOPIFY: 2,
  BIGCOMMERCE: 3,
};

function sortItemNumbersForDisplay(items: StoreValue[]): StoreValue[] {
  return [...items].sort((a, b) => {
    const platformDelta =
      ITEM_NUMBER_PLATFORM_ORDER[a.platform] - ITEM_NUMBER_PLATFORM_ORDER[b.platform];
    if (platformDelta !== 0) {
      return platformDelta;
    }

    const listingDelta = String(a.listingId).localeCompare(String(b.listingId), undefined, {
      numeric: true,
    });
    if (listingDelta !== 0) {
      return listingDelta;
    }

    return String(a.variantId ?? "").localeCompare(String(b.variantId ?? ""), undefined, {
      numeric: true,
    });
  });
}

function rebuildParentFromChildren(parent: GridRow): GridRow {
  if (!parent.isParent || !parent.childRows?.length) {
    return parent;
  }

  const itemNumberMap = new Map<string, StoreValue>();
  for (const child of parent.childRows) {
    for (const item of child.itemNumbers) {
      const key = `${item.platform}:${item.listingId}`;
      if (!itemNumberMap.has(key)) {
        itemNumberMap.set(key, item);
      }
    }
  }

  const inventoryValues = parent.childRows
    .map((child) => child.inventory)
    .filter((value): value is number => value != null);

  return {
    ...parent,
    inventory:
      inventoryValues.length > 0
        ? inventoryValues.reduce((sum, value) => sum + value, 0)
        : null,
    itemNumbers: sortItemNumbersForDisplay([...itemNumberMap.values()]),
    hasStagedChanges:
      Boolean(parent.hasStagedUpc) || parent.childRows.some((child) => child.hasStagedChanges),
    childRowsHydrated: true,
  };
}

function applyShippingLookup(row: GridRow, lookup: (w: string | null) => number | null): GridRow {
  const shipCost = lookup(row.weight);
  const updated = { ...row, shippingCost: shipCost ?? row.shippingCost };

  if (updated.childRows) {
    updated.childRows = updated.childRows.map((child) => applyShippingLookup(child, lookup));
  }

  return recalcRowStatic(updated);
}

function sameStoreValueIdentity(
  a: Pick<StoreValue, "platform" | "listingId" | "marketplaceListingId" | "variantId">,
  b: Pick<StoreValue, "platform" | "listingId" | "marketplaceListingId" | "variantId">,
) {
  if (a.marketplaceListingId && b.marketplaceListingId) {
    return a.marketplaceListingId === b.marketplaceListingId;
  }

  if (a.variantId && b.variantId) {
    return (
      a.platform === b.platform &&
      a.listingId === b.listingId &&
      a.variantId === b.variantId
    );
  }

  return a.platform === b.platform && a.listingId === b.listingId;
}

function recalcRowStatic(row: GridRow, overrideFeeRate?: number): GridRow {
  const ebayFeeRate = overrideFeeRate ?? row.platformFeeRate;

  const getAdRate = (target: StoreValue) => {
    const ar = row.adRates.find((a) => sameStoreValueIdentity(a, target));
    if (!ar) return 0;
    return ar.stagedValue != null ? Number(ar.stagedValue) : ar.value != null ? Number(ar.value) : 0;
  };

  const newFees: StoreValue[] = row.salePrices.map((sp) => {
    const sale = sp.stagedValue != null ? Number(sp.stagedValue) : sp.value != null ? Number(sp.value) : 0;
    const feeRate = sp.platform === "BIGCOMMERCE" || sp.platform === "SHOPIFY" ? 0 : ebayFeeRate;
    return {
      platform: sp.platform,
      listingId: sp.listingId,
      marketplaceListingId: sp.marketplaceListingId,
      variantId: sp.variantId,
      value: calcFee(sale, feeRate),
    };
  });

  const newProfits: StoreValue[] = row.salePrices.map((sp) => {
    const sale = sp.stagedValue != null ? Number(sp.stagedValue) : sp.value != null ? Number(sp.value) : 0;
    const feeRate = sp.platform === "BIGCOMMERCE" || sp.platform === "SHOPIFY" ? 0 : ebayFeeRate;
    const adRate = getAdRate(sp);
    return {
      platform: sp.platform,
      listingId: sp.listingId,
      marketplaceListingId: sp.marketplaceListingId,
      variantId: sp.variantId,
      value: calcProfit(sale, row.supplierCost ?? 0, row.supplierShipping ?? 0, row.shippingCost ?? 0, feeRate, adRate),
    };
  });

  const hasStaged = row.salePrices.some((sp) => sp.stagedValue != null && sp.stagedValue !== sp.value)
    || row.adRates.some((ar) => ar.stagedValue != null && ar.stagedValue !== ar.value)
    || Boolean(row.stagedUpc && row.stagedUpc !== row.upc);
  return { ...row, platformFeeRate: ebayFeeRate, platformFees: newFees, profits: newProfits, hasStagedChanges: hasStaged };
}

function mergeIncomingRows(prevRows: GridRow[], nextRows: GridRow[]): GridRow[] {
  const prevById = new Map(prevRows.map((row) => [row.id, row]));

  return normalizeGridRows(structuredClone(nextRows)).map((row) => {
    const prev = prevById.get(row.id);
    if (!prev || !row.isParent) return row;

    if (prev.childRowsHydrated && prev.childRows?.length) {
      return normalizeGridRow({
        ...row,
        childRows: normalizeGridRows(prev.childRows),
        childRowsHydrated: true,
      });
    }

    return row;
  });
}

function dedupeStoreValues(items: StoreValue[]): StoreValue[] {
  const valuesByKey = new Map<string, StoreValue>();

  for (const item of items) {
    const key = `${item.platform}:${item.listingId}:${item.variantId ?? ""}`;
    const existing = valuesByKey.get(key);

    if (!existing) {
      valuesByKey.set(key, item);
      continue;
    }

    const existingHasStaged =
      existing.stagedValue != null && existing.stagedValue !== existing.value;
    const nextHasStaged = item.stagedValue != null && item.stagedValue !== item.value;
    const existingHasValue = existing.value != null;
    const nextHasValue = item.value != null;
    const existingHasMarketplaceListingId = Boolean(existing.marketplaceListingId);
    const nextHasMarketplaceListingId = Boolean(item.marketplaceListingId);

    if (
      (nextHasStaged && !existingHasStaged) ||
      (nextHasValue && !existingHasValue) ||
      (nextHasMarketplaceListingId && !existingHasMarketplaceListingId)
    ) {
      valuesByKey.set(key, item);
    }
  }

  return [...valuesByKey.values()];
}

function dedupeUpcPushTargets(row: GridRow): GridRow {
  const upcPushTargets = row.upcPushTargets
    ? [...new Map(
        row.upcPushTargets.map((target) => [
          `${target.platform}:${target.listingId}:${target.variantId ?? ""}`,
          target,
        ]),
      ).values()]
    : row.upcPushTargets;

  return {
    ...row,
    upcPushTargets,
  };
}

function normalizeGridRow(row: GridRow): GridRow {
  const normalizedChildren = row.childRows?.map((child) => normalizeGridRow(child));

  return dedupeUpcPushTargets({
    ...row,
    itemNumbers: dedupeStoreValues(row.itemNumbers),
    salePrices: dedupeStoreValues(row.salePrices),
    adRates: dedupeStoreValues(row.adRates),
    platformFees: dedupeStoreValues(row.platformFees),
    profits: dedupeStoreValues(row.profits),
    childRows: normalizedChildren,
  });
}

function normalizeGridRows(rows: GridRow[]): GridRow[] {
  return rows.map((row) => normalizeGridRow(row));
}

function buildPushResultLookupKeys(entry: {
  marketplaceListingId?: string | null;
  platform: Platform;
  listingId: string;
  variantId?: string | null;
  field: string;
}) {
  const keys = new Set<string>();

  if (entry.marketplaceListingId) {
    keys.add(`${entry.marketplaceListingId}:${entry.field}`);
  }

  keys.add(`${entry.platform}:${entry.listingId}:${entry.field}`);

  if (entry.variantId) {
    keys.add(`${entry.platform}:${entry.listingId}:${entry.variantId}:${entry.field}`);
  }

  return [...keys];
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
  const [gridRows, setGridRows] = useState<GridRow[]>(() =>
    normalizeGridRows(structuredClone(initialRows))
  );
  const [upcLiveRefreshRevisions, setUpcLiveRefreshRevisions] = useState<Record<string, number>>({});
  const [activeGridInteractionIds, setActiveGridInteractionIds] = useState<Set<string>>(() => new Set());
  const pendingInitialRowsRef = useRef<GridRow[] | null>(null);
  const lastMergedInitialRowsRef = useRef<GridRow[] | null>(initialRows);
  const [pushModalOpen, setPushModalOpen] = useState(false);
  const [pushModalItems, setPushModalItems] = useState<PushItem[]>([]);
  const [pushModalPreviewItems, setPushModalPreviewItems] = useState<PushItem[]>([]);
  const [pushModalLaunchMode, setPushModalLaunchMode] = useState<PushLaunchMode>("review");

  function isInteractionLocked() {
    return activeGridInteractionIds.size > 0 || pushModalOpen;
  }

  function bumpUpcLiveRefresh(rowIds: string[]) {
    if (rowIds.length === 0) return;

    setUpcLiveRefreshRevisions((prev) => {
      const next = { ...prev };
      for (const rowId of rowIds) {
        next[rowId] = (next[rowId] ?? 0) + 1;
      }
      return next;
    });
  }

  useEffect(() => {
    if (isInteractionLocked()) {
      if (initialRows !== lastMergedInitialRowsRef.current) {
        pendingInitialRowsRef.current = initialRows;
      }
      return;
    }

    if (initialRows === lastMergedInitialRowsRef.current) {
      return;
    }

    setGridRows((prev) => mergeIncomingRows(prev, initialRows));
    lastMergedInitialRowsRef.current = initialRows;
  }, [activeGridInteractionIds, initialRows]);

  useEffect(() => {
    setGridRows((prev) => normalizeGridRows(prev));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    function handleInteractionLock(event: Event) {
      const customEvent = event as CustomEvent<GridInteractionDetail>;
      const detail = customEvent.detail;
      if (!detail?.sourceId) return;

      setActiveGridInteractionIds((prev) => {
        const next = new Set(prev);
        if (detail.active) {
          next.add(detail.sourceId);
        } else {
          next.delete(detail.sourceId);
        }
        return next;
      });
    }

    window.addEventListener(GRID_INTERACTION_EVENT, handleInteractionLock as EventListener);
    return () => {
      window.removeEventListener(GRID_INTERACTION_EVENT, handleInteractionLock as EventListener);
    };
  }, []);

  useEffect(() => {
    if (isInteractionLocked() || !pendingInitialRowsRef.current) return;

    const pendingRows = pendingInitialRowsRef.current;
    pendingInitialRowsRef.current = null;
    if (pendingRows === lastMergedInitialRowsRef.current) {
      return;
    }

    setGridRows((prev) => mergeIncomingRows(prev, pendingRows));
    lastMergedInitialRowsRef.current = pendingRows;
  }, [activeGridInteractionIds, pushModalOpen]);

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
  const [failedPushes, setFailedPushes] = useState<FailedPushItem[]>([]);
  const [failedPushesOpen, setFailedPushesOpen] = useState(false);
  const [failedPushesLoading, setFailedPushesLoading] = useState(false);
  const [quickPushStates, setQuickPushStates] = useState<Record<string, QuickPushState>>({});
  const [childRowsLoading, setChildRowsLoading] = useState<Record<string, boolean>>({});
  const [rowRefreshStates, setRowRefreshStates] = useState<Record<string, RowRefreshPhase>>({});
  const [pendingScrollRowId, setPendingScrollRowId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickPushTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const rowRefreshTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const childRowsLoadRef = useRef<Partial<Record<string, Promise<boolean>>>>({});
  const parentRef = useRef<HTMLDivElement>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  function setRowRefreshPhase(rowIds: string[], phase: RowRefreshPhase) {
    setRowRefreshStates((prev) => {
      const next = { ...prev };
      for (const rowId of rowIds) {
        next[rowId] = phase;
      }
      return next;
    });
  }

  function clearRowRefreshPhase(rowIds: string[]) {
    setRowRefreshStates((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const rowId of rowIds) {
        if (next[rowId]) {
          delete next[rowId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }

  function resetRowRefreshTimers(rowIds: string[]) {
    for (const rowId of rowIds) {
      if (rowRefreshTimersRef.current[rowId]) {
        clearTimeout(rowRefreshTimersRef.current[rowId]);
        delete rowRefreshTimersRef.current[rowId];
      }
    }
  }

  function scheduleRowRefreshReset(rowIds: string[]) {
    for (const rowId of rowIds) {
      rowRefreshTimersRef.current[rowId] = setTimeout(() => {
        clearRowRefreshPhase([rowId]);
        delete rowRefreshTimersRef.current[rowId];
      }, 2400);
    }
  }

  function replaceParentRow(rowId: string, updater: (row: GridRow) => GridRow) {
    setGridRows((prev) => prev.map((row) => (row.id === rowId ? updater(row) : row)));
  }

  function applyRefreshedRowSnapshot(
    rowId: string,
    refreshedRow: GridRow,
    parentRowId?: string,
    refreshedChildRows?: GridRow[] | null,
  ) {
    setGridRows((prev) =>
      prev.map((entry) => {
        if (parentRowId) {
          if (entry.id !== parentRowId) {
            return entry;
          }

          const currentChildren = entry.childRows ?? [];
          const nextChildren = currentChildren.map((child) =>
            child.id === rowId ? refreshedRow : child,
          );

          return rebuildParentFromChildren({
            ...entry,
            childRows: nextChildren,
          });
        }

        if (entry.id !== rowId) {
          return entry;
        }

        if (refreshedChildRows) {
          return {
            ...refreshedRow,
            childRows: refreshedChildRows,
            childRowsHydrated: true,
          };
        }

        if (entry.isParent && entry.childRowsHydrated && entry.childRows?.length) {
          return {
            ...refreshedRow,
            childRows: entry.childRows,
            childRowsHydrated: true,
          };
        }

        return refreshedRow;
      }),
    );

    bumpUpcLiveRefresh([
      rowId,
      ...(refreshedChildRows?.map((child) => child.id) ?? []),
    ]);
  }

  async function handleRefreshRow(rowId: string, parentRowId?: string) {
    const currentParentRow = parentRowId
      ? gridRows.find((entry) => entry.id === parentRowId)
      : null;
    const currentRow = parentRowId
      ? currentParentRow?.childRows?.find((child) => child.id === rowId) ?? null
      : gridRows.find((entry) => entry.id === rowId) ?? null;

    const refreshFamilyIds =
      currentRow?.isParent && currentRow.childRows?.length
        ? [rowId, ...currentRow.childRows.map((child) => child.id)]
        : [rowId];

    resetRowRefreshTimers(refreshFamilyIds);
    setRowRefreshPhase(refreshFamilyIds, "loading");

    try {
      const shouldReloadChildren = Boolean(
        !parentRowId && currentRow?.isParent && currentRow.childRowsHydrated,
      );

      if (currentRow?.isParent && rowId.startsWith("variation-parent:")) {
        const childRows = currentRow.childRows ?? [];
        if (childRows.length === 0) {
          throw new Error("Variation parent has no child rows to refresh.");
        }

        const childResponses = await Promise.all(
          childRows.map(async (child) => {
            const response = await fetch(`/api/grid/${child.id}/refresh`, {
              method: "POST",
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
              throw new Error(
                payload?.error ?? `Failed to refresh child row ${child.sku} (${response.status})`,
              );
            }

            const refreshedChild = (payload?.data?.row ?? null) as GridRow | null;
            if (!refreshedChild) {
              throw new Error(`Refresh completed, but child row ${child.sku} was missing its updated payload.`);
            }

            return {
              childId: child.id,
              childSku: child.sku,
              row: refreshedChild,
              message: payload?.data?.message as string | undefined,
            };
          }),
        );

        const refreshedChildrenById = new Map(
          childResponses.map((result) => [result.childId, result.row]),
        );
        const refreshedChildren = childRows.map((child) =>
          refreshedChildrenById.get(child.id) ?? child,
        );

        applyRefreshedRowSnapshot(
          rowId,
          rebuildParentFromChildren({
            ...currentRow,
            childRows: refreshedChildren,
          }),
          undefined,
          refreshedChildren,
        );

        const successIds = [rowId, ...refreshedChildren.map((child) => child.id)];
        setRowRefreshPhase(successIds, "success");
        scheduleRowRefreshReset(successIds);
        showToast(`Refreshed ${refreshedChildren.length} variation SKU${refreshedChildren.length === 1 ? "" : "s"}.`);
        return;
      }

      const response = await fetch(`/api/grid/${rowId}/refresh`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? `Failed to refresh row (${response.status})`);
      }

      const refreshedRow = (payload?.data?.row ?? null) as GridRow | null;
      if (!refreshedRow) {
        throw new Error("Refresh completed, but the updated row payload was missing.");
      }

      let refreshedChildRows: GridRow[] | null = null;
      if (shouldReloadChildren) {
        const childResponse = await fetch(`/api/grid/${rowId}/children`, {
          cache: "no-store",
        });
        const childPayload = await childResponse.json().catch(() => ({}));
        if (!childResponse.ok) {
          throw new Error(
            childPayload?.error ??
              `Failed to refresh variation rows (${childResponse.status})`,
          );
        }

        refreshedChildRows = (childPayload?.data?.rows ?? []) as GridRow[];
      }

      applyRefreshedRowSnapshot(rowId, refreshedRow, parentRowId, refreshedChildRows);

      const message =
        typeof payload?.data?.message === "string" && payload.data.message.trim()
          ? payload.data.message
          : "Row refresh completed.";
      setRowRefreshPhase(refreshFamilyIds, "success");
      scheduleRowRefreshReset(refreshFamilyIds);
      showToast(message);
    } catch (error) {
      console.error("[data-grid] failed to refresh row", error);
      clearRowRefreshPhase(refreshFamilyIds);
      showToast(
        error instanceof Error
          ? error.message
          : "Failed to refresh row. Please try again.",
      );
    }
  }

  async function ensureChildRowsLoaded(rowId: string) {
    const parentRow = gridRows.find((row) => row.id === rowId);
    if (!parentRow?.isParent || parentRow.childRowsHydrated) {
      return true;
    }

    if (childRowsLoadRef.current[rowId]) {
      return childRowsLoadRef.current[rowId];
    }

    setChildRowsLoading((prev) => ({ ...prev, [rowId]: true }));
    const loadPromise = fetch(`/api/grid/${rowId}/children`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error ?? `Failed to load variation rows (${response.status})`);
        }

        const rows = payload?.data?.rows as GridRow[] | undefined;
        replaceParentRow(rowId, (row) => ({
          ...row,
          childRows: rows ?? [],
          childRowsHydrated: true,
        }));
        return true;
      })
      .catch((error) => {
        console.error("[data-grid] failed to load child rows", error);
        showToast("Failed to load variation rows. Please try again.");
        return false;
      })
      .finally(() => {
        setChildRowsLoading((prev) => {
          const next = { ...prev };
          delete next[rowId];
          return next;
        });
        delete childRowsLoadRef.current[rowId];
      });

    childRowsLoadRef.current[rowId] = loadPromise;
    return loadPromise;
  }

  async function loadFailedPushes() {
    setFailedPushesLoading(true);
    try {
      const response = await fetch("/api/push/failures", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Failed to load push failures (${response.status})`);
      }
      const payload = await response.json();
      setFailedPushes(payload.data?.failures ?? []);
    } catch (error) {
      console.error("[data-grid] failed to load push failures", error);
    } finally {
      setFailedPushesLoading(false);
    }
  }

  useEffect(() => {
    void loadFailedPushes();
  }, []);

  useEffect(() => {
    return () => {
      Object.values(quickPushTimersRef.current).forEach((timer) => clearTimeout(timer));
      Object.values(rowRefreshTimersRef.current).forEach((timer) => clearTimeout(timer));
    };
  }, []);

  function queuePushReview(
    items: PushItem[],
    launchMode: PushLaunchMode = "review",
    previewItems?: PushItem[],
  ) {
    if (items.length === 0) {
      showToast("No staged changes were ready to review for push.");
      return;
    }
    setPushModalItems(items);
    setPushModalPreviewItems(previewItems ?? items);
    setPushModalLaunchMode(launchMode);
    setPushModalOpen(true);
  }

  function getQuickPushKey(rowId: string, platform: string, listingId: string, field: PushField) {
    return `${rowId}:${platform}:${listingId}:${field}`;
  }

  function getUpcQuickPushKey(rowId: string) {
    return `${rowId}:upc`;
  }

  function setQuickPushState(key: string, state: QuickPushState) {
    setQuickPushStates((prev) => ({ ...prev, [key]: state }));
  }

  function clearQuickPushState(key: string) {
    if (quickPushTimersRef.current[key]) {
      clearTimeout(quickPushTimersRef.current[key]);
      delete quickPushTimersRef.current[key];
    }
    setQuickPushStates((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function scheduleQuickPushSuccessClear(key: string) {
    if (quickPushTimersRef.current[key]) {
      clearTimeout(quickPushTimersRef.current[key]);
    }
    quickPushTimersRef.current[key] = setTimeout(() => {
      clearQuickPushState(key);
    }, 2500);
  }

  function buildPushItem(
    row: GridRow | undefined,
    platform: string,
    listingId: string,
    field: PushField,
    newValue?: number | string,
  ): PushItem | null {
    if (!row) return null;

    if (field === "upc") {
      const stagedUpc = typeof newValue === "string" ? newValue : row.stagedUpc ?? null;
      const target = row.upcPushTargets?.find(
        (entry) => entry.platform === platform && entry.listingId === listingId,
      );
      if (!target || !stagedUpc) return null;

      return {
        sku: row.sku,
        title: row.title,
        platform: platform as Platform,
        listingId,
        platformVariantId: target.variantId,
        stagedChangeId:
          target.stagedChangeId && !isLocalUpcStageId(target.stagedChangeId)
            ? target.stagedChangeId
            : undefined,
        masterRowId: row.id.startsWith("child-") ? row.id.replace(/^child-/, "") : row.id,
        marketplaceListingId: target.marketplaceListingId ?? undefined,
        field,
        oldValue: row.upc,
        newValue: stagedUpc,
      };
    }

    const sourceValues = field === "salePrice" ? row.salePrices : row.adRates;
    const value = sourceValues.find(
      (entry) => entry.platform === platform && entry.listingId === listingId,
    );
    if (!value) return null;

    const liveValue =
      value.value != null && typeof value.value === "number"
        ? Number(value.value)
        : null;
    const stagedValue =
      newValue ??
      (value.stagedValue != null && typeof value.stagedValue === "number"
        ? Number(value.stagedValue)
        : null);

    if (stagedValue == null) return null;

    return {
      sku: row.sku,
      title: row.title,
      platform: platform as Platform,
      listingId,
      masterRowId: row.id.startsWith("child-") ? row.id.replace(/^child-/, "") : row.id,
      marketplaceListingId: value.marketplaceListingId ?? undefined,
      platformVariantId: value.variantId,
      field,
      oldValue: liveValue,
      newValue: stagedValue,
    };
  }

  function buildLocalUpcStageId(platform: string, listingId: string) {
    return `local:${platform}:${listingId}`;
  }

  function isLocalUpcStageId(value: string | null | undefined) {
    return typeof value === "string" && value.startsWith("local:");
  }

  function getActiveUpcTargets(row: GridRow | undefined) {
    if (!row || row.isParent) return [];

    const allTargets = row.upcPushTargets ?? [];
    const stagedTargets = allTargets.filter((target) => Boolean(target.stagedChangeId));
    return stagedTargets.length > 0 ? stagedTargets : allTargets;
  }

  function buildUpcPushItems(row: GridRow | undefined): PushItem[] {
    if (!row || row.isParent || !row.hasStagedUpc || !row.stagedUpc) return [];

    const activeTargets = getActiveUpcTargets(row);

    return activeTargets
      .map((target) =>
        buildPushItem(row, target.platform, target.listingId, "upc", row.stagedUpc ?? undefined),
      )
      .filter((item): item is PushItem => Boolean(item));
  }

  function buildUpcPushChoices(row: GridRow | undefined) {
    if (!row || row.isParent) return [];

    const activeTargets = row.upcPushTargets ?? [];
    const counts = new Map<string, number>();
    for (const target of activeTargets) {
      counts.set(target.platform, (counts.get(target.platform) ?? 0) + 1);
    }

    return activeTargets.map((target) => {
      const short = PLATFORM_SHORT[target.platform];
      const duplicatePlatform = (counts.get(target.platform) ?? 0) > 1;
      return {
        platform: target.platform,
        listingId: target.listingId,
        label: duplicatePlatform ? `${short} #${target.listingId.slice(-6)}` : short,
        stagedChangeId: target.stagedChangeId ?? null,
      };
    });
  }

  async function fetchLiveUpcChoices(rowId: string): Promise<LiveUpcChoice[]> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`/api/grid/${rowId}/upc-live`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Failed to load live UPC summary (${response.status})`);
        }
        const payload = (await response.json()) as {
          data?: {
            choices?: LiveUpcChoice[];
          };
        };
        return payload.data?.choices ?? [];
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Failed to load live UPC summary.");
      }
    }
    throw lastError ?? new Error("Failed to load live UPC summary.");
  }

  async function fetchBulkLiveUpcChoices(rowIds: string[]) {
    const choicesByRowId = new Map<string, LiveUpcChoice[]>();

    for (let index = 0; index < rowIds.length; index += 250) {
      const batch = rowIds.slice(index, index + 250);
      const response = await fetch("/api/grid/upc-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ rowIds: batch }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        data?: {
          items?: Array<{
            rowId?: string;
            choices?: LiveUpcChoice[];
          }>;
        };
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? `Failed to bulk load live UPC summaries (${response.status})`);
      }

      for (const item of payload.data?.items ?? []) {
        if (!item.rowId) continue;
        choicesByRowId.set(item.rowId, item.choices ?? []);
      }
    }

    return choicesByRowId;
  }

  function buildMatchUpcPlan(
    row: GridRow | undefined,
    choices: LiveUpcChoice[],
    options?: { allowSingleSource?: boolean },
  ): MatchUpcPlanResult {
    if (!row || row.isParent) {
      return {
        ok: false,
        message: "Match UPC can only be used on a single row or child row.",
        canMatchAnyway: false,
      };
    }

    const normalizedChoices: NormalizedLiveUpcChoice[] = choices.map((choice) => ({
      ...choice,
      normalizedValue: choice.value?.trim() ?? "",
    }));
    const populatedChoices = normalizedChoices.filter((choice) => choice.normalizedValue.length > 0);

    if (populatedChoices.length === 0) {
      return {
        ok: false,
        message: `Match UPC needs at least one live UPC on SKU ${row.sku}.`,
        canMatchAnyway: false,
      };
    }

    const counts = new Map<string, number>();
    for (const choice of populatedChoices) {
      counts.set(choice.normalizedValue, (counts.get(choice.normalizedValue) ?? 0) + 1);
    }

    const rankedUpcs = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const topCount = rankedUpcs[0]?.[1] ?? 0;
    const leaders = rankedUpcs.filter(([, count]) => count === topCount);
    const singleSourceCandidate =
      populatedChoices.length === 1 &&
      normalizedChoices.length > 1 &&
      normalizedChoices.every(
        (choice) =>
          choice.normalizedValue.length === 0 ||
          choice.normalizedValue === populatedChoices[0]?.normalizedValue,
      );
    const allowSingleSource = Boolean(options?.allowSingleSource && singleSourceCandidate);

    if (leaders.length !== 1 || (topCount < 2 && !allowSingleSource)) {
      return {
        ok: false,
        message:
          singleSourceCandidate
            ? "Only one marketplace has a UPC on this row. Use Match Anyway if you want the blank marketplaces to inherit that UPC."
            : topCount < 2
              ? "Match UPC needs at least two marketplaces sharing the same UPC before it can update the others."
              : "Match UPC could not run because there is no majority UPC. The marketplaces are tied, so please choose the correct UPC manually.",
        canMatchAnyway: singleSourceCandidate,
      };
    }

    const majorityUpc =
      allowSingleSource
        ? (populatedChoices[0]?.normalizedValue ?? "")
        : (leaders[0]?.[0] ?? "");
    if (!majorityUpc) {
      return {
        ok: false,
        message: `Match UPC could not determine the majority UPC for SKU ${row.sku}.`,
        canMatchAnyway: false,
      };
    }

    const sourceChoices = normalizedChoices.filter((choice) => choice.normalizedValue === majorityUpc);
    const mismatchChoices = normalizedChoices.filter((choice) => choice.normalizedValue !== majorityUpc);
    const actionableMismatchChoices = mismatchChoices.filter((choice) => choice.editable);
    const lockedMismatchChoices = mismatchChoices.filter((choice) => !choice.editable);

    if (actionableMismatchChoices.length === 0) {
      return {
        ok: false,
        message:
          mismatchChoices.length === 0
            ? `All editable marketplaces already match UPC ${majorityUpc} on SKU ${row.sku}.`
            : "The differing marketplaces are not available for UPC push from this row yet.",
        canMatchAnyway: false,
      };
    }

    const mismatchedPlatforms = new Set(actionableMismatchChoices.map((choice) => choice.platform));
    const stageTargets = (row.upcPushTargets ?? []).filter((target) => mismatchedPlatforms.has(target.platform));
    if (stageTargets.length === 0) {
      return {
        ok: false,
        message: "Match UPC found the outlier UPC, but none of those marketplaces can be staged from this row.",
        canMatchAnyway: false,
      };
    }

    const previewItems: PushItem[] = mismatchChoices.map((choice) => {
      const itemNumber = row.itemNumbers.find((item) => item.platform === choice.platform);
      return {
        sku: row.sku,
        title: row.title,
        platform: choice.platform,
        listingId: itemNumber?.listingId ?? choice.label,
        platformVariantId: itemNumber?.variantId,
        masterRowId: row.id.startsWith("child-") ? row.id.replace(/^child-/, "") : row.id,
        field: "upc",
        oldValue: choice.value,
        newValue: majorityUpc,
      };
    });

    return {
      ok: true,
      plan: {
        rowId: row.id,
        sku: row.sku,
        title: row.title,
        majorityUpc,
        allowSingleSource,
        sourceChoices,
        mismatchChoices,
        actionableMismatchChoices,
        lockedMismatchChoices,
        stageTargets,
        previewItems,
      },
    };
  }

  async function stageMatchUpcPlan(plan: MatchUpcPlan) {
    const row = findRow(plan.rowId);
    if (!row || row.isParent) {
      return null;
    }

    const results = await Promise.allSettled(
      plan.stageTargets.map((target) =>
        persistUpcAction(row.sku, "stage", plan.majorityUpc, {
          platform: target.platform,
          listingId: target.listingId,
        }),
      ),
    );

    const successfulTargets = plan.stageTargets.filter((_, index) => results[index]?.status === "fulfilled");
    if (successfulTargets.length === 0) {
      return null;
    }

    const stagedTargetMeta = new Map<
      string,
      { stagedChangeId: string | null; marketplaceListingId: string | null; platform: Platform; listingId: string }
    >();
    for (const [index, result] of results.entries()) {
      if (result.status !== "fulfilled") continue;
      const payload = result.value as {
        data?: {
          targets?: Array<{
            platform?: string;
            listingId?: string;
            marketplaceListingId?: string | null;
            stagedChangeId?: string | null;
          }>;
        };
      };
      const targets = payload.data?.targets ?? [];
      for (const target of targets) {
        if (!target.platform || !target.listingId) continue;
        stagedTargetMeta.set(`${target.platform}:${target.listingId}`, {
          platform: target.platform as Platform,
          listingId: target.listingId,
          marketplaceListingId: target.marketplaceListingId ?? null,
          stagedChangeId: target.stagedChangeId ?? null,
        });
      }

      if (targets.length === 0) {
        const fallbackTarget = plan.stageTargets[index];
        if (!fallbackTarget) continue;
        stagedTargetMeta.set(`${fallbackTarget.platform}:${fallbackTarget.listingId}`, {
          platform: fallbackTarget.platform,
          listingId: fallbackTarget.listingId,
          marketplaceListingId: fallbackTarget.marketplaceListingId,
          stagedChangeId: null,
        });
      }
    }

    const successfulKeys = new Set([...stagedTargetMeta.keys()]);
    const choiceByPlatform = new Map(plan.mismatchChoices.map((choice) => [choice.platform, choice]));
    const pushItems: PushItem[] = successfulTargets.map((target) => {
      const meta = stagedTargetMeta.get(`${target.platform}:${target.listingId}`);
      const liveChoice = choiceByPlatform.get(target.platform);
      return {
        sku: row.sku,
        title: row.title,
        platform: target.platform,
        listingId: target.listingId,
        platformVariantId: target.variantId,
        stagedChangeId: meta?.stagedChangeId ?? undefined,
        masterRowId: row.id.startsWith("child-") ? row.id.replace(/^child-/, "") : row.id,
        marketplaceListingId: meta?.marketplaceListingId ?? target.marketplaceListingId ?? undefined,
        field: "upc",
        oldValue: liveChoice?.value ?? row.upc,
        newValue: plan.majorityUpc,
      };
    });

    updateRowById(plan.rowId, (current) => ({
      ...current,
      stagedUpc: plan.majorityUpc,
      hasStagedUpc: true,
      hasStagedChanges: true,
      upcPushTargets: (current.upcPushTargets ?? []).map((target) => ({
        ...target,
        stagedChangeId: successfulKeys.has(`${target.platform}:${target.listingId}`)
          ? (stagedTargetMeta.get(`${target.platform}:${target.listingId}`)?.stagedChangeId ??
            buildLocalUpcStageId(target.platform, target.listingId))
          : target.stagedChangeId ?? null,
      })),
    }));

    return {
      pushItems,
      previewItems: plan.previewItems,
      successfulTargets,
      failedCount: results.length - successfulTargets.length,
      majorityUpc: plan.majorityUpc,
      rowSku: row.sku,
    };
  }

  async function submitPushRequest(items: PushItem[], dryRun: boolean, confirmedLivePush: boolean) {
    const response = await fetch("/api/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        changes: items.map((item) => ({
          sku: item.sku,
          title: item.title,
          platform: item.platform,
          listingId: item.listingId,
          marketplaceListingId: item.marketplaceListingId,
          platformVariantId: item.platformVariantId,
          stagedChangeId: item.stagedChangeId,
          masterRowId: item.masterRowId,
          field: item.field,
          oldValue: item.oldValue,
          newValue: item.newValue,
        })),
        dryRun,
        confirmedLivePush,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok && !payload?.data) {
      throw new Error(payload?.error ?? `Push request failed (${response.status})`);
    }
    return payload.data as PushApiData;
  }

  async function startInlineFastPush(
    rowId: string,
    platform: string,
    listingId: string,
    field: PushField,
    newValue?: number | string,
  ) {
    const key = field === "upc" ? getUpcQuickPushKey(rowId) : getQuickPushKey(rowId, platform, listingId, field);
    const row = findRow(rowId);
    const pushItem = buildPushItem(row, platform, listingId, field, newValue);
    if (!pushItem) {
      showToast("No staged change was ready for fast push.");
      return;
    }

    setQuickPushState(key, { phase: "dry-run", detail: "Running dry run inline..." });

    try {
      const result = await submitPushRequest([pushItem], true, false);
      if (result.status === "blocked") {
        setQuickPushState(key, {
          phase: "blocked",
          detail: result.blockedReason ?? result.nextStep ?? result.message,
        });
        return;
      }
      await confirmInlineFastPush(rowId, platform, listingId, field, newValue);
    } catch (error) {
      setQuickPushState(key, {
        phase: "error",
        detail: error instanceof Error ? error.message : "Fast push dry run failed.",
      });
    }
  }

  async function confirmInlineFastPush(
    rowId: string,
    platform: string,
    listingId: string,
    field: PushField,
    newValue?: number | string,
  ) {
    const key = field === "upc" ? getUpcQuickPushKey(rowId) : getQuickPushKey(rowId, platform, listingId, field);
    const row = findRow(rowId);
    const pushItem = buildPushItem(row, platform, listingId, field, newValue);
    if (!pushItem) {
      clearQuickPushState(key);
      showToast("The staged change is no longer available to push.");
      return;
    }

    setQuickPushState(key, { phase: "pushing", detail: "Sending the live push..." });

    try {
      const result = await submitPushRequest([pushItem], false, true);
      if (result.status === "blocked") {
        setQuickPushState(key, {
          phase: "blocked",
          detail: result.blockedReason ?? result.nextStep ?? result.message,
        });
        return;
      }

      applyPushOutcome(result);
      if (result.summary.successfulChanges > 0) {
        setQuickPushState(key, {
          phase: "success",
          detail: result.postPushRefresh?.detail ?? "Push completed.",
        });
        scheduleQuickPushSuccessClear(key);
      } else {
        setQuickPushState(key, {
          phase: "error",
          detail: result.nextStep ?? result.message,
        });
      }
    } catch (error) {
      setQuickPushState(key, {
        phase: "error",
        detail: error instanceof Error ? error.message : "Live push failed.",
      });
    }
  }

  async function startInlineFastPushItems(key: string, items: PushItem[]) {
    if (items.length === 0) {
      showToast("No staged change was ready for fast push.");
      return;
    }

    setQuickPushState(key, { phase: "dry-run", detail: "Running dry run inline..." });

    try {
      const dryRunResult = await submitPushRequest(items, true, false);
      if (dryRunResult.status === "blocked") {
        setQuickPushState(key, {
          phase: "blocked",
          detail: dryRunResult.blockedReason ?? dryRunResult.nextStep ?? dryRunResult.message,
        });
        return;
      }

      setQuickPushState(key, { phase: "pushing", detail: "Sending the live push..." });
      const liveResult = await submitPushRequest(items, false, true);
      if (liveResult.status === "blocked") {
        setQuickPushState(key, {
          phase: "blocked",
          detail: liveResult.blockedReason ?? liveResult.nextStep ?? liveResult.message,
        });
        return;
      }

      applyPushOutcome(liveResult);
      if (liveResult.summary.successfulChanges > 0) {
        setQuickPushState(key, {
          phase: "success",
          detail: liveResult.postPushRefresh?.detail ?? "Push completed.",
        });
        scheduleQuickPushSuccessClear(key);
      } else {
        setQuickPushState(key, {
          phase: "error",
          detail: liveResult.nextStep ?? liveResult.message,
        });
      }
    } catch (error) {
      setQuickPushState(key, {
        phase: "error",
        detail: error instanceof Error ? error.message : "Live push failed.",
      });
    }
  }

  function applyPushOutcome(result: PushApiData) {
    const successful = result.results.filter((entry) => entry.success);
    void loadFailedPushes();
    if (successful.length === 0) {
      showToast(result.message);
      return;
    }

    const successMap = new Map<string, (typeof successful)[number]>();
    for (const entry of successful) {
      for (const key of buildPushResultLookupKeys(entry)) {
        successMap.set(key, entry);
      }
    }
    const successfulUpcByMasterRow = new Map<string, string>();
    const failedUpcByMasterRow = new Set<string>();

    for (const entry of result.results.filter((item) => item.field === "upc")) {
      if (!entry.masterRowId) continue;
      if (entry.success) {
        successfulUpcByMasterRow.set(entry.masterRowId, String(entry.newValue));
      } else {
        failedUpcByMasterRow.add(entry.masterRowId);
      }
    }

    function applyToRow(row: GridRow): GridRow {
      const salePrices = row.salePrices.map((entry) => {
        const pushed = buildPushResultLookupKeys({
          marketplaceListingId: entry.marketplaceListingId,
          platform: entry.platform,
          listingId: entry.listingId,
          variantId: entry.variantId,
          field: "salePrice",
        }).map((key) => successMap.get(key)).find(Boolean);
        return pushed
          ? { ...entry, value: pushed.newValue, stagedValue: undefined }
          : entry;
      });
      const adRates = row.adRates.map((entry) => {
        const pushed = buildPushResultLookupKeys({
          marketplaceListingId: entry.marketplaceListingId,
          platform: entry.platform,
          listingId: entry.listingId,
          variantId: entry.variantId,
          field: "adRate",
        }).map((key) => successMap.get(key)).find(Boolean);
        return pushed
          ? { ...entry, value: pushed.newValue, stagedValue: undefined }
          : entry;
      });
      const childRows = row.childRows?.map((child) => applyToRow(child));
      const masterRowId = row.id.startsWith("child-") ? row.id.replace(/^child-/, "") : row.id;
      const upcCompleted =
        successfulUpcByMasterRow.has(masterRowId) && !failedUpcByMasterRow.has(masterRowId);
      const updated = recalcRow({
        ...row,
        upc: upcCompleted ? successfulUpcByMasterRow.get(masterRowId) ?? row.upc : row.upc,
        stagedUpc: upcCompleted ? null : row.stagedUpc ?? null,
        hasStagedUpc: upcCompleted ? false : row.hasStagedUpc ?? false,
        upcPushTargets: upcCompleted
          ? row.upcPushTargets?.map((target) => ({ ...target, stagedChangeId: null }))
          : row.upcPushTargets,
        salePrices,
        adRates,
        childRows,
      });
      const hasChildStaged = childRows?.some((child) => child.hasStagedChanges) ?? false;
      return {
        ...updated,
        childRows,
        hasStagedChanges:
          Boolean(updated.hasStagedUpc) ||
          updated.salePrices.some((entry) => entry.stagedValue != null && entry.stagedValue !== entry.value) ||
          updated.adRates.some((entry) => entry.stagedValue != null && entry.stagedValue !== entry.value) ||
          hasChildStaged,
      };
    }

    const affectedRowIds = [...new Set(
      successful
        .map((entry) => entry.masterRowId)
        .filter((value): value is string => Boolean(value)),
    )];
    setGridRows((prev) => prev.map((row) => applyToRow(row)));
    bumpUpcLiveRefresh(affectedRowIds);
    if (affectedRowIds.length > 0) {
      void Promise.allSettled(affectedRowIds.map((rowId) => reloadRowSnapshot(rowId)));
    }

    if (result.status === "partial") {
      showToast(
        `Push partially completed — ${result.summary.successfulChanges} change${result.summary.successfulChanges === 1 ? "" : "s"} pushed, ${result.summary.failedChanges} still staged.`,
      );
      return;
    }

    showToast(
      `Live push completed — ${result.summary.successfulChanges} change${result.summary.successfulChanges === 1 ? "" : "s"} pushed successfully.`,
    );
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

  function findParentRowId(rowId: string): string | undefined {
    for (const row of gridRows) {
      if (row.childRows?.some((child) => child.id === rowId)) {
        return row.id;
      }
    }
    return undefined;
  }

  async function reloadRowSnapshot(rowId: string) {
    const response = await fetch(`/api/grid/${rowId}?ts=${Date.now()}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error ?? `Failed to reload row ${rowId} (${response.status})`);
    }

    const refreshedRow = (payload?.data?.row ?? null) as GridRow | null;
    if (!refreshedRow) {
      throw new Error(`Row snapshot for ${rowId} was missing from the response.`);
    }

    applyRefreshedRowSnapshot(rowId, refreshedRow, findParentRowId(rowId));
  }

  function fmtDollar(v: number | null): string {
    return v != null ? `$${v.toFixed(2)}` : "—";
  }

  function valuesMatch(a: number | string | null | undefined, b: number | string | null | undefined) {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    if (typeof a === "string" || typeof b === "string") {
      return String(a) === String(b);
    }
    return Math.abs(Number(a) - Number(b)) < 0.000001;
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

  function persistStageAction(
    sku: string,
    platform: string,
    listingId: string,
    action: string,
    newPrice?: number,
    field?: PushField,
  ) {
    return fetch("/api/grid/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, sku, platform, listingId, newPrice, field }),
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

  function handleSalePriceEdit(rowId: string, platform: string, listingId: string, newPrice: number, mode: "stage" | "push" | "fastPush") {
    const row = findRow(rowId);
    const sku = row?.sku ?? rowId;
    const platLabel = PLATFORM_SHORT[platform as keyof typeof PLATFORM_SHORT] ?? platform;
    const oldSp = row?.salePrices.find((sp) => sp.platform === platform && sp.listingId === listingId);
    const liveValue = oldSp?.value != null ? Number(oldSp.value) : null;
    const effectiveValue = oldSp?.stagedValue != null ? Number(oldSp.stagedValue) : liveValue;
    const oldVal = oldSp ? fmtDollar(Number(oldSp.stagedValue ?? oldSp.value)) : "—";

    if (valuesMatch(effectiveValue, newPrice)) {
      showToast(`No price change - SKU ${sku} (${platLabel}) is already ${fmtDollar(newPrice)}`);
      return;
    }

    if (valuesMatch(liveValue, newPrice)) {
      updateRowById(rowId, (r) => {
        const newSalePrices = r.salePrices.map((sp) =>
          sp.platform === platform && sp.listingId === listingId
            ? { ...sp, stagedValue: undefined }
            : sp,
        );
        const updated = { ...r, salePrices: newSalePrices };
        return recalcRow(updated);
      });
      void persistStageAction(sku, platform, listingId, "discard");
      showToast(`No staging needed - SKU ${sku} (${platLabel}) already matches the live price ${fmtDollar(newPrice)}`);
      return;
    }

    if (mode === "fastPush") {
      updateRowById(rowId, (r) => {
        const newSalePrices = r.salePrices.map((sp) =>
          sp.platform === platform && sp.listingId === listingId
            ? { ...sp, stagedValue: newPrice }
            : sp,
        );
        const updated = { ...r, salePrices: newSalePrices };
        return recalcRow(updated);
      });
      void persistStageAction(sku, platform, listingId, "stage", newPrice);
      clearQuickPushState(getQuickPushKey(rowId, platform, listingId, "salePrice"));
      void startInlineFastPush(rowId, platform, listingId, "salePrice", newPrice);
      showToast(`Fast push started - SKU ${sku} (${platLabel}) from ${oldVal} to ${fmtDollar(newPrice)}`);
      return;
    }

    updateRowById(rowId, (r) => {
      const newSalePrices = r.salePrices.map((sp) => {
        if (sp.platform === platform && sp.listingId === listingId) {
          return { ...sp, stagedValue: newPrice };
        }
        return sp;
      });
      const updated = { ...r, salePrices: newSalePrices };
      return recalcRow(updated);
    });
    void persistStageAction(sku, platform, listingId, "stage", newPrice);

    if (mode === "push") {
      clearQuickPushState(getQuickPushKey(rowId, platform, listingId, "salePrice"));
      const pushItem = buildPushItem(row, platform, listingId, "salePrice", newPrice);
      queuePushReview(pushItem ? [pushItem] : [], "review");
      showToast(
        false
          ? `Fast push check started - SKU ${sku} (${platLabel}) from ${oldVal} to ${fmtDollar(newPrice)}`
          : `Price staged for push review — SKU ${sku} (${platLabel}) from ${oldVal} to ${fmtDollar(newPrice)}`,
      );
      return;
    }

    showToast(`Price Staged — SKU ${sku} (${platLabel}) from ${oldVal} to ${fmtDollar(newPrice)}`);
  }

  function handleSalePriceBulkEdit(rowId: string, newPrice: number, mode: "stage" | "push") {
    const row = findRow(rowId);
    if (!row) return;

    const sku = row.sku;
    const actionableEntries = row.salePrices.filter((entry) => !valuesMatch(entry.value, newPrice));
    const stageWrites: Array<{ platform: string; listingId: string; newPrice: number }> = [];
    const discardWrites: Array<{ platform: string; listingId: string }> = [];

    updateRowById(rowId, (current) => {
      const nextSalePrices = current.salePrices.map((entry) => {
        const liveValue = entry.value != null ? Number(entry.value) : null;
        const stagedValue = entry.stagedValue != null ? Number(entry.stagedValue) : null;

        if (valuesMatch(liveValue, newPrice)) {
          if (stagedValue != null && !valuesMatch(stagedValue, liveValue)) {
            discardWrites.push({ platform: entry.platform, listingId: entry.listingId });
            return { ...entry, stagedValue: undefined };
          }
          return entry;
        }

        if (!valuesMatch(stagedValue, newPrice)) {
          stageWrites.push({ platform: entry.platform, listingId: entry.listingId, newPrice });
        }

        return { ...entry, stagedValue: newPrice };
      });

      return recalcRow({ ...current, salePrices: nextSalePrices });
    });

    void Promise.allSettled([
      ...stageWrites.map((item) =>
        persistStageAction(sku, item.platform, item.listingId, "stage", item.newPrice),
      ),
      ...discardWrites.map((item) =>
        persistStageAction(sku, item.platform, item.listingId, "discard"),
      ),
    ]);

    const pushItems = actionableEntries
      .map((entry) => buildPushItem(row, entry.platform, entry.listingId, "salePrice", newPrice))
      .filter((item): item is PushItem => Boolean(item));

    if (pushItems.length === 0) {
      showToast(`No sale price changes were needed for SKU ${sku}.`);
      return;
    }

    if (mode === "push") {
      queuePushReview(pushItems, "review");
      showToast(
        `Sale price review ready â€” SKU ${sku} across ${pushItems.length} marketplace${pushItems.length === 1 ? "" : "s"}.`,
      );
      return;
    }

    showToast(
      `Sale price staged â€” SKU ${sku} across ${pushItems.length} marketplace${pushItems.length === 1 ? "" : "s"}.`,
    );
  }

  function handleAdRateEdit(rowId: string, platform: string, listingId: string, newRate: number, mode: "stage" | "push" | "fastPush") {
    const row = findRow(rowId);
    const sku = row?.sku ?? rowId;
    const platLabel = PLATFORM_SHORT[platform as keyof typeof PLATFORM_SHORT] ?? platform;
    const oldAr = row?.adRates.find((a) => a.platform === platform && a.listingId === listingId);
    const liveValue = oldAr?.value != null ? Number(oldAr.value) : null;
    const effectiveValue = oldAr?.stagedValue != null ? Number(oldAr.stagedValue) : liveValue;
    const fmtPct = (v: number | null | undefined) => v != null ? `${(Number(v) * 100).toFixed(1)}%` : "N/A";
    const oldVal = fmtPct(oldAr ? Number(oldAr.stagedValue ?? oldAr.value) : null);

    if (valuesMatch(effectiveValue, newRate)) {
      showToast(`No ad rate change - SKU ${sku} (${platLabel}) is already ${fmtPct(newRate)}`);
      return;
    }

    if (valuesMatch(liveValue, newRate)) {
      updateRowById(rowId, (r) => {
        const newAdRates = r.adRates.map((ar) =>
          ar.platform === platform && ar.listingId === listingId
            ? { ...ar, stagedValue: undefined }
            : ar,
        );
        const updated = { ...r, adRates: newAdRates };
        return recalcRow(updated);
      });
      void persistAdRateAction(sku, platform, listingId, "discard");
      showToast(`No staging needed - SKU ${sku} (${platLabel}) already matches the live ad rate ${fmtPct(newRate)}`);
      return;
    }

    if (mode === "fastPush") {
      updateRowById(rowId, (r) => {
        const newAdRates = r.adRates.map((ar) =>
          ar.platform === platform && ar.listingId === listingId
            ? { ...ar, stagedValue: newRate }
            : ar,
        );
        const updated = { ...r, adRates: newAdRates };
        return recalcRow(updated);
      });
      void persistAdRateAction(sku, platform, listingId, "stage", newRate);
      clearQuickPushState(getQuickPushKey(rowId, platform, listingId, "adRate"));
      void startInlineFastPush(rowId, platform, listingId, "adRate", newRate);
      showToast(`Fast push started - SKU ${sku} (${platLabel}) from ${oldVal} to ${fmtPct(newRate)}`);
      return;
    }

    updateRowById(rowId, (r) => {
      const newAdRates = r.adRates.map((ar) => {
        if (ar.platform === platform && ar.listingId === listingId) {
          return { ...ar, stagedValue: newRate };
        }
        return ar;
      });
      const updated = { ...r, adRates: newAdRates };
      return recalcRow(updated);
    });
    void persistAdRateAction(sku, platform, listingId, "stage", newRate);

    if (mode === "push") {
      clearQuickPushState(getQuickPushKey(rowId, platform, listingId, "adRate"));
      const pushItem = buildPushItem(row, platform, listingId, "adRate", newRate);
      queuePushReview(pushItem ? [pushItem] : [], "review");
      showToast(
        false
          ? `Fast push check started - SKU ${sku} (${platLabel}) from ${oldVal} to ${fmtPct(newRate)}`
          : `Ad rate staged for push review — SKU ${sku} (${platLabel}) from ${oldVal} to ${fmtPct(newRate)}`,
      );
      return;
    }

    showToast(`Ad Rate Staged — SKU ${sku} (${platLabel}) from ${oldVal} to ${fmtPct(newRate)}`);
  }

  function handlePushStagedAdRate(rowId: string, platform: string, listingId: string, launchMode: PushLaunchMode = "review") {
    const row = findRow(rowId);
    const sku = row?.sku ?? rowId;
    const platLabel = PLATFORM_SHORT[platform as keyof typeof PLATFORM_SHORT] ?? platform;
    const adRate = row?.adRates.find((rate) => rate.platform === platform && rate.listingId === listingId);
    const stagedVal = adRate?.stagedValue != null ? `${(Number(adRate.stagedValue) * 100).toFixed(1)}%` : "—";
    if (launchMode === "fast") {
      clearQuickPushState(getQuickPushKey(rowId, platform, listingId, "adRate"));
      void startInlineFastPush(rowId, platform, listingId, "adRate");
    } else {
      const pushItem = buildPushItem(row, platform, listingId, "adRate");
      queuePushReview(pushItem ? [pushItem] : [], launchMode);
    }
    showToast(
      launchMode === "fast"
        ? `Fast push check started - SKU ${sku} (${platLabel}) ${stagedVal}`
        : `Reviewing staged ad rate push — SKU ${sku} (${platLabel}) ${stagedVal}`,
    );
  }

  async function handleDiscardStagedAdRate(rowId: string, platform: string, listingId: string) {
    const row = findRow(rowId);
    const sku = row?.sku ?? rowId;
    const platLabel = PLATFORM_SHORT[platform as keyof typeof PLATFORM_SHORT] ?? platform;
    const adRate = row?.adRates.find((rate) => rate.platform === platform && rate.listingId === listingId);
    const stagedVal = adRate?.stagedValue != null ? `${(Number(adRate.stagedValue) * 100).toFixed(1)}%` : "—";
    const liveVal = adRate?.value != null ? `${(Number(adRate.value) * 100).toFixed(1)}%` : "N/A";

    updateRowById(rowId, (r) => {
      const newAdRates = r.adRates.map((rate) => {
        if (rate.platform === platform && rate.listingId === listingId) {
          return { ...rate, stagedValue: undefined };
        }
        return rate;
      });
      return recalcRow({ ...r, adRates: newAdRates });
    });

    try {
      await persistAdRateAction(sku, platform, listingId, "discard");
      await reloadRowSnapshot(rowId);
    } catch (error) {
      console.error("Failed to discard staged ad rate:", error);
      showToast(`Discard failed — SKU ${sku} (${platLabel}) could not be reloaded.`);
      return;
    }

    clearQuickPushState(getQuickPushKey(rowId, platform, listingId, "adRate"));
    showToast(`Staged Ad Rate Discarded — SKU ${sku} (${platLabel}) reverted from ${stagedVal} to ${liveVal}`);
  }

  function persistAdRateAction(sku: string, platform: string, listingId: string, action: string, newRate?: number) {
    return fetch("/api/grid/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, sku, platform, listingId, newPrice: newRate, field: "adRate" }),
    }).catch((err) => console.error("Failed to persist ad rate action:", err));
  }

  function handlePushStaged(rowId: string, platform: string, listingId: string, launchMode: PushLaunchMode = "review") {
    const row = findRow(rowId);
    const sku = row?.sku ?? rowId;
    const platLabel = PLATFORM_SHORT[platform as keyof typeof PLATFORM_SHORT] ?? platform;
    const sp = row?.salePrices.find((s) => s.platform === platform && s.listingId === listingId);
    const stagedVal = sp?.stagedValue != null ? fmtDollar(Number(sp.stagedValue)) : "—";
    if (launchMode === "fast") {
      clearQuickPushState(getQuickPushKey(rowId, platform, listingId, "salePrice"));
      void startInlineFastPush(rowId, platform, listingId, "salePrice");
    } else {
      const pushItem = buildPushItem(row, platform, listingId, "salePrice");
      queuePushReview(pushItem ? [pushItem] : [], launchMode);
    }
    showToast(
      launchMode === "fast"
        ? `Fast push check started - SKU ${sku} (${platLabel}) ${stagedVal}`
        : `Reviewing staged price push — SKU ${sku} (${platLabel}) ${stagedVal}`,
    );
  }

  async function handleDiscardStaged(rowId: string, platform: string, listingId: string) {
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

    try {
      await persistStageAction(sku, platform, listingId, "discard");
      await reloadRowSnapshot(rowId);
    } catch (error) {
      console.error("Failed to discard staged price:", error);
      showToast(`Discard failed — SKU ${sku} (${platLabel}) could not be reloaded.`);
      return;
    }

    clearQuickPushState(getQuickPushKey(rowId, platform, listingId, "salePrice"));
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

  function collectBulkUpcRows(rows: GridRow[]): GridRow[] {
    const collected: GridRow[] = [];
    for (const row of rows) {
      if (!row.isParent) {
        collected.push(row);
      }
      if (row.childRows?.length) {
        collected.push(...collectBulkUpcRows(row.childRows));
      }
    }
    return collected;
  }

  function closeBulkUpcModal() {
    setBulkUpcOpen(false);
    setBulkUpcLoading(false);
    setBulkUpcSubmitting(null);
    setBulkUpcCandidates([]);
    setBulkUpcSelectedIds(new Set());
  }

  async function openBulkUpcModal() {
    setBulkUpcOpen(true);
    setBulkUpcLoading(true);
    setBulkUpcSubmitting(null);
    setBulkUpcCandidates([]);
    setBulkUpcSelectedIds(new Set());

    const rowsToScan = collectBulkUpcRows(filteredRows);
    try {
      const choicesByRowId = await fetchBulkLiveUpcChoices(rowsToScan.map((row) => row.id));
      const results: Array<BulkMatchUpcCandidate | null> = [];
      let skippedCount = 0;

      for (const row of rowsToScan) {
        const choices = choicesByRowId.get(row.id);
        if (!choices) {
          skippedCount += 1;
          continue;
        }

        let planResult = buildMatchUpcPlan(row, choices);
        if (!planResult.ok && planResult.canMatchAnyway) {
          planResult = buildMatchUpcPlan(row, choices, { allowSingleSource: true });
        }
        if (!planResult.ok) {
          continue;
        }

        const { plan } = planResult;
        const note =
          plan.lockedMismatchChoices.length > 0
            ? `Locked now: ${plan.lockedMismatchChoices.map((choice) => choice.label).join(", ")}.`
            : null;

        results.push({
          id: row.id,
          sku: row.sku,
          title: row.title,
          majorityUpc: plan.majorityUpc,
          modeLabel: plan.allowSingleSource ? "Fill blank UPCs" : "Match minority UPCs",
          sourceChoices: plan.sourceChoices,
          mismatchChoices: plan.mismatchChoices,
          actionableCount: plan.stageTargets.length,
          previewCount: plan.previewItems.length,
          lockedCount: plan.lockedMismatchChoices.length,
          note,
          plan,
        } satisfies BulkMatchUpcCandidate);
      }

      const candidates = results
        .filter((candidate): candidate is BulkMatchUpcCandidate => Boolean(candidate))
        .sort((a, b) => a.title.localeCompare(b.title) || a.sku.localeCompare(b.sku));

      setBulkUpcCandidates(candidates);
      setBulkUpcSelectedIds(new Set(candidates.map((candidate) => candidate.id)));
      if (skippedCount > 0) {
        showToast(`Bulk Match UPC skipped ${skippedCount} rows that could not be read right now.`);
      }
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Bulk Match UPC could not load the current grid.",
      );
      setBulkUpcCandidates([]);
      setBulkUpcSelectedIds(new Set());
    } finally {
      setBulkUpcLoading(false);
    }
  }

  async function runBulkUpcAction(mode: "stage" | "review" | "fast") {
    if (bulkUpcSelectedCandidates.length === 0) {
      showToast("Select at least one row to bulk match UPCs.");
      return;
    }

    setBulkUpcSubmitting(mode);
    const allPushItems: PushItem[] = [];
    const allPreviewItems: PushItem[] = [];
    let stagedRows = 0;
    let failedRows = 0;
    let stagedTargets = 0;

    for (const candidate of bulkUpcSelectedCandidates) {
      const staged = await stageMatchUpcPlan(candidate.plan);
      if (!staged) {
        failedRows += 1;
        continue;
      }

      stagedRows += 1;
      stagedTargets += staged.successfulTargets.length;
      allPushItems.push(...staged.pushItems);
      allPreviewItems.push(...staged.previewItems);
    }

    setBulkUpcSubmitting(null);

    if (allPushItems.length === 0) {
      showToast("Bulk Match UPC could not stage any rows.");
      return;
    }

    closeBulkUpcModal();

    if (mode === "fast") {
      void startInlineFastPushItems(`bulk-upc:${Date.now()}`, allPushItems);
      showToast(
        failedRows > 0
          ? `Bulk Match UPC fast push started for ${stagedRows} rows. ${failedRows} rows could not be staged.`
          : `Bulk Match UPC fast push started for ${stagedRows} rows.`,
      );
      return;
    }

    if (mode === "review") {
      queuePushReview(allPushItems, "review", allPreviewItems);
      showToast(
        failedRows > 0
          ? `Bulk Match UPC queued ${stagedTargets} staged marketplace changes for review. ${failedRows} rows could not be staged.`
          : `Bulk Match UPC queued ${stagedTargets} staged marketplace changes for review.`,
      );
      return;
    }

    showToast(
      failedRows > 0
        ? `Bulk Match UPC staged ${stagedTargets} marketplace changes across ${stagedRows} rows. ${failedRows} rows could not be staged.`
        : `Bulk Match UPC staged ${stagedTargets} marketplace changes across ${stagedRows} rows.`,
    );
  }

  function handlePushStagedUpc(
    rowId: string,
    launchMode: PushLaunchMode = "review",
    targetPlatform?: string,
    targetListingId?: string,
  ) {
    const row = findRow(rowId);
    if (!row || row.isParent || !row.hasStagedUpc || !row.stagedUpc) {
      showToast("No staged UPC is ready to push on this row.");
      return;
    }

    let pushItems = buildUpcPushItems(row);
    if (targetPlatform && targetListingId) {
      pushItems = pushItems.filter(
        (item) => item.platform === targetPlatform && item.listingId === targetListingId,
      );
    }
    if (pushItems.length === 0) {
      showToast("This row has no supported marketplace UPC targets to push.");
      return;
    }

    if (launchMode === "fast") {
      clearQuickPushState(getUpcQuickPushKey(rowId));
      void startInlineFastPushItems(getUpcQuickPushKey(rowId), pushItems);
    } else {
      queuePushReview(pushItems, "review");
    }

    showToast(
      launchMode === "fast"
        ? `Fast push started for staged UPC on SKU ${row.sku}.`
        : `Reviewing staged UPC push for SKU ${row.sku}.`,
    );
  }

  function handleDiscardStagedUpc(rowId: string) {
    const row = findRow(rowId);
    if (!row || !row.hasStagedUpc) {
      showToast("No staged UPC is waiting on this row.");
      return;
    }

    updateRowById(rowId, (current) => ({
      ...current,
      stagedUpc: null,
      hasStagedUpc: false,
      upcPushTargets: (current.upcPushTargets ?? []).map((target) => ({
        ...target,
        stagedChangeId: null,
      })),
      hasStagedChanges:
        current.salePrices.some((entry) => entry.stagedValue != null && entry.stagedValue !== entry.value) ||
        current.adRates.some((entry) => entry.stagedValue != null && entry.stagedValue !== entry.value),
    }));

    void persistUpcAction(row.sku, "discard");

    clearQuickPushState(getUpcQuickPushKey(rowId));
    showToast(`Staged UPC discarded for SKU ${row.sku}.`);
  }

  function handleDiscardStagedUpcTarget(rowId: string, platform: string, listingId: string) {
    const row = findRow(rowId);
    if (!row || !row.hasStagedUpc) {
      showToast("No staged UPC is waiting on this row.");
      return;
    }

    const targetKey = `${platform}:${listingId}`;
    updateRowById(rowId, (current) => {
      const nextTargets = (current.upcPushTargets ?? []).map((target) =>
        target.platform === platform && target.listingId === listingId
          ? { ...target, stagedChangeId: null }
          : target,
      );
      const hasRemainingStage = nextTargets.some((target) => Boolean(target.stagedChangeId));
      return {
        ...current,
        stagedUpc: hasRemainingStage ? current.stagedUpc : null,
        hasStagedUpc: hasRemainingStage,
        hasStagedChanges:
          hasRemainingStage ||
          current.salePrices.some((entry) => entry.stagedValue != null && entry.stagedValue !== entry.value) ||
          current.adRates.some((entry) => entry.stagedValue != null && entry.stagedValue !== entry.value),
        upcPushTargets: nextTargets,
      };
    });

    void persistUpcAction(row.sku, "discard", undefined, { platform, listingId });

    clearQuickPushState(getUpcQuickPushKey(rowId));
    showToast(`Staged UPC discarded for ${PLATFORM_SHORT[platform as Platform]} on SKU ${row.sku}.`);
  }

  function persistUpcAction(
    sku: string,
    action: string,
    newUpc?: string,
    target?: { platform?: string; listingId?: string },
  ) {
    return fetch("/api/grid/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, sku, field: "upc", newValue: newUpc, ...target }),
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | { data?: unknown }
          | null;

        if (!response.ok) {
          const message =
            payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
              ? payload.error
              : `UPC ${action} request failed with status ${response.status}`;
          throw new Error(message);
        }

        return payload;
      })
      .catch((err) => {
        console.error("Failed to persist UPC action:", err);
        throw err;
      });
  }

  function handleUpcEdit(
    rowId: string,
    newUpc: string,
    mode: "stage" | "push" | "fastPush",
    targetSelection?: { platform: string; listingId: string; currentValue?: string | null },
  ) {
    const row = findRow(rowId);
    if (!row || row.isParent) {
      showToast("UPC can only be edited on a single row or child row.");
      return;
    }

    const normalizedUpc = newUpc.trim();
    const liveUpc = targetSelection
      ? (targetSelection.currentValue?.trim() ?? "")
      : (row.upc?.trim() ?? "");

    if (!normalizedUpc) {
      showToast(`UPC cannot be blank for SKU ${row.sku}.`);
      return;
    }

    const selectedTargets = (row.upcPushTargets ?? []).filter((target) => {
      if (!targetSelection) return true;
      return (
        target.platform === targetSelection.platform &&
        target.listingId === targetSelection.listingId
      );
    });

    if (targetSelection && selectedTargets.length === 0) {
      showToast(`No supported ${targetSelection.platform} UPC target was found for SKU ${row.sku}.`);
      return;
    }

    const hasTargetStage = targetSelection
      ? selectedTargets.some((target) => Boolean(target.stagedChangeId))
      : Boolean(row.hasStagedUpc);
    const effectiveUpc = hasTargetStage ? (row.stagedUpc?.trim() ?? liveUpc) : liveUpc;

    if (valuesMatch(effectiveUpc, normalizedUpc)) {
      showToast(`No UPC change - SKU ${row.sku} is already ${normalizedUpc}.`);
      return;
    }

    if (valuesMatch(liveUpc, normalizedUpc)) {
      if (targetSelection) {
        void handleDiscardStagedUpcTarget(rowId, targetSelection.platform, targetSelection.listingId);
      } else {
        void handleDiscardStagedUpc(rowId);
      }
      return;
    }

    const pushItems = selectedTargets
      .map((target) => buildPushItem(row, target.platform, target.listingId, "upc", normalizedUpc))
      .filter((item): item is PushItem => Boolean(item));

    updateRowById(rowId, (current) => ({
      ...current,
      stagedUpc: normalizedUpc,
      hasStagedUpc: true,
      hasStagedChanges: true,
      upcPushTargets: (current.upcPushTargets ?? []).map((target) => ({
        ...target,
        stagedChangeId:
          selectedTargets.some(
            (selected) =>
              selected.platform === target.platform && selected.listingId === target.listingId,
          )
            ? buildLocalUpcStageId(target.platform, target.listingId)
            : null,
      })),
    }));
    void persistUpcAction(row.sku, "stage", normalizedUpc, targetSelection);

    if (mode === "fastPush") {
      clearQuickPushState(getUpcQuickPushKey(rowId));
      void startInlineFastPushItems(getUpcQuickPushKey(rowId), pushItems);
      showToast(`Fast push started - SKU ${row.sku} UPC from ${row.upc ?? "No UPC"} to ${normalizedUpc}`);
      return;
    }

    if (mode === "push") {
      queuePushReview(pushItems, "review");
      showToast(`UPC staged for push review - SKU ${row.sku} from ${row.upc ?? "No UPC"} to ${normalizedUpc}`);
      return;
    }

    showToast(`UPC Staged - SKU ${row.sku} from ${row.upc ?? "No UPC"} to ${normalizedUpc}`);
  }

  async function handleMatchUpc(
    rowId: string,
    choices: LiveUpcChoice[],
    mode: "stage" | "push" | "fastPush",
    options?: { allowSingleSource?: boolean },
  ) {
    const row = findRow(rowId);
    if (!row || row.isParent) {
      showToast("Match UPC can only be used on a single row or child row.");
      return;
    }
    const planResult = buildMatchUpcPlan(row, choices, options);
    if (!planResult.ok) {
      showToast(planResult.message);
      return;
    }

    const staged = await stageMatchUpcPlan(planResult.plan);
    if (!staged) {
      showToast(`Match UPC could not stage any UPC changes for SKU ${row.sku}.`);
      return;
    }

    const failedCount = staged.failedCount;
    const successLabel =
      staged.successfulTargets.length === 1
        ? "1 marketplace UPC"
        : `${staged.successfulTargets.length} marketplace UPCs`;

    if (mode === "fastPush") {
      clearQuickPushState(getUpcQuickPushKey(rowId));
      void startInlineFastPushItems(getUpcQuickPushKey(rowId), staged.pushItems);
      showToast(`Match UPC fast push started for SKU ${row.sku} to ${staged.majorityUpc}.`);
      return;
    }

    if (mode === "push") {
      queuePushReview(staged.pushItems, "review", staged.previewItems);
      showToast(`Match UPC staged and queued for push review on SKU ${row.sku} to ${staged.majorityUpc}.`);
      return;
    }

    showToast(
      failedCount > 0
        ? `Match UPC staged ${successLabel} to ${staged.majorityUpc}, but ${failedCount} marketplace ${failedCount === 1 ? "request failed" : "requests failed"}.`
        : `Match UPC staged ${successLabel} to ${staged.majorityUpc} for SKU ${row.sku}.`,
    );
  }

  useEffect(() => {
    const needsChildHydration =
      filters.stagedOnly ||
      filters.stockStatus === "low_stock" ||
      filters.stockStatus === "out_of_stock";

    if (!needsChildHydration) return;

    const targetParents = gridRows.filter((row) => {
      if (!row.isParent || row.childRowsHydrated || !row.childRows?.length) {
        return false;
      }

      if (filters.stagedOnly && row.childRows.some((child) => child.hasStagedChanges)) {
        return true;
      }

      if (filters.stockStatus === "low_stock") {
        return row.childRows.some((child) => child.inventory != null && child.inventory > 0 && child.inventory < 25);
      }

      if (filters.stockStatus === "out_of_stock") {
        return row.childRows.some((child) => child.inventory === 0);
      }

      return false;
    });

    if (targetParents.length === 0) return;

    void Promise.all(targetParents.map((row) => ensureChildRowsLoaded(row.id)));
  }, [filters.stagedOnly, filters.stockStatus, gridRows]);

  useEffect(() => {
    const expandedParentsNeedingHydration = gridRows.filter(
      (row) =>
        row.isParent &&
        expandedRows.has(row.id) &&
        !row.childRowsHydrated &&
        Boolean(row.childRows?.length),
    );

    if (expandedParentsNeedingHydration.length === 0) return;

    void Promise.all(expandedParentsNeedingHydration.map((row) => ensureChildRowsLoaded(row.id)));
  }, [expandedRows, gridRows]);

  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowEstimate,
    overscan: 5,
    getItemKey: (index) => flatRows[index]?.id ?? index,
  });

  useEffect(() => {
    if (!pendingScrollRowId) return;
    const index = flatRows.findIndex((row) => row.id === pendingScrollRowId);
    if (index < 0) return;
    rowVirtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
    setTimeout(() => highlightRow(pendingScrollRowId), 300);
    setPendingScrollRowId(null);
  }, [flatRows, pendingScrollRowId, rowVirtualizer]);

  async function toggleExpand(rowId: string) {
    if (expandedRows.has(rowId)) {
      setExpandedRows((prev) => {
        const next = new Set(prev);
        next.delete(rowId);
        return next;
      });
      return;
    }

    const loaded = await ensureChildRowsLoaded(rowId);
    if (!loaded) return;

    setExpandedRows((prev) => new Set([...prev, rowId]));
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

  async function scrollToRow(rowId: string) {
    const idx = flatRows.findIndex((r) => r.id === rowId);
    if (idx >= 0) {
      rowVirtualizer.scrollToIndex(idx, { align: "center", behavior: "smooth" });
      setTimeout(() => highlightRow(rowId), 300);
      return;
    }
    for (const r of gridRows) {
      if (r.childRows?.find((c) => c.id === rowId)) {
        const loaded = await ensureChildRowsLoaded(r.id);
        if (!loaded) return;
        setExpandedRows((prev) => new Set([...prev, r.id]));
        setPendingScrollRowId(rowId);
        break;
      }
    }
  }

  function isColVisible(id: string) {
    return columns.find((c) => c.id === id)?.visible ?? true;
  }

  const [clearStagedOpen, setClearStagedOpen] = useState(false);
  const [clearStagedInput, setClearStagedInput] = useState("");
  const failedPushCount = failedPushes.length;
  const failedPushStates = useMemo(() => {
    const failuresByComposite = new Map<string, FailedPushItem[]>();
    for (const failure of failedPushes) {
      const compositeKey = `${failure.masterRowId}:${failure.platform}:${failure.listingId}:${failure.field}`;
      const existing = failuresByComposite.get(compositeKey) ?? [];
      existing.push(failure);
      failuresByComposite.set(compositeKey, existing);
    }

    const storeStates: Record<string, FailedPushState | undefined> = {};
    const upcStates: Record<string, Record<string, FailedPushState | undefined>> = {};

    function collect(row: GridRow) {
      const masterRowId = row.id.startsWith("child-") ? row.id.replace(/^child-/, "") : row.id;

      for (const item of row.salePrices) {
        if (item.stagedValue == null || valuesMatch(item.stagedValue, item.value)) continue;
        const match = (failuresByComposite.get(`${masterRowId}:${item.platform}:${item.listingId}:salePrice`) ?? []).find(
          (failure) => valuesMatch(failure.newValue, item.stagedValue),
        );
        if (match) {
          storeStates[getQuickPushKey(row.id, item.platform, item.listingId, "salePrice")] = {
            summary: match.failureSummary,
            error: match.error,
          };
        }
      }

      for (const item of row.adRates) {
        if (item.stagedValue == null || valuesMatch(item.stagedValue, item.value)) continue;
        const match = (failuresByComposite.get(`${masterRowId}:${item.platform}:${item.listingId}:adRate`) ?? []).find(
          (failure) => valuesMatch(failure.newValue, item.stagedValue),
        );
        if (match) {
          storeStates[getQuickPushKey(row.id, item.platform, item.listingId, "adRate")] = {
            summary: match.failureSummary,
            error: match.error,
          };
        }
      }

      if (row.hasStagedUpc && row.stagedUpc && row.upcPushTargets?.length) {
        const rowUpcStates: Record<string, FailedPushState | undefined> = {};
        for (const target of row.upcPushTargets) {
          if (!target.stagedChangeId) continue;
          const match = (failuresByComposite.get(`${masterRowId}:${target.platform}:${target.listingId}:upc`) ?? []).find(
            (failure) => valuesMatch(failure.newValue, row.stagedUpc),
          );
          if (match) {
            rowUpcStates[`${target.platform}:${target.listingId}`] = {
              summary: match.failureSummary,
              error: match.error,
            };
          }
        }
        if (Object.keys(rowUpcStates).length > 0) {
          upcStates[row.id] = rowUpcStates;
        }
      }

      for (const child of row.childRows ?? []) {
        collect(child);
      }
    }

    for (const row of gridRows) {
      collect(row);
    }

    return { storeStates, upcStates };
  }, [failedPushes, gridRows]);

  const stagedCount = useMemo(() => {
    let count = 0;
    for (const row of gridRows) {
      for (const sp of row.salePrices) {
        if (sp.stagedValue != null && sp.stagedValue !== sp.value) count++;
      }
      for (const ar of row.adRates) {
        if (ar.stagedValue != null && ar.stagedValue !== ar.value) count++;
      }
      if (row.hasStagedUpc && row.stagedUpc && row.stagedUpc !== row.upc) {
        count++;
      }
      if (row.childRows) {
        for (const child of row.childRows) {
          for (const sp of child.salePrices) {
            if (sp.stagedValue != null && sp.stagedValue !== sp.value) count++;
          }
          for (const ar of child.adRates) {
            if (ar.stagedValue != null && ar.stagedValue !== ar.value) count++;
          }
          if (child.hasStagedUpc && child.stagedUpc && child.stagedUpc !== child.upc) {
            count++;
          }
        }
      }
    }
    return count;
  }, [gridRows]);

  function reviewAllStagedValues() {
    const pushItems: PushItem[] = [];
    const seenKeys = new Set<string>();

    const appendItem = (item: PushItem | null) => {
      if (!item) return;
      const key = `${item.platform}:${item.listingId}:${item.platformVariantId ?? ""}:${item.field}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      pushItems.push(item);
    };

    const collectRow = (row: GridRow) => {
      for (const salePrice of row.salePrices) {
        if (salePrice.stagedValue != null && salePrice.stagedValue !== salePrice.value) {
          appendItem(buildPushItem(row, salePrice.platform, salePrice.listingId, "salePrice"));
        }
      }

      for (const adRate of row.adRates) {
        if (adRate.stagedValue != null && adRate.stagedValue !== adRate.value) {
          appendItem(buildPushItem(row, adRate.platform, adRate.listingId, "adRate"));
        }
      }

      for (const upcItem of buildUpcPushItems(row)) {
        appendItem(upcItem);
      }

      for (const child of row.childRows ?? []) {
        collectRow(child);
      }
    };

    for (const row of gridRows) {
      collectRow(row);
    }

    if (pushItems.length === 0) {
      showToast("No staged values are ready for review push.");
      return;
    }

    queuePushReview(pushItems, "review");
    showToast(`Queued ${pushItems.length} staged marketplace changes for review.`);
  }

  function handleClearAllStaged() {
    setGridRows((prev) =>
      prev.map((row) => {
        const newSalePrices = row.salePrices.map((sp) => ({ ...sp, stagedValue: undefined }));
        const newAdRates = row.adRates.map((ar) => ({ ...ar, stagedValue: undefined }));
        let newChildren = row.childRows;
        if (newChildren) {
          newChildren = newChildren.map((child) => {
            const cPrices = child.salePrices.map((sp) => ({ ...sp, stagedValue: undefined }));
            const cAdRates = child.adRates.map((ar) => ({ ...ar, stagedValue: undefined }));
            return recalcRowStatic(
              {
                ...child,
                salePrices: cPrices,
                adRates: cAdRates,
                stagedUpc: null,
                hasStagedUpc: false,
                hasStagedChanges: false,
              },
              globalFeeRate,
            );
          });
        }
        return recalcRowStatic(
          {
            ...row,
            salePrices: newSalePrices,
            adRates: newAdRates,
            stagedUpc: null,
            hasStagedUpc: false,
            hasStagedChanges: false,
            childRows: newChildren ?? row.childRows,
          },
          globalFeeRate,
        );
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
  const [bulkUpcOpen, setBulkUpcOpen] = useState(false);
  const [bulkUpcLoading, setBulkUpcLoading] = useState(false);
  const [bulkUpcSubmitting, setBulkUpcSubmitting] = useState<"stage" | "review" | "fast" | null>(null);
  const [bulkUpcCandidates, setBulkUpcCandidates] = useState<BulkMatchUpcCandidate[]>([]);
  const [bulkUpcSelectedIds, setBulkUpcSelectedIds] = useState<Set<string>>(new Set());
  const bulkUpcSelectedCandidates = useMemo(
    () => bulkUpcCandidates.filter((candidate) => bulkUpcSelectedIds.has(candidate.id)),
    [bulkUpcCandidates, bulkUpcSelectedIds],
  );
  const bulkUpcSelectedActionableCount = useMemo(
    () =>
      bulkUpcSelectedCandidates.reduce((sum, candidate) => sum + candidate.actionableCount, 0),
    [bulkUpcSelectedCandidates],
  );
  const bulkUpcSelectedPreviewCount = useMemo(
    () =>
      bulkUpcSelectedCandidates.reduce((sum, candidate) => sum + candidate.previewCount, 0),
    [bulkUpcSelectedCandidates],
  );

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
    const pushItems: PushItem[] = [];
    const stageWrites: Array<{ sku: string; platform: string; listingId: string; newPrice: number }> = [];

    setGridRows((prev) =>
      prev.map((row) => {
        function applyToRow(r: GridRow): GridRow {
          const sourceSp = r.salePrices.find((sp) => sp.platform === gpSource);
          if (!sourceSp) return r;
          const sourcePrice = sourceSp.stagedValue != null ? Number(sourceSp.stagedValue) : Number(sourceSp.value);
          let changed = false;
          const newSalePrices = r.salePrices.map((sp) => {
            if (gpDest.has(sp.platform as Platform) && sp.platform !== gpSource) {
              if (valuesMatch(sp.stagedValue ?? sp.value, sourcePrice)) {
                return sp;
              }
              changed = true;
              updated++;
              stageWrites.push({ sku: r.sku, platform: sp.platform, listingId: sp.listingId, newPrice: sourcePrice });
              if (mode === "push") {
                const pushItem = buildPushItem(r, sp.platform, sp.listingId, "salePrice", sourcePrice);
                if (pushItem) {
                  pushItems.push(pushItem);
                }
              }
              if (mode === "push") return { ...sp, stagedValue: sourcePrice };
              return { ...sp, stagedValue: sourcePrice };
            }
            return sp;
          });
          if (!changed) return r;
          return recalcRowStatic({ ...r, salePrices: newSalePrices, hasStagedChanges: true }, globalFeeRate);
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
    void Promise.allSettled(
      stageWrites.map((item) =>
        persistStageAction(item.sku, item.platform, item.listingId, "stage", item.newPrice),
      ),
    );
    if (mode === "push") {
      queuePushReview(pushItems);
      showToast(`Global Price Review — ${srcShort} → ${destShorts} (${updated} listings staged for push review)`);
      return;
    }

    showToast(`Global Price Staged — ${srcShort} → ${destShorts} (${updated} listings staged)`);
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

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-rows-[auto_auto_auto_minmax(0,1fr)]">
      <div data-tour="dashboard-search">
        {settings.searchBar && (
          <StickySearch
            rows={gridRows}
            onResultSelect={scrollToRow}
            visible={searchVisible}
            onToggleVisibility={() => setSearchVisible(!searchVisible)}
          />
        )}
      </div>
      <div data-tour="dashboard-filters">
        <FilterBar
          filters={filters}
          onChange={(f) => {
            setFilters(f);
            parentRef.current?.scrollTo({ top: 0 });
          }}
        />
      </div>

      <div
        data-tour="dashboard-toolbar"
        className="flex items-center justify-between border-b border-border bg-card/30 px-4 py-1.5"
      >
        <span data-tour="dashboard-row-count" className="text-xs text-muted-foreground">
          {flatRows.length} rows
          {flatRows.length !== gridRows.length && ` (${gridRows.length} total)`}
        </span>
        <div className="flex items-center gap-2">
          {failedPushCount > 0 && (
            <button
              onClick={() => {
                void loadFailedPushes();
                setFailedPushesOpen(true);
              }}
              className="flex items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/20 cursor-pointer"
            >
              <AlertTriangle className="h-3 w-3" />
              Push Alerts ({failedPushCount})
            </button>
          )}
          {stagedCount > 0 && (
            <button
              onClick={reviewAllStagedValues}
              className="flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 cursor-pointer"
            >
              <Check className="h-3 w-3" />
              Push Staged Values ({stagedCount})
            </button>
          )}
          <button
            onClick={() => void openBulkUpcModal()}
            className="flex items-center gap-1 rounded border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-300 transition-colors hover:bg-violet-500/20 cursor-pointer"
          >
            <ArrowRight className="h-3 w-3" />
            Bulk Match UPCs
          </button>
          <button
            data-tour="dashboard-global-price"
            onClick={() => { setGpSource(null); setGpDest(new Set()); setGpMode(null); setGlobalPriceOpen(true); }}
            className="flex items-center gap-1 rounded border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-300 transition-colors hover:bg-violet-500/20 cursor-pointer"
          >
            <RefreshCw className="h-3 w-3" />
            Global Price Update
          </button>
          <div data-tour="dashboard-staged-tools" className="flex items-center gap-2">
            {stagedCount > 0 && (
              <button
                onClick={() => { setClearStagedInput(""); setClearStagedOpen(true); }}
                className="flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/20 cursor-pointer"
              >
                <Trash2 className="h-3 w-3" />
                Clear Staged ({stagedCount})
              </button>
            )}
          </div>
          <div data-tour="dashboard-columns-export" className="flex items-center gap-2">
            <ColumnManager columns={columns} onToggle={toggleColumn} />
            <button className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground cursor-pointer">
              <Download className="h-3 w-3" />
              Export
            </button>
          </div>
        </div>
      </div>

      <div className="relative h-full min-h-0 min-w-0">
      <div
        ref={parentRef}
        data-tour="dashboard-grid"
        className="app-grid-scroll h-full min-h-0 min-w-0 overflow-scroll"
      >
        {/* Header */}
        <div
          className="sticky top-0 z-20 flex border-b-2 border-border bg-card text-xs font-bold uppercase tracking-wide text-foreground/80"
          style={{ minWidth: totalMinWidth }}
        >
          {/* Frozen headers */}
          <div
            data-tour="dashboard-header-frozen"
            className="sticky left-0 z-30 flex shrink-0 bg-card shadow-[2px_0_8px_-2px_rgba(0,0,0,0.15)]"
          >
            {/* Expand/collapse column — always visible, no header text */}
            <div
              data-tour="dashboard-header-expand"
              className={cn(COL_WIDTHS.expand, "flex items-center justify-center py-3")}
            />
            {isColVisible("photo") && (
              <div className={cn(COL_WIDTHS.photo, "flex items-center gap-0.5 px-2 py-3")}>
                <span>Photo</span>
              </div>
            )}
            {isColVisible("upc") && (
              <div className={cn(COL_WIDTHS.upc, "flex items-center gap-0.5 px-3 py-3")}>
                <span>UPC</span>
              </div>
            )}
            {isColVisible("itemIds") && (
              <div className={cn(COL_WIDTHS.itemIds, "flex items-center gap-0.5 px-3 py-3")}>
                <span>Item IDs</span>
              </div>
            )}
            {isColVisible("sku") && (
              <button
                onClick={() => toggleSort("sku")}
                className={cn(COL_WIDTHS.sku, "flex items-center gap-0.5 px-3 py-3 cursor-pointer hover:text-foreground")}
              >
                <span>SKU</span>
                <SortIcon field="sku" />
              </button>
            )}
            {isColVisible("title") && (
              <button
                onClick={() => toggleSort("title")}
                className={cn(COL_WIDTHS.title, "flex items-center gap-0.5 px-3 py-3 cursor-pointer hover:text-foreground")}
              >
                <span>Title</span>
                <SortIcon field="title" />
              </button>
            )}
          </div>

          {/* Scrollable headers */}
          <div className="flex">
            {isColVisible("qty") && (
              <button
                data-tour="dashboard-header-qty"
                onClick={() => toggleSort("inventory")}
                className={cn(COL_WIDTHS.qty, "flex items-center justify-end gap-0.5 px-2 py-3 cursor-pointer hover:text-foreground")}
              >
                <span>Live Quantity</span>
                <SortIcon field="inventory" />
              </button>
            )}
            {isColVisible("salePrice") && (
              <div
                data-tour="dashboard-header-sale-price"
                className={cn(COL_WIDTHS.salePrice, "flex items-center gap-0.5 px-3 py-3")}
              >
                <span>Sale Price</span>
              </div>
            )}
            {isColVisible("weight") && (
              <div className={cn(COL_WIDTHS.weight, "flex items-center gap-0.5 px-3 py-3")}>
                <span>Weight</span>
              </div>
            )}
            {isColVisible("supplierCost") && (
              <div className={cn(COL_WIDTHS.supplierCost, "flex items-center gap-0.5 px-3 py-3")}>
                <span>Supplier Cost of Good</span>
              </div>
            )}
            {isColVisible("suppShip") && (
              <div className={cn(COL_WIDTHS.suppShip, "flex items-center gap-0.5 px-3 py-3")}>
                <span>Supplier Shipping Cost</span>
              </div>
            )}
            {isColVisible("shipCost") && (
              <div className={cn(COL_WIDTHS.shipCost, "flex items-center gap-0.5 px-3 py-3")}>
                <span>Shipping Cost</span>
              </div>
            )}
            {isColVisible("platformFees") && (
              <div
                data-tour="dashboard-header-platform-fees"
                className={cn(COL_WIDTHS.platformFees, "flex items-center gap-0.5 px-3 py-3")}
              >
                <PlatformFeeHeader
                  feeRate={globalFeeRate}
                  onSave={(rate) => {
                    const oldRate = globalFeeRate;
                    setGlobalFeeRate(rate);
                    showToast(`Platform Fee Updated — from ${Math.round(oldRate * 1000) / 10}% to ${Math.round(rate * 1000) / 10}% (all eBay listings)`);
                  }}
                />
              </div>
            )}
            {isColVisible("adRate") && (
              <div
                data-tour="dashboard-header-ad-rate"
                className={cn(COL_WIDTHS.adRate, "flex items-center gap-0.5 px-3 py-3")}
              >
                <span>Promoted General Ad Rate</span>
              </div>
            )}
            {isColVisible("profit") && (
              <div
                data-tour="dashboard-header-profit"
                className={cn(COL_WIDTHS.profit, "flex items-center gap-0.5 px-3 py-3")}
              >
                <span>Profit</span>
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
            const isChildLoading = isParent && childRowsLoading[row.id];

            return (
              <div
                key={row.parentId ? `${row.parentId}:${row.id}` : row.id}
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
                    "grid grid-cols-2 items-center gap-1 px-1.5",
                    cellPy
                  )}>
                    <div className="flex items-center justify-center">
                      {isParent && (
                      <button
                        onClick={() => toggleExpand(row.id)}
                        disabled={isChildLoading}
                        className={cn(
                          "flex h-5 w-5 items-center justify-center rounded text-white transition-colors cursor-pointer",
                          isChildLoading
                            ? "bg-emerald-500/70 cursor-wait"
                            : isExpanded
                            ? "bg-emerald-600 hover:bg-emerald-700"
                            : "bg-emerald-500 hover:bg-emerald-600"
                        )}
                        title={
                          isChildLoading
                            ? "Loading variations"
                            : isExpanded
                              ? "Collapse variations"
                              : "Expand variations"
                        }
                      >
                        {isChildLoading ? (
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" strokeWidth={2.75} />
                        ) : isExpanded ? (
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
                    <div className="flex items-center justify-center">
                      <button
                        onClick={() => void handleRefreshRow(row.id, row.parentId)}
                        disabled={rowRefreshStates[row.id] === "loading"}
                        className={cn(
                          "flex h-7 w-7 items-center justify-center rounded-md border transition-colors cursor-pointer",
                          rowRefreshStates[row.id] === "success"
                            ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                            : "border-violet-500/35 bg-violet-500/15 text-violet-300",
                          rowRefreshStates[row.id] === "loading"
                            ? "cursor-wait opacity-80"
                            : rowRefreshStates[row.id] === "success"
                              ? "hover:border-emerald-500/40 hover:bg-emerald-500/15 hover:text-emerald-300"
                              : "hover:border-violet-400/60 hover:bg-violet-500/25 hover:text-violet-200"
                        )}
                        title={
                          rowRefreshStates[row.id] === "success"
                            ? "Row refreshed"
                            : "Refresh this row from linked marketplaces"
                        }
                      >
                        {rowRefreshStates[row.id] === "success" ? (
                          <Check className="h-3.5 w-3.5" strokeWidth={3} />
                        ) : (
                          <RefreshCw
                            className={cn("h-3.5 w-3.5", rowRefreshStates[row.id] === "loading" && "animate-spin")}
                            strokeWidth={2.4}
                          />
                        )}
                      </button>
                    </div>
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
                        <UpcCell
                          rowId={row.id}
                          upc={row.upc}
                          liveFetchRevision={upcLiveRefreshRevisions[row.id] ?? 0}
                          disableLiveFetch={row.isParent && row.id.startsWith("variation-parent:")}
                          stagedUpc={row.stagedUpc}
                          editable={!row.isParent && (row.upcPushTargets?.length ?? 0) > 0}
                          canPush={!row.isParent && Boolean(row.hasStagedUpc) && (row.upcPushTargets?.length ?? 0) > 0}
                          pushTargets={buildUpcPushChoices(row)}
                          quickPushState={quickPushStates[getUpcQuickPushKey(row.id)]}
                          failedPushTargets={failedPushStates.upcStates[row.id]}
                          onSave={(value, mode, target) => handleUpcEdit(row.id, value, mode, target)}
                          onReviewPush={() => handlePushStagedUpc(row.id, "review")}
                          onFastPush={() => handlePushStagedUpc(row.id, "fast")}
                          onReviewPushTarget={(platform, listingId) =>
                            handlePushStagedUpc(row.id, "review", platform, listingId)
                          }
                          onFastPushTarget={(platform, listingId) =>
                            handlePushStagedUpc(row.id, "fast", platform, listingId)
                          }
                          onDiscard={() => handleDiscardStagedUpc(row.id)}
                          onDiscardTarget={(platform, listingId) =>
                            handleDiscardStagedUpcTarget(row.id, platform, listingId)
                          }
                          onMatchUpc={(choices, mode, options) =>
                            void handleMatchUpc(row.id, choices, mode, options)
                          }
                        />
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
                    <div className={cn(COL_WIDTHS.sku, "flex items-center pl-3 pr-4 overflow-hidden", cellPy)}>
                      {isParent ? (
                        <button
                          onClick={() => void toggleExpand(row.id)}
                          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/20 cursor-pointer"
                          title={isExpanded ? "Collapse variation listing" : "Expand variation listing"}
                        >
                          <span>Variation Parent</span>
                          {row.childRows && (
                            <span className="rounded bg-emerald-500/20 px-1 text-[10px] tabular-nums">
                              {row.childRows.length}
                            </span>
                          )}
                          {isChildLoading && (
                            <RefreshCw className="h-3 w-3 animate-spin" strokeWidth={2.5} />
                          )}
                        </button>
                      ) : (
                        <CopyValue value={row.sku} className="max-w-full gap-1.5">
                          <span className="scalable-text block min-w-0 flex-1 whitespace-normal break-all font-mono font-medium leading-snug">
                            {row.sku}
                          </span>
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
                          <button
                            onClick={() => void toggleExpand(row.id)}
                            className={cn(
                              "inline-flex items-center gap-1 mt-0.5 text-[10px] cursor-pointer text-left hover:text-emerald-400",
                              isExpanded ? "text-emerald-500" : "text-muted-foreground"
                            )}
                            title={isExpanded ? "Collapse variation listing" : "Expand variation listing"}
                          >
                            <span className="font-semibold">Variation Listing</span>
                            {row.childRows ? ` · ${row.childRows.length} SKUs` : ""}
                            {!isExpanded && <span className="text-emerald-500 font-medium ml-0.5">(click + to expand)</span>}
                          </button>
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
                        onBulkSave={handleSalePriceBulkEdit}
                        onPush={handlePushStaged}
                        onDiscard={handleDiscardStaged}
                        quickPushStates={quickPushStates}
                        failedPushStates={failedPushStates.storeStates}
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
                    <div className={cn(COL_WIDTHS.adRate, "min-w-0 flex items-center px-3", cellPy)}>
                      {row.isVariation && !row.isParent ? (
                        <StoreBlockGroup items={row.adRates} format="percent" showStaged={false} />
                      ) : (
                        <EditableAdRateBlockGroup
                          items={row.adRates}
                          rowId={row.id}
                          onSave={handleAdRateEdit}
                          onPush={handlePushStagedAdRate}
                          onDiscard={handleDiscardStagedAdRate}
                          quickPushStates={quickPushStates}
                          failedPushStates={failedPushStates.storeStates}
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
              {stagedCount === 1 ? " value" : " values"}. Clearing will discard all staged values and restore live values.
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

      {failedPushesOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
          <div className="w-full max-w-4xl rounded-xl border border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h3 className="text-base font-bold text-foreground">Failed Pushes</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  These marketplace writes failed and are still safe to retry through the guarded push flow.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {failedPushCount > 1 && (
                  <button
                    onClick={() => {
                      setFailedPushesOpen(false);
                      queuePushReview(
                        failedPushes.map(
                          ({
                            retryKey: _retryKey,
                            pushJobId: _pushJobId,
                            failedAt: _failedAt,
                            platformLabel: _platformLabel,
                            fieldLabel: _fieldLabel,
                            oldDisplay: _oldDisplay,
                            newDisplay: _newDisplay,
                            error: _error,
                            failureCategory: _failureCategory,
                            failureSummary: _failureSummary,
                            recommendedAction: _recommendedAction,
                            ...item
                          }) =>
                            item,
                        ),
                      );
                    }}
                    className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/20 cursor-pointer"
                  >
                    Retry All
                  </button>
                )}
                <button
                  onClick={() => setFailedPushesOpen(false)}
                  className="rounded-md px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
              {failedPushesLoading ? (
                <div className="py-12 text-center text-sm text-muted-foreground">Loading failed pushes...</div>
              ) : failedPushCount === 0 ? (
                <div className="py-12 text-center text-sm text-muted-foreground">No failed pushes are waiting for retry.</div>
              ) : (
                <div className="space-y-3">
                  {failedPushes.map((failure) => {
                    const {
                      retryKey,
                      pushJobId,
                      failedAt,
                      platformLabel,
                      fieldLabel,
                      oldDisplay,
                      newDisplay,
                      error,
                      failureCategory,
                      failureSummary,
                      recommendedAction,
                      ...pushItem
                    } = failure;

                    return (
                      <article key={retryKey} className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-300">
                                {PLATFORM_SHORT[failure.platform]}
                              </span>
                              <span className="text-sm font-semibold text-foreground">{failure.sku}</span>
                              <span className="text-xs text-muted-foreground">{fieldLabel}</span>
                            </div>
                            <p className="mt-1 text-sm text-foreground">
                              {oldDisplay} changed to {newDisplay}
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                                {failureCategory.replace("-", " ")}
                              </span>
                              <span className="text-xs text-foreground/90">{failureSummary}</span>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {platformLabel} • Job {pushJobId.slice(0, 8)} • {new Date(failedAt).toLocaleString("en-US", {
                                timeZone: "America/New_York",
                                month: "numeric",
                                day: "numeric",
                                year: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                              })}
                            </p>
                            <p className="mt-2 text-xs text-amber-100">Next step: {recommendedAction}</p>
                            <p className="mt-2 text-xs text-red-200">{error}</p>
                          </div>
                          <button
                            onClick={() => {
                              setFailedPushesOpen(false);
                              queuePushReview([pushItem]);
                            }}
                            className="shrink-0 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer"
                          >
                            Retry Push
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {bulkUpcOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
          <div className="flex w-full max-w-5xl flex-col rounded-xl border border-border bg-card p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-bold text-foreground">Bulk Match UPCs</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Scan the current grid and preselect rows where reorG can normalize marketplace UPCs in bulk.
                </p>
              </div>
              <button
                onClick={closeBulkUpcModal}
                aria-label="Close bulk Match UPCs"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/80 bg-background/50 text-muted-foreground transition-colors hover:border-border hover:bg-background/70 hover:text-foreground cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-background/40 px-4 py-3">
              <div className="text-sm text-muted-foreground">
                {bulkUpcLoading ? (
                  <span className="inline-flex items-center gap-2">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Building UPC match queue from the current grid...
                  </span>
                ) : (
                  <span>
                    <span className="font-semibold text-foreground">{bulkUpcSelectedCandidates.length}</span> selected row
                    {bulkUpcSelectedCandidates.length === 1 ? "" : "s"} ·{" "}
                    <span className="font-semibold text-foreground">{bulkUpcSelectedActionableCount}</span> actionable marketplace
                    {bulkUpcSelectedActionableCount === 1 ? " change" : " changes"} ·{" "}
                    <span className="font-semibold text-foreground">{bulkUpcSelectedPreviewCount}</span> total marketplaces in review
                  </span>
                )}
              </div>
              {!bulkUpcLoading && bulkUpcCandidates.length > 0 ? (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setBulkUpcSelectedIds(new Set(bulkUpcCandidates.map((candidate) => candidate.id)))}
                    className="rounded border border-border/80 bg-background/50 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-background/70 hover:text-foreground cursor-pointer"
                  >
                    Select All
                  </button>
                  <button
                    onClick={() => setBulkUpcSelectedIds(new Set())}
                    className="rounded border border-border/80 bg-background/50 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-background/70 hover:text-foreground cursor-pointer"
                  >
                    Clear All
                  </button>
                </div>
              ) : null}
            </div>

            <div className="mt-4 max-h-[58vh] overflow-y-auto rounded-xl border border-border bg-background/20 p-3">
              {bulkUpcLoading ? (
                <div className="flex min-h-[240px] items-center justify-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Checking each row&apos;s live UPCs...
                  </span>
                </div>
              ) : bulkUpcCandidates.length === 0 ? (
                <div className="flex min-h-[240px] items-center justify-center text-sm text-muted-foreground">
                  No bulk Match UPC candidates are available in the current grid.
                </div>
              ) : (
                <div className="space-y-3">
                  {bulkUpcCandidates.map((candidate) => {
                    const isSelected = bulkUpcSelectedIds.has(candidate.id);
                    return (
                      <label
                        key={candidate.id}
                        className={cn(
                          "block cursor-pointer rounded-xl border p-4 transition-colors",
                          isSelected
                            ? "border-violet-500/40 bg-violet-500/5"
                            : "border-border bg-background/30 hover:bg-background/50",
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() =>
                              setBulkUpcSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(candidate.id)) next.delete(candidate.id);
                                else next.add(candidate.id);
                                return next;
                              })
                            }
                            className="mt-1 h-4 w-4 rounded border-border bg-background text-violet-400"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-sm font-semibold text-foreground">{candidate.sku}</span>
                              <span className="rounded bg-violet-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-300">
                                {candidate.modeLabel}
                              </span>
                              <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-300">
                                {candidate.majorityUpc}
                              </span>
                            </div>
                            <p className="mt-1 text-sm text-muted-foreground">{candidate.title}</p>

                            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                              <span className="text-muted-foreground">Source</span>
                              {candidate.sourceChoices.map((choice) => (
                                <span
                                  key={`${candidate.id}:source:${choice.platform}`}
                                  className={cn("inline-flex items-center gap-1 rounded border px-2 py-1 font-semibold", PLATFORM_COLORS[choice.platform])}
                                >
                                  <PlatformIcon platform={choice.platform} size={12} />
                                  <span>{choice.label}</span>
                                </span>
                              ))}
                              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-muted-foreground">Update</span>
                              {candidate.mismatchChoices.map((choice) => (
                                <span
                                  key={`${candidate.id}:target:${choice.platform}`}
                                  className={cn("inline-flex items-center gap-1 rounded border px-2 py-1 font-semibold", PLATFORM_COLORS[choice.platform])}
                                >
                                  <PlatformIcon platform={choice.platform} size={12} />
                                  <span>{choice.label}</span>
                                </span>
                              ))}
                            </div>

                            <div className="mt-3 grid gap-2 md:grid-cols-2">
                              {candidate.mismatchChoices.map((choice) => (
                                <div
                                  key={`${candidate.id}:change:${choice.platform}`}
                                  className="rounded-lg border border-border/70 bg-background/40 px-3 py-2 text-xs"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="inline-flex items-center gap-1 font-semibold text-foreground">
                                      <PlatformIcon platform={choice.platform} size={12} />
                                      <span>{choice.label}</span>
                                    </span>
                                    <span className={choice.editable ? "text-emerald-300" : "text-amber-300"}>
                                      {choice.editable ? "Selected" : "Locked now"}
                                    </span>
                                  </div>
                                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                                    {(choice.value ?? "No UPC")} {"->"} {candidate.majorityUpc}
                                  </div>
                                </div>
                              ))}
                            </div>

                            {candidate.note ? (
                              <p className="mt-3 text-xs text-amber-200">{candidate.note}</p>
                            ) : null}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Locked marketplaces are shown for awareness only. They will not receive a live UPC until you unlock them and run Match UPC again.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={closeBulkUpcModal}
                  className="rounded-md border border-border/80 bg-background/50 px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:border-border hover:bg-background/70 hover:text-foreground cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void runBulkUpcAction("stage")}
                  disabled={bulkUpcLoading || bulkUpcSubmitting !== null || bulkUpcSelectedCandidates.length === 0}
                  className="rounded-md bg-[var(--staged)] px-4 py-2 text-sm font-bold text-[var(--staged-foreground)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                  {bulkUpcSubmitting === "stage" ? "Staging..." : "Stage Selected"}
                </button>
                <button
                  onClick={() => void runBulkUpcAction("review")}
                  disabled={bulkUpcLoading || bulkUpcSubmitting !== null || bulkUpcSelectedCandidates.length === 0}
                  className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                  {bulkUpcSubmitting === "review" ? "Preparing..." : "Review Push Selected"}
                </button>
                <button
                  onClick={() => void runBulkUpcAction("fast")}
                  disabled={bulkUpcLoading || bulkUpcSubmitting !== null || bulkUpcSelectedCandidates.length === 0}
                  className="rounded-md bg-blue-500 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                  {bulkUpcSubmitting === "fast" ? "Starting..." : "Fast Push Selected"}
                </button>
              </div>
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
                      Review Push All
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

      <PushConfirmModal
        open={pushModalOpen}
        onClose={() => {
          setPushModalOpen(false);
          setPushModalItems([]);
          setPushModalPreviewItems([]);
          setPushModalLaunchMode("review");
        }}
        items={pushModalItems}
        previewItems={pushModalPreviewItems}
        autoRunDryRun={pushModalLaunchMode === "fast"}
        onApplied={(result) => {
          applyPushOutcome(result);
        }}
      />

      {/* Toast notification */}
      {toast && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] animate-in fade-in slide-in-from-top-2 rounded-lg border border-border bg-card px-5 py-2 text-sm font-medium text-foreground shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
