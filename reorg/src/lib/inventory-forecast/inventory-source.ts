import type { InventorySourceType } from "@prisma/client";
import { getGridData } from "@/lib/grid-query";
import type { GridRow } from "@/lib/grid-types";
import type { ForecastInventoryRow } from "@/lib/inventory-forecast/types";

export const DEFAULT_FORECAST_INVENTORY_SOURCE: InventorySourceType = "MASTER_TPP_LIVE";

function normalizeMasterRowId(rowId: string) {
  return rowId.startsWith("child-") ? rowId.slice("child-".length) : rowId;
}

function flattenLeafRows(rows: GridRow[]) {
  const leafRows: GridRow[] = [];
  for (const row of rows) {
    if (row.isParent && row.childRows && row.childRows.length > 0) {
      leafRows.push(...row.childRows);
      continue;
    }
    leafRows.push(row);
  }
  return leafRows;
}

export async function getForecastInventoryRows(): Promise<ForecastInventoryRow[]> {
  const rows = await getGridData();
  const leafRows = flattenLeafRows(rows);
  const deduped = new Map<string, ForecastInventoryRow>();

  for (const row of leafRows) {
    const masterRowId = normalizeMasterRowId(row.id);
    const existing = deduped.get(masterRowId);
    const nextRow: ForecastInventoryRow = {
      masterRowId,
      sku: row.sku,
      title: row.title,
      upc: row.upc,
      imageUrl: row.imageUrl,
      supplierCost: row.supplierCost,
      currentInventory: row.inventory ?? 0,
    };

    if (!existing) {
      deduped.set(masterRowId, nextRow);
      continue;
    }

    deduped.set(masterRowId, {
      masterRowId,
      sku: existing.sku || nextRow.sku,
      title: existing.title || nextRow.title,
      upc: existing.upc ?? nextRow.upc,
      imageUrl: existing.imageUrl ?? nextRow.imageUrl,
      supplierCost: existing.supplierCost ?? nextRow.supplierCost,
      currentInventory: Math.max(existing.currentInventory, nextRow.currentInventory),
    });
  }

  return [...deduped.values()]
    .sort((left, right) =>
      left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
    );
}
