import * as XLSX from "xlsx";

export type SalesPlatformKey = "TPP_EBAY" | "TT_EBAY" | "SHOPIFY" | "BIGCOMMERCE";

export interface ParsedSalesSection {
  name: string;
  platform: SalesPlatformKey | null;
  enabled: boolean;
  skuCount: number;
  totalUnits: number;
}

export interface ParsedSalesUpload {
  sections: ParsedSalesSection[];
  dateRange: { from: string; to: string } | null;
  /** SKU → { totalQty, platformQty: Record<string, number> } — `platformQty` keys are section names from the file (unique per section for enable/disable). */
  skuSales: Map<string, { totalQty: number; platformQty: Record<string, number> }>;
}

const DATE_RANGE_REGEX =
  /Date Range:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/i;

function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return cell;
  if (typeof cell === "number" && !Number.isNaN(cell)) return String(cell);
  if (typeof cell === "boolean") return cell ? "true" : "false";
  return "";
}

function getCell(row: unknown, index: number): unknown {
  if (!Array.isArray(row)) return undefined;
  return row[index];
}

function rowIsEmptyOrSparse(row: unknown): boolean {
  const s0 = cellToString(getCell(row, 0)).trim();
  return s0 === "";
}

function isSkuHeaderCell(cell: unknown): boolean {
  return cellToString(cell).trim().toLowerCase() === "sku";
}

/** Row where [0] is non-empty and the following row's [0] is the Sku header. */
function isSectionHeaderPair(data: unknown[][], rowIndex: number): boolean {
  const cur = data[rowIndex];
  const next = data[rowIndex + 1];
  if (!cur || !next) return false;
  const title = cellToString(getCell(cur, 0)).trim();
  if (title === "") return false;
  return isSkuHeaderCell(getCell(next, 0));
}

function mapSectionNameToPlatform(name: string): SalesPlatformKey | null {
  const upper = name.toUpperCase();
  const hasEbay = upper.includes("EBAY");

  if (hasEbay && (upper.includes("PERFECT PART") || /\bTPP\b/.test(upper))) {
    return "TPP_EBAY";
  }
  if (hasEbay && (upper.includes("TELITETECH") || /\bTT\b/.test(upper))) {
    return "TT_EBAY";
  }
  if (upper.includes("SHOPIFY")) {
    return "SHOPIFY";
  }
  if (upper.includes("BIGCOMMERCE")) {
    return "BIGCOMMERCE";
  }
  return null;
}

