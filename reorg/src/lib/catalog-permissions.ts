import { DEFAULT_COLUMNS, type ColumnConfig, type GridRow } from "@/lib/grid-types";

export interface CatalogPermissions {
  readOnly: boolean;
  hiddenColumns: string[];
}

export const DEFAULT_CATALOG_PERMISSIONS: CatalogPermissions = {
  readOnly: false,
  hiddenColumns: [],
};

export const CATALOG_COLUMN_OPTIONS: Array<Pick<ColumnConfig, "id" | "label">> =
  DEFAULT_COLUMNS.map(({ id, label }) => ({ id, label }));

const CATALOG_COLUMN_IDS = new Set(DEFAULT_COLUMNS.map((column) => column.id));

export function normalizeCatalogPermissions(
  value: unknown,
): CatalogPermissions | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("catalogPermissions must be an object or null");
  }

  const record = value as Record<string, unknown>;
  const hiddenColumns = Array.isArray(record.hiddenColumns)
    ? [
        ...new Set(
          record.hiddenColumns.filter(
            (column): column is string =>
              typeof column === "string" && CATALOG_COLUMN_IDS.has(column),
          ),
        ),
      ]
    : [];

  return {
    readOnly: record.readOnly === true,
    hiddenColumns,
  };
}

export function resolveCatalogPermissions(input: {
  role: string | null | undefined;
  catalogPermissions: unknown;
}): CatalogPermissions {
  if (input.role === "ADMIN") return DEFAULT_CATALOG_PERMISSIONS;
  return (
    normalizeCatalogPermissions(input.catalogPermissions) ??
    DEFAULT_CATALOG_PERMISSIONS
  );
}

export function applyCatalogColumnRestrictions(
  columns: ColumnConfig[],
  hiddenColumnIds: Iterable<string>,
): ColumnConfig[] {
  const hidden = new Set(hiddenColumnIds);
  const byId = new Map(columns.map((column) => [column.id, column]));
  return DEFAULT_COLUMNS.map((defaultColumn) => {
    const saved = byId.get(defaultColumn.id);
    const visible = hidden.has(defaultColumn.id)
      ? false
      : saved?.visible ?? defaultColumn.visible;

    return {
      ...defaultColumn,
      ...saved,
      visible,
    };
  });
}

function redactStoreValues<T>(items: T[] | undefined): T[] {
  return Array.isArray(items) ? [] : [];
}

export function redactGridRowForCatalogPermissions(
  row: GridRow,
  permissions: CatalogPermissions,
): GridRow {
  const hidden = new Set(permissions.hiddenColumns);
  if (hidden.size === 0) {
    return row;
  }

  const next: GridRow = {
    ...row,
    childRows: row.childRows?.map((child) =>
      redactGridRowForCatalogPermissions(child, permissions),
    ),
  };

  if (hidden.has("photo")) {
    next.imageUrl = null;
    next.imageSource = undefined;
  }
  if (hidden.has("upc")) {
    next.upc = null;
    next.stagedUpc = null;
    next.hasStagedUpc = false;
    next.localOnlyUpcPlatforms = [];
    next.upcPushTargets = [];
  }
  if (hidden.has("itemIds")) {
    next.itemNumbers = [];
  }
  if (hidden.has("sku")) {
    next.sku = "";
  }
  if (hidden.has("title")) {
    next.title = "";
    next.alternateTitles = [];
  }
  if (hidden.has("qty")) {
    next.inventory = null;
  }
  if (hidden.has("salePrice")) {
    next.salePrices = redactStoreValues(next.salePrices);
  }
  if (hidden.has("weight")) {
    next.weight = null;
  }
  if (hidden.has("supplierCost")) {
    next.supplierCost = null;
  }
  if (hidden.has("suppShip")) {
    next.supplierShipping = null;
  }
  if (hidden.has("shipCost")) {
    next.shippingCost = null;
  }
  if (hidden.has("platformFees")) {
    next.platformFees = redactStoreValues(next.platformFees);
  }
  if (hidden.has("adRate")) {
    next.adRates = redactStoreValues(next.adRates);
    next.profitAdRatesByPlatform = {};
  }
  if (hidden.has("profit")) {
    next.profits = redactStoreValues(next.profits);
  }

  return next;
}

export function redactGridRowsForCatalogPermissions(
  rows: GridRow[],
  permissions: CatalogPermissions,
): GridRow[] {
  if (permissions.hiddenColumns.length === 0) return rows;
  return rows.map((row) => redactGridRowForCatalogPermissions(row, permissions));
}
