import type { ForecastLineResult, ForecastResult } from "./types";

export interface ExportProgress {
  phase: "preparing" | "images" | "building" | "generating" | "done" | "error";
  percent: number;
  message: string;
  errorDetail?: string;
  imageStats?: { fetched: number; failed: number; total: number };
}

type ImgExt = "png" | "jpeg" | "gif";
type FetchedImage = { buffer: ArrayBuffer; extension: ImgExt } | null;

const IMAGE_BATCH = 40;
const IMAGE_TIMEOUT_MS = 3_000;
const PRODUCT_IMAGE_SIZE = 112;
const BARCODE_MAX_WIDTH = 140;
const BARCODE_MAX_HEIGHT = 68;

const EXPORT_COLUMNS = [
  { header: "Product Title", width: 45 },
  { header: "UPC", width: 24 },
  { header: "SKU", width: 45 },
  { header: "Product Image", width: 18 },
  { header: "Required Quantity to Order", width: 30 },
  { header: "Flat Avg. Estimate", width: 22 },
  { header: "Supplier Cost", width: 14 },
  { header: "Total Cost", width: 20 },
  { header: "Sales History Summary", width: 30 },
  { header: "Gross Required Quantity (Before Current On Hand)", width: 36 },
  { header: "Current Available Inventory", width: 16 },
  { header: "Safety Buffer", width: 14 },
  { header: "Open In-Transit Quantity", width: 16 },
  { header: "Open In-Transit ETA", width: 16 },
  { header: "Demand Pattern", width: 28 },
  { header: "Model Used", width: 42 },
  { header: "Confidence", width: 32 },
] as const;

const HEADER_NOTES: Record<string, string> = {
  "Required Quantity to Order":
    "Final order quantity using the forecast model (accounts for seasonality, trends, intermittent demand). Rounded up to the next multiple of 5.",
  "Flat Avg. Estimate":
    "What the order quantity would be using a simple daily average (total sales ÷ days) instead of the forecast model. Compare with Required Quantity to see the model's impact.",
  "Total Cost":
    "Required Quantity to Order multiplied by Supplier Cost. The export metadata includes the total estimated order cost.",
  "Safety Buffer":
    "Extra units added on top of expected demand to protect against volatility, forecast error, and stockout risk.",
  "Demand Pattern":
    "How the demand history behaves: stable, trending, seasonal, intermittent, or new-item. Each row includes a short explanation.",
  "Model Used":
    "The forecasting method selected for the row, plus a short explanation of how it shaped the required quantity.",
  Confidence:
    "Confidence reflects how trustworthy the forecast is for the row based on history depth, forecast error, stockout risk, and fallback logic.",
};

