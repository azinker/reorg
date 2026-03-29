import type { GridRow, Platform } from "@/lib/grid-types";

/** Flatten grid rows for item-ID search (includes variation parents and children). */
export function flattenRowsForItemSearch(rows: GridRow[]): GridRow[] {
  const flat: GridRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      flat.push(row);
    }
    if (row.childRows) {
      for (const child of row.childRows) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        flat.push(child);
      }
    }
  }
  return flat;
}

function normalizeItemKey(id: string): string {
  return id.trim().toLowerCase().replace(/^sh-/i, "").replace(/^bc-/i, "");
}

/**
 * Find grid row id whose itemNumbers match the marketplace item id (and optional platform).
 */
export function findRowIdByPlatformItemId(
  rows: GridRow[],
  rawItemId: string,
  platform?: Platform,
): string | null {
  const q = rawItemId.trim();
  if (!q) return null;
  const qNorm = normalizeItemKey(q);
  const flat = flattenRowsForItemSearch(rows);

  for (const row of flat) {
    for (const item of row.itemNumbers) {
      if (platform && item.platform !== platform) continue;
      const lid = String(item.listingId).trim();
      if (!lid) continue;
      if (lid.toLowerCase() === q.toLowerCase()) return row.id;
      if (normalizeItemKey(lid) === qNorm) return row.id;
    }
  }
  return null;
}