function parseQty(cell: unknown): number {
  if (typeof cell === "number" && Number.isFinite(cell)) {
    return Math.trunc(cell);
  }
  const s = cellToString(cell).trim();
  if (s === "") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function shouldSkipDataRow(
  skuRaw: string,
  sectionNames: ReadonlySet<string>,
): boolean {
  const lower = skuRaw.toLowerCase();
  if (lower === "sku") return true;
  if (lower === "totals") return true;
  if (lower === "product sales report") return true;
  if (sectionNames.has(skuRaw)) return true;
  return false;
}

function addSkuSale(
  skuSales: Map<string, { totalQty: number; platformQty: Record<string, number> }>,
  sku: string,
  qty: number,
  sectionName: string,
): void {
  if (qty <= 0 || sku === "") return;
  const existing = skuSales.get(sku);
  if (!existing) {
    skuSales.set(sku, {
      totalQty: qty,
      platformQty: { [sectionName]: qty },
    });
    return;
  }
  existing.totalQty += qty;
  existing.platformQty[sectionName] =
    (existing.platformQty[sectionName] ?? 0) + qty;
}

/**
 * Parses an ArrayBuffer from a .xlsx file into structured sales data.
 */
export function parseSalesUpload(buffer: ArrayBuffer): ParsedSalesUpload {
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstName = workbook.SheetNames[0];
  const ws = firstName ? workbook.Sheets[firstName] : undefined;

  const rawRows: unknown = ws
    ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
    : [];

  const data: unknown[][] = Array.isArray(rawRows)
    ? rawRows.filter((r): r is unknown[] => Array.isArray(r))
    : [];

  let dateRange: { from: string; to: string } | null = null;
  const headerRow = data[0];
  if (headerRow) {
    const rangeCell = cellToString(getCell(headerRow, 2));
    const m = rangeCell.match(DATE_RANGE_REGEX);
    if (m) {
      dateRange = { from: m[1] ?? "", to: m[2] ?? "" };
    }
  }

  const sectionNames = new Set<string>();
  const sectionStarts: number[] = [];
  for (let i = 0; i < data.length - 1; i++) {
    if (isSectionHeaderPair(data, i)) {
      const name = cellToString(getCell(data[i], 0)).trim();
      if (name !== "") {
        sectionNames.add(name);
        sectionStarts.push(i);
      }
    }
  }

  const sections: ParsedSalesSection[] = [];

  for (let s = 0; s < sectionStarts.length; s++) {
    const start = sectionStarts[s];
    const name = cellToString(getCell(data[start], 0)).trim();
    const platform = mapSectionNameToPlatform(name);
    const dataBegin = start + 2;
    const nextSectionRow =
      s + 1 < sectionStarts.length ? sectionStarts[s + 1] : data.length;

    const skuSet = new Set<string>();
    let totalUnits = 0;

    for (let j = dataBegin; j < nextSectionRow; j++) {
      const row = data[j];
      if (!Array.isArray(row)) continue;
      if (rowIsEmptyOrSparse(row)) continue;

      if (isSectionHeaderPair(data, j)) {
        break;
      }

      const skuRaw = cellToString(getCell(row, 0)).trim();
      if (skuRaw === "") continue;
      if (shouldSkipDataRow(skuRaw, sectionNames)) continue;

      const qty = parseQty(getCell(row, 6));
      skuSet.add(skuRaw);
      totalUnits += qty;
    }

    sections.push({
      name,
      platform,
      enabled: true,
      skuCount: skuSet.size,
      totalUnits,
    });
  }

  const skuSales = new Map<
    string,
    { totalQty: number; platformQty: Record<string, number> }
  >();

  for (let s = 0; s < sectionStarts.length; s++) {
    const start = sectionStarts[s];
    const name = cellToString(getCell(data[start], 0)).trim();
    const sec = sections[s];
    if (!sec?.enabled) continue;

    const dataBegin = start + 2;
    const nextSectionRow =
      s + 1 < sectionStarts.length ? sectionStarts[s + 1] : data.length;

    for (let j = dataBegin; j < nextSectionRow; j++) {
      const row = data[j];
      if (!Array.isArray(row)) continue;
      if (rowIsEmptyOrSparse(row)) continue;
      if (isSectionHeaderPair(data, j)) break;

      const skuRaw = cellToString(getCell(row, 0)).trim();
      if (skuRaw === "") continue;
      if (shouldSkipDataRow(skuRaw, sectionNames)) continue;

      const qty = parseQty(getCell(row, 6));
      addSkuSale(skuSales, skuRaw, qty, name);
    }
  }

  return { sections, dateRange, skuSales };
}

export interface AggregatedSkuSale {
  sku: string;
  qty: number;
  platformQty: Record<string, number>;
}

function aggregateKeyForSection(sec: ParsedSalesSection): string {
  return sec.platform ?? `UNKNOWN:${sec.name}`;
}

/**
 * Re-aggregates the sales data using only the enabled sections.
 */
export function aggregateSalesUpload(
  parsed: ParsedSalesUpload,
): AggregatedSkuSale[] {
  const sectionByName = new Map(
    parsed.sections.map((sec) => [sec.name, sec] as const),
  );

  const outMap = new Map<string, { qty: number; platformQty: Record<string, number> }>();

  for (const [sku, row] of parsed.skuSales.entries()) {
    let qty = 0;
    const platformQty: Record<string, number> = {};

    for (const [sectionName, chunk] of Object.entries(row.platformQty)) {
      if (chunk <= 0) continue;
      const sec = sectionByName.get(sectionName);
      if (!sec?.enabled) continue;
      qty += chunk;
      const pk = aggregateKeyForSection(sec);
      platformQty[pk] = (platformQty[pk] ?? 0) + chunk;
    }

    if (qty > 0) {
      outMap.set(sku, { qty, platformQty });
    }
  }

  const out: AggregatedSkuSale[] = [];
  for (const [sku, v] of outMap.entries()) {
    out.push({ sku, qty: v.qty, platformQty: v.platformQty });
  }

  out.sort((a, b) => a.sku.localeCompare(b.sku));
  return out;
}