function excelDateLabel(value: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

function formatCurrency(value: number | null) {
  if (value == null) return "";
  return Number(value.toFixed(2));
}

function demandPatternCell(line: ForecastLineResult) {
  const labels: Record<string, [string, string]> = {
    STABLE: ["STABLE", "Sales are fairly steady period to period."],
    TRENDING: ["TRENDING", "Sales are moving up or down over time."],
    SEASONAL: ["SEASONAL", "Sales repeat a recent weekly or seasonal pattern."],
    INTERMITTENT: ["INTERMITTENT", "Sales arrive in bursts with quiet gaps between them."],
    SLOW_MOVER: ["SLOW MOVER", "This item has very few or no sales in the lookback window. It is an established listing, not a new one."],
    NEW_ITEM: ["NEW ITEM", "This listing was created recently and does not have enough history yet."],
  };
  const [label, desc] = labels[line.demandPattern] ?? ["LIMITED RECENT HISTORY", "The selected lookback has thin recent history, so the forecast uses a simpler fallback."];
  return `${label} - ${desc}`;
}

function modelExplanation(model: string) {
  const map: Record<string, string> = {
    "Recent average": "Projects the recent average demand forward.",
    "Weighted moving average": "Leans more heavily on the most recent demand periods.",
    "ETS / exponential smoothing": "Extends the recent level and trend forward.",
    "Seasonal method": "Repeats the recent seasonal or weekly pattern.",
    "Croston / SBA": "Handles intermittent demand with gaps between sales.",
    "Low-history fallback": "Uses a cautious fallback because history is still thin.",
  };
  return map[model] ?? "Uses the best-fit model for the row's demand pattern.";
}

function flatAvgEstimate(line: ForecastLineResult, totalDays: number) {
  const simpleDemand = line.averageDailyDemand * totalDays;
  const simpleGross = simpleDemand + line.safetyBuffer;
  const simpleNet = Math.max(0, simpleGross - line.currentInventory - line.openInTransitQty);
  return Math.ceil(simpleNet / 5) * 5;
}

function lineValues(line: ForecastLineResult, totalDays: number) {
  const totalCost = line.supplierCost != null ? formatCurrency(line.finalQty * line.supplierCost) : "";
  const modelImpact =
    `${line.modelUsed} - ${modelExplanation(line.modelUsed)} ` +
    `Gross need ${line.grossRequiredQty}; current ${line.currentInventory}; inbound ${line.openInTransitQty}; final qty ${line.finalQty}.`;
  const confText = `${line.confidence} - ${line.confidenceNote.replace(/^(High|Medium|Low) confidence because\s+/i, "").replace(/\.$/, "")}.`;

  return [
    line.title,
    line.upc ?? "",
    line.sku,
    "",
    line.finalQty,
    flatAvgEstimate(line, totalDays),
    formatCurrency(line.supplierCost),
    totalCost,
    line.salesHistorySummary,
    line.grossRequiredQty,
    line.currentInventory,
    line.safetyBuffer,
    line.openInTransitQty,
    excelDateLabel(line.openInTransitEta),
    demandPatternCell(line),
    modelImpact,
    confText,
  ];
}

function metadataItems(result: ForecastResult) {
  const totalSuggestedUnits = result.lines.reduce((s, l) => s + l.finalQty, 0);
  const totalOrderCost = result.lines.reduce(
    (s, l) => s + (l.supplierCost != null ? l.finalQty * l.supplierCost : 0), 0,
  );
  const rowsMissingCost = result.lines.filter((l) => l.finalQty > 0 && l.supplierCost == null).length;
  return [
    { label: "Run Date/Time", value: new Date(result.runDateTime).toLocaleString("en-US") },
    { label: "Lookback Days", value: result.controls.lookbackDays },
    { label: "Transit Days", value: result.controls.transitDays },
    { label: "Desired Days After Arrival", value: result.controls.desiredCoverageDays },
    { label: "Forecast Bucket", value: result.controls.forecastBucket },
    { label: "Mode", value: result.controls.mode },
    { label: "Inventory Source", value: result.inventorySource },
    {
      label: "Sales Coverage",
      value:
        result.salesSync.earliestCoveredAt && result.salesSync.latestCoveredAt
          ? `${excelDateLabel(result.salesSync.earliestCoveredAt)} to ${excelDateLabel(result.salesSync.latestCoveredAt)}`
          : "Not calculated",
    },
    { label: "Reorder SKU Count", value: result.lines.filter((l) => l.finalQty > 0).length },
    { label: "Total Suggested Units", value: totalSuggestedUnits },
    { label: "Estimated Total Order Cost", value: totalOrderCost },
    { label: "Rows Missing Supplier Cost", value: rowsMissingCost },
  ];
}

async function fetchProductImage(url: string | null, signal?: AbortSignal): Promise<FetchedImage> {
  if (!url) return null;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), IMAGE_TIMEOUT_MS);
    if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });
    const res = await fetch(`/api/image-proxy?url=${encodeURIComponent(url)}`, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    const buf = await res.arrayBuffer();
    let ext: ImgExt = "jpeg";
    if (ct.includes("png") || url.toLowerCase().includes(".png")) ext = "png";
    else if (ct.includes("gif") || url.toLowerCase().includes(".gif")) ext = "gif";
    return { buffer: buf, extension: ext };
  } catch {
    return null;
  }
}

type BarcodeResult = { buffer: ArrayBuffer; width: number; height: number } | null;

let _bwipToCanvas: ((canvas: HTMLCanvasElement, opts: Record<string, unknown>) => void) | null = null;

async function loadBwip() {
  if (_bwipToCanvas) return _bwipToCanvas;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import("bwip-js" as any);
    const fn = mod.toCanvas ?? mod.default?.toCanvas;
    if (typeof fn === "function") { _bwipToCanvas = fn; return fn; }
  } catch { /* bwip-js not available in browser — skip barcodes */ }
  return null;
}

async function generateBarcode(upc: string | null): Promise<BarcodeResult> {
  if (!upc || typeof document === "undefined") return null;
  const toCanvas = await loadBwip();
  if (!toCanvas) return null;

  const digits = upc.replace(/\D/g, "");
  const configs = [
    digits.length === 12 ? { bcid: "upca", text: digits } :
    digits.length === 13 ? { bcid: "ean13", text: digits } :
    { bcid: "code128", text: upc },
    { bcid: "code128", text: upc },
  ];

  const canvas = document.createElement("canvas");
  for (const cfg of configs) {
    try {
      toCanvas(canvas, { ...cfg, scale: 2, height: 18, includetext: false, backgroundcolor: "FFFFFF" } as Record<string, unknown>);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) continue;
      return { buffer: await blob.arrayBuffer(), width: canvas.width, height: canvas.height };
    } catch { continue; }
  }
  return null;
}

function demandPatternGuide(pattern: string) {
  const guides: Record<string, [string, string, string]> = {
    NEW_ITEM: ["Demand Pattern: New item", "A recently listed item without enough sales history for reliable forecasting.", "Example: a listing created in the last 45 days without enough data yet."],
    SLOW_MOVER: ["Demand Pattern: Slow mover", "An established item with very few or no recent sales. Not a new listing — just low recent activity.", "Example: an item that has been listed for months but has very few or no sales in the lookback window."],
  };
  return guides[pattern];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addGuideSheet(workbook: any) {
  const ws = workbook.addWorksheet("Forecast Guide");
  ws.columns = [{ width: 28 }, { width: 58 }, { width: 56 }];

  ws.mergeCells("A1:C1");
  ws.getCell("A1").value = "How To Read This Forecast";
  ws.getCell("A1").font = { size: 16, bold: true };
  ws.getCell("A1").alignment = { vertical: "middle", horizontal: "left" };

  ws.mergeCells("A2:C2");
  ws.getCell("A2").value =
    "This sheet explains the export in plain language. Use the main sheet for purchasing decisions and this guide for definitions and examples.";
  ws.getCell("A2").alignment = { wrapText: true };

  const sections: [string, string, string][] = [
    ["Forecast Bucket", "Weekly groups demand into week-sized chunks and is usually best for purchasing. Daily looks at demand day by day and is better for tighter timing.", "Example: 28 units over 4 weeks can be read as about 7 per week, or about 1 per day."],
    ["Use open in-transit supplier orders", "When enabled, the forecast subtracts internal supplier orders already marked Ordered or In Transit so you do not order the same stock twice.", "Example: if you need 40 units and 15 are already on the way, the new recommendation drops to about 25."],
    ["Show only reorder-relevant SKUs", "When enabled, the export/page focuses on SKUs that need action now, such as rows with a positive order quantity or important warnings.", "Example: if 2,000 SKUs exist but only 85 need action, this filter keeps attention on the 85."],
    ...(demandPatternGuide("NEW_ITEM") ? [demandPatternGuide("NEW_ITEM")!] : []),
    ...(demandPatternGuide("SLOW_MOVER") ? [demandPatternGuide("SLOW_MOVER")!] : []),
  ];

  let r = 4;
  for (const [label, meaning, example] of sections) {
    ws.getRow(r).values = [label, meaning, example];
    ws.getRow(r).height = 40;
    r += 1;
  }

  r += 1;
  ws.getRow(r).values = ["Column", "What it means", "Simple example"];
  ws.getRow(r).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(r).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
  ws.getRow(r).alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  ws.views = [{ state: "frozen", ySplit: r }];

  const colGuide: [string, string, string][] = [
    ["Product Title", "The product name tied to the SKU row.", "Used to visually identify the item."],
    ["UPC", "The UPC code stored for the SKU.", "Blank means no UPC was available."],
    ["SKU", "Internal SKU used to join sales and inventory.", "This is the main row identifier across the forecast."],
    ["Product Image", "Reference image pulled into the sheet.", "Helps the buyer visually confirm the item."],
    ["Required Quantity to Order", HEADER_NOTES["Required Quantity to Order"], "19 becomes 20, 23 becomes 25, 96 becomes 100."],
    ["Flat Avg. Estimate", HEADER_NOTES["Flat Avg. Estimate"], "If avg demand is 0.3/day over 165 days: 0.3 x 165 = 49.5 + buffer − stock = simple order qty. Compare with the model column to see the difference."],
    ["Supplier Cost", "Unit supplier cost stored for the SKU.", "$2.50 means each ordered unit costs $2.50 before shipping."],
    ["Total Cost", HEADER_NOTES["Total Cost"], "25 units x $2.50 supplier cost = $62.50 total cost."],
    ["Sales History Summary", "Shows units sold inside the selected lookback plus the average daily rate.", "4 total | 10d | 0.4/day means 4 units sold over the last 10 days."],
    ["Gross Required Quantity (Before Current On Hand)", "The total need before subtracting current inventory and qualifying inbound units.", "Transit demand + post-arrival demand + safety buffer."],
    ["Current Available Inventory", "Live on-hand inventory used as the current stock number.", "If this is 25, the forecast assumes 25 units are available now."],
    ["Safety Buffer", HEADER_NOTES["Safety Buffer"], "If expected demand is 30 and buffer is 9, the forecast protects against running too lean."],
    ["Open In-Transit Quantity", "Units already on the way from internal supplier orders that qualify for subtraction.", "Only Ordered or In Transit orders count here."],
    ["Open In-Transit ETA", "Earliest ETA from qualifying inbound supplier orders.", "Used to decide whether inbound stock arrives in time to help."],
    ["Demand Pattern", "How the recent sales history behaves.", "Stable, Trending, Seasonal, Intermittent, or Limited recent history."],
    ["Model Used", "The forecasting method chosen for that SKU, plus a short explanation of how it shaped the quantity.", "Low-history fallback means the system used a simpler cautious method because the selected lookback was thin."],
    ["Confidence", "How trustworthy the row's forecast is based on history depth, forecast error, stockout signals, and fallback logic.", "Low confidence means use extra judgment before buying heavily."],
  ];

  const border = {
    top: { style: "thin" as const, color: { argb: "FF374151" } },
    left: { style: "thin" as const, color: { argb: "FF374151" } },
    bottom: { style: "thin" as const, color: { argb: "FF374151" } },
    right: { style: "thin" as const, color: { argb: "FF374151" } },
  };

  colGuide.forEach(([header, meaning, example], idx) => {
    const row = ws.getRow(r + 1 + idx);
    row.values = [header, meaning, example];
    row.height = 34;
    row.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row.eachCell((cell: any) => { cell.border = border; });
  });
}

export async function buildForecastWorkbookOnClient(
  result: ForecastResult,
  onProgress: (p: ExportProgress) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  onProgress({ phase: "preparing", percent: 2, message: "Loading spreadsheet engine..." });

  const ExcelJS = await import("exceljs");
  if (signal?.aborted) throw new Error("Cancelled");

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("Inventory Forecast");
  const HEADERS = EXPORT_COLUMNS.map((c) => c.header);
  const headerRow = 5;

  EXPORT_COLUMNS.forEach((col, i) => { ws.getColumn(i + 1).width = col.width; });

  for (let r = 1; r < headerRow; r++) {
    ws.getRow(r).height = r === 1 ? 28 : r === 2 ? 36 : 24;
    ws.getRow(r).alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  }
  ws.getRow(headerRow).height = 28;
  ws.getRow(headerRow).alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  ws.getRow(headerRow).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
  ws.getRow(headerRow).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.views = [{ state: "frozen", ySplit: headerRow }];

  ws.mergeCells(1, 1, 1, EXPORT_COLUMNS.length);
  ws.getCell(1, 1).value = "Inventory Forecast Export";
  ws.getCell(1, 1).font = { size: 16, bold: true };
  ws.getCell(1, 1).alignment = { vertical: "middle", horizontal: "left" };

  const metadata = metadataItems(result);
  metadata.forEach((item, i) => {
    const c = i + 1;
    ws.getCell(2, c).value = item.label;
    ws.getCell(2, c).font = { bold: true, size: 10, color: { argb: "FF1F2937" } };
    ws.getCell(2, c).alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    ws.getCell(2, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
    ws.getCell(3, c).value = item.value as string | number;
    ws.getCell(3, c).alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
  ws.getRow(3).height = 30;
  const costIdx = metadata.findIndex((m) => m.label === "Estimated Total Order Cost");
  if (costIdx >= 0) ws.getCell(3, costIdx + 1).numFmt = "$#,##0.00";

  ws.getRow(headerRow).values = [...HEADERS];
  HEADERS.forEach((h, i) => {
    const note = HEADER_NOTES[h];
    if (note) ws.getCell(headerRow, i + 1).note = note;
  });

  onProgress({ phase: "preparing", percent: 5, message: "Preparing rows..." });

  const sorted = [...result.lines].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );

  const images: FetchedImage[] = new Array(sorted.length).fill(null);
  const barcodes: BarcodeResult[] = new Array(sorted.length).fill(null);
  let fetched = 0;
  let failed = 0;
  const total = sorted.length;

  for (let start = 0; start < sorted.length; start += IMAGE_BATCH) {
    if (signal?.aborted) throw new Error("Cancelled");
    const end = Math.min(start + IMAGE_BATCH, sorted.length);
    const batch = sorted.slice(start, end);

    const results = await Promise.allSettled(
      batch.flatMap((line, i) => [
        fetchProductImage(line.imageUrl, signal).then((r) => { images[start + i] = r; }),
        generateBarcode(line.upc).then((r) => { barcodes[start + i] = r; }),
      ]),
    );

    for (let i = 0; i < batch.length; i++) {
      const imgResult = results[i * 2];
      if (imgResult.status !== "fulfilled" || !images[start + i]) failed++;
      fetched++;
    }

    const pct = 5 + Math.round((fetched / total) * 75);
    onProgress({
      phase: "images",
      percent: pct,
      message: `Fetching images & barcodes... (${fetched} / ${total})`,
      imageStats: { fetched, failed, total },
    });
  }

  onProgress({ phase: "building", percent: 82, message: "Building rows..." });

  const border = {
    top: { style: "thin" as const, color: { argb: "FF374151" } },
    left: { style: "thin" as const, color: { argb: "FF374151" } },
    bottom: { style: "thin" as const, color: { argb: "FF374151" } },
    right: { style: "thin" as const, color: { argb: "FF374151" } },
  };

  const imgColIdx = HEADERS.indexOf("Product Image") + 1;
  const upcColIdx = HEADERS.indexOf("UPC") + 1;
  const totalDays = result.controls.transitDays + result.controls.desiredCoverageDays;

  for (let idx = 0; idx < sorted.length; idx++) {
    const line = sorted[idx];
    const rowNum = headerRow + 1 + idx;
    const row = ws.getRow(rowNum);
    row.values = lineValues(line, totalDays);
    row.height = 108;
    row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row.eachCell((cell: any) => {
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = border;
    });

    if (upcColIdx > 0) {
      const upcCell = ws.getCell(rowNum, upcColIdx);
      upcCell.numFmt = "@";
      upcCell.alignment = { vertical: "bottom", horizontal: "center", wrapText: false };
    }

    const costCol = HEADERS.indexOf("Supplier Cost") + 1;
    const totalCostCol = HEADERS.indexOf("Total Cost") + 1;
    ws.getCell(rowNum, costCol).numFmt = "$#,##0.00";
    ws.getCell(rowNum, totalCostCol).numFmt = "$#,##0.00";

    if (line.supplierCost == null && line.finalQty > 0) {
      ws.getCell(rowNum, costCol).fill = {
        type: "pattern", pattern: "solid", fgColor: { argb: "33DC2626" },
      };
      ws.getCell(rowNum, costCol).font = { color: { argb: "FFEF4444" } };
      ws.getCell(rowNum, totalCostCol).fill = {
        type: "pattern", pattern: "solid", fgColor: { argb: "33DC2626" },
      };
      ws.getCell(rowNum, totalCostCol).font = { color: { argb: "FFEF4444" } };
    }

    const barcode = barcodes[idx];
    if (barcode && upcColIdx > 0) {
      try {
        const bcId = workbook.addImage({ buffer: barcode.buffer, extension: "png" });
        const colW = ws.getColumn(upcColIdx).width ?? 24;
        const colPx = Math.round(colW * 7 + 5);
        const fitW = Math.min(barcode.width, BARCODE_MAX_WIDTH, colPx - 8);
        const fitH = Math.min(barcode.height, BARCODE_MAX_HEIGHT);
        const xOff = Math.max(0, (colPx - fitW) / 2);
        ws.addImage(bcId, {
          tl: { col: upcColIdx - 1 + xOff / Math.max(1, colW), row: rowNum - 1 + 4 / Math.max(1, 108) },
          ext: { width: fitW, height: fitH },
          editAs: "oneCell",
        });
      } catch { /* skip barcode */ }
    }

    const img = images[idx];
    if (img && imgColIdx > 0) {
      try {
        const imageId = workbook.addImage({
          buffer: img.buffer,
          extension: img.extension,
        });
        const colW = ws.getColumn(imgColIdx).width ?? 18;
        const rowH = 108;
        const maxPx = PRODUCT_IMAGE_SIZE;
        const colPx = Math.round(colW * 7 + 5);
        const rowPx = Math.round(rowH * (4 / 3));
        const xOff = Math.max(0, (colPx - maxPx) / 2);
        const yOff = Math.max(0, (rowPx - maxPx) / 2);
        ws.addImage(imageId, {
          tl: {
            col: imgColIdx - 1 + xOff / Math.max(1, colW),
            row: rowNum - 1 + yOff / Math.max(1, rowH),
          },
          ext: { width: maxPx, height: maxPx },
          editAs: "oneCell",
        });
      } catch {
        /* skip this image */
      }
    }

    if (idx % 100 === 0) {
      const buildPct = 82 + Math.round((idx / sorted.length) * 10);
      onProgress({ phase: "building", percent: buildPct, message: `Building rows... (${idx} / ${sorted.length})` });
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  addGuideSheet(workbook);

  onProgress({ phase: "generating", percent: 95, message: "Generating spreadsheet file..." });
  await new Promise((r) => setTimeout(r, 0));

  const buf = await workbook.xlsx.writeBuffer();

  onProgress({ phase: "done", percent: 100, message: "Done!", imageStats: { fetched, failed, total } });

  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function forecastExportFileName(runDateTime: string) {
  const date = new Date(runDateTime);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `Inventory_Forecast_${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}.xlsx`;
}
