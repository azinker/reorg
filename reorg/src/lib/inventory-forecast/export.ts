import ExcelJS from "exceljs";
import bwipjs from "bwip-js";
import type { ForecastLineResult, ForecastResult } from "@/lib/inventory-forecast/types";

type WorkbookImageExtension = "png" | "jpeg" | "gif";

const EXPORT_COLUMNS = [
  { header: "Product Title", width: 45 },
  { header: "UPC Image", width: 20 },
  { header: "UPC", width: 18 },
  { header: "SKU", width: 45 },
  { header: "Product Image", width: 18 },
  { header: "Required Quantity to Order", width: 30 },
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

const EXPORT_HEADERS = EXPORT_COLUMNS.map((column) => column.header);
const PRODUCT_IMAGE_SIZE = 112;
const BARCODE_MAX_WIDTH = 125;
const BARCODE_MAX_HEIGHT = 68;

const HEADER_NOTES: Record<string, string> = {
  "Required Quantity to Order":
    "This is the final order quantity for the row. System recommendations round up to the next multiple of 5.",
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

function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number) {
  if (width <= 0 || height <= 0) {
    return { width: maxWidth, height: maxHeight };
  }
  const ratio = Math.min(maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

function excelColumnWidthToPixels(width: number) {
  return Math.round(width * 7 + 5);
}

function excelRowHeightToPixels(heightPoints: number) {
  return Math.round(heightPoints * (4 / 3));
}

function getImageDimensions(buffer: Buffer, extension: WorkbookImageExtension) {
  if (extension === "png" && buffer.length >= 24) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  if (extension === "gif" && buffer.length >= 10) {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }

  if (extension === "jpeg") {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = buffer[offset + 1];
      const blockLength = buffer.readUInt16BE(offset + 2);
      const isStartOfFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker);

      if (isStartOfFrame && offset + 9 < buffer.length) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }

      if (!Number.isFinite(blockLength) || blockLength <= 2) break;
      offset += 2 + blockLength;
    }
  }

  return { width: 1, height: 1 };
}

function excelDateLabel(value: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function buildBarcodeFormat(upc: string) {
  const digits = upc.replace(/\D/g, "");
  if (digits.length === 12) return { bcid: "upca", text: digits };
  if (digits.length === 13) return { bcid: "ean13", text: digits };
  return { bcid: "code128", text: upc };
}

async function buildBarcodeBuffer(upc: string | null) {
  if (!upc) return null;
  const configs = [buildBarcodeFormat(upc), { bcid: "code128", text: upc }] as const;

  for (const config of configs) {
    try {
      return await bwipjs.toBuffer({
        ...config,
        scale: 2,
        height: 18,
        includetext: false,
        backgroundcolor: "FFFFFF",
      });
    } catch {
      continue;
    }
  }

  return null;
}

async function fetchImageBuffer(url: string | null) {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (contentType.includes("png")) return { buffer, extension: "png" as const };
    if (contentType.includes("gif")) return { buffer, extension: "gif" as const };
    if (contentType.includes("jpeg") || contentType.includes("jpg")) {
      return { buffer, extension: "jpeg" as const };
    }
    if (url.toLowerCase().includes(".png")) return { buffer, extension: "png" as const };
    if (url.toLowerCase().includes(".gif")) return { buffer, extension: "gif" as const };
    if (url.toLowerCase().match(/\.(jpe?g)(\?|$)/)) {
      return { buffer, extension: "jpeg" as const };
    }
    return null;
  } catch {
    return null;
  }
}

async function addImageToCell(args: {
  workbook: ExcelJS.Workbook;
  worksheet: ExcelJS.Worksheet;
  rowNumber: number;
  columnNumber: number;
  buffer: Buffer;
  extension: WorkbookImageExtension;
  maxWidth: number;
  maxHeight: number;
}) {
  const imageId = args.workbook.addImage({
    // ExcelJS's bundled Buffer typing lags behind current Node typings.
    buffer: args.buffer as never,
    extension: args.extension,
  });
  const dimensions = getImageDimensions(args.buffer, args.extension);
  const fitted = fitWithin(
    dimensions.width,
    dimensions.height,
    args.maxWidth,
    args.maxHeight,
  );
  const columnWidthUnits = args.worksheet.getColumn(args.columnNumber).width ?? 12;
  const rowHeightPoints = args.worksheet.getRow(args.rowNumber).height ?? 20;
  const columnWidth = excelColumnWidthToPixels(columnWidthUnits);
  const rowHeight = excelRowHeightToPixels(rowHeightPoints);
  const xOffset = Math.max(0, (columnWidth - fitted.width) / 2);
  const yOffset = Math.max(0, (rowHeight - fitted.height) / 2);

  args.worksheet.addImage(imageId, {
    tl: {
      col: args.columnNumber - 1 + xOffset / Math.max(1, columnWidthUnits),
      row: args.rowNumber - 1 + yOffset / Math.max(1, rowHeightPoints),
    },
    ext: { width: fitted.width, height: fitted.height },
    editAs: "oneCell",
  });
}

async function addProductImage(
  workbook: ExcelJS.Workbook,
  worksheet: ExcelJS.Worksheet,
  rowNumber: number,
  columnNumber: number,
  imageUrl: string | null,
) {
  const image = await fetchImageBuffer(imageUrl);
  if (!image) return;
  await addImageToCell({
    workbook,
    worksheet,
    rowNumber,
    columnNumber,
    buffer: image.buffer,
    extension: image.extension,
    maxWidth: PRODUCT_IMAGE_SIZE,
    maxHeight: PRODUCT_IMAGE_SIZE,
  });
}

async function addBarcodeImage(
  workbook: ExcelJS.Workbook,
  worksheet: ExcelJS.Worksheet,
  rowNumber: number,
  columnNumber: number,
  upc: string | null,
) {
  const buffer = await buildBarcodeBuffer(upc);
  if (!buffer) return;
  await addImageToCell({
    workbook,
    worksheet,
    rowNumber,
    columnNumber,
    buffer,
    extension: "png",
    maxWidth: BARCODE_MAX_WIDTH,
    maxHeight: BARCODE_MAX_HEIGHT,
  });
}

function styleWorksheet(worksheet: ExcelJS.Worksheet, headerRowNumber: number) {
  EXPORT_COLUMNS.forEach((column, index) => {
    worksheet.getColumn(index + 1).width = column.width;
  });

  for (let rowNumber = 1; rowNumber < headerRowNumber; rowNumber += 1) {
    worksheet.getRow(rowNumber).height = rowNumber === 1 ? 28 : rowNumber === 2 ? 36 : 24;
    worksheet.getRow(rowNumber).alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true,
    };
  }

  worksheet.getRow(headerRowNumber).height = 28;
  worksheet.getRow(headerRowNumber).alignment = {
    vertical: "middle",
    horizontal: "center",
    wrapText: true,
  };
  worksheet.getRow(headerRowNumber).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F2937" },
  };
  worksheet.getRow(headerRowNumber).font = {
    bold: true,
    color: { argb: "FFFFFFFF" },
  };
  worksheet.views = [{ state: "frozen", ySplit: headerRowNumber }];
}

function metadataItems(result: ForecastResult) {
  const totalSuggestedUnits = result.lines.reduce((sum, line) => sum + line.finalQty, 0);
  const totalOrderCost = result.lines.reduce(
    (sum, line) => sum + (line.supplierCost != null ? line.finalQty * line.supplierCost : 0),
    0,
  );
  const rowsMissingSupplierCost = result.lines.filter(
    (line) => line.finalQty > 0 && line.supplierCost == null,
  ).length;

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
    { label: "Reorder SKU Count", value: result.lines.filter((line) => line.finalQty > 0).length },
    { label: "Total Suggested Units", value: totalSuggestedUnits },
    { label: "Estimated Total Order Cost", value: totalOrderCost },
    { label: "Rows Missing Supplier Cost", value: rowsMissingSupplierCost },
  ];
}

function formatCurrency(value: number | null) {
  if (value == null) return "";
  return Number(value.toFixed(2));
}

function demandPatternLabel(line: ForecastLineResult) {
  switch (line.demandPattern) {
    case "STABLE":
      return "STABLE";
    case "TRENDING":
      return "TRENDING";
    case "SEASONAL":
      return "SEASONAL";
    case "INTERMITTENT":
      return "INTERMITTENT";
    case "SLOW_MOVER":
      return "SLOW MOVER";
    case "NEW_ITEM":
      return "NEW ITEM";
    default:
      return "LIMITED RECENT HISTORY";
  }
}

function demandPatternExplanation(line: ForecastLineResult) {
  switch (line.demandPattern) {
    case "STABLE":
      return "Sales are fairly steady period to period.";
    case "TRENDING":
      return "Sales are moving up or down over time.";
    case "SEASONAL":
      return "Sales repeat a recent weekly or seasonal pattern.";
    case "INTERMITTENT":
      return "Sales arrive in bursts with quiet gaps between them.";
    case "SLOW_MOVER":
      return "This item has very few or no sales in the lookback window. It is an established listing, not a new one.";
    case "NEW_ITEM":
      return "This listing was created recently and does not have enough history yet.";
    default:
      return "The selected lookback has thin recent history, so the forecast uses a simpler fallback.";
  }
}

function demandPatternGuide(pattern: ForecastLineResult["demandPattern"]) {
  switch (pattern) {
    case "STABLE":
      return "Demand is relatively even from period to period.";
    case "TRENDING":
      return "Demand is moving upward or downward over time.";
    case "SEASONAL":
      return "Demand repeats a recognizable weekly or seasonal pattern.";
    case "INTERMITTENT":
      return "Demand comes in bursts with quiet gaps between them.";
    case "SLOW_MOVER":
      return "An established item with very few or no recent sales. Not a new listing — just low recent activity.";
    case "NEW_ITEM":
      return "A recently listed item without enough sales history for reliable forecasting.";
    default:
      return "Recent history inside the selected lookback is thin.";
  }
}

function modelExplanation(modelUsed: string) {
  switch (modelUsed) {
    case "Recent average":
      return "Projects the recent average demand forward.";
    case "Weighted moving average":
      return "Leans more heavily on the most recent demand periods.";
    case "ETS / exponential smoothing":
      return "Extends the recent level and trend forward.";
    case "Seasonal method":
      return "Repeats the recent seasonal or weekly pattern.";
    case "Croston / SBA":
      return "Handles intermittent demand with gaps between sales.";
    case "Low-history fallback":
      return "Uses a cautious fallback because history is still thin.";
    default:
      return "Uses the best-fit model for the row's demand pattern.";
  }
}

function confidenceExplanation(line: ForecastLineResult) {
  return `${line.confidence} - ${line.confidenceNote.replace(/^(High|Medium|Low) confidence because\s+/i, "").replace(/\.$/, "")}.`;
}

function lineValues(line: ForecastLineResult) {
  const totalCost =
    line.supplierCost != null ? formatCurrency(line.finalQty * line.supplierCost) : "";
  const modelImpact =
    `${line.modelUsed} - ${modelExplanation(line.modelUsed)} ` +
    `Gross need ${line.grossRequiredQty}; current ${line.currentInventory}; inbound ${line.openInTransitQty}; final qty ${line.finalQty}.`;

  return [
    line.title,
    "",
    line.upc ?? "",
    line.sku,
    "",
    line.finalQty,
    formatCurrency(line.supplierCost),
    totalCost,
    line.salesHistorySummary,
    line.grossRequiredQty,
    line.currentInventory,
    line.safetyBuffer,
    line.openInTransitQty,
    excelDateLabel(line.openInTransitEta),
    `${demandPatternLabel(line)} - ${demandPatternExplanation(line)}`,
    modelImpact,
    confidenceExplanation(line),
  ];
}

function addGuideSheet(workbook: ExcelJS.Workbook) {
  const worksheet = workbook.addWorksheet("Forecast Guide");
  worksheet.columns = [
    { width: 28 },
    { width: 58 },
    { width: 56 },
  ];

  worksheet.mergeCells("A1:C1");
  worksheet.getCell("A1").value = "How To Read This Forecast";
  worksheet.getCell("A1").font = { size: 16, bold: true };
  worksheet.getCell("A1").alignment = { vertical: "middle", horizontal: "left" };

  worksheet.mergeCells("A2:C2");
  worksheet.getCell("A2").value =
    "This sheet explains the export in plain language. Use the main sheet for purchasing decisions and this guide for definitions and examples.";
  worksheet.getCell("A2").alignment = { wrapText: true };

  const sections: Array<[string, string, string]> = [
    [
      "Forecast Bucket",
      "Weekly groups demand into week-sized chunks and is usually best for purchasing. Daily looks at demand day by day and is better for tighter timing.",
      "Example: 28 units over 4 weeks can be read as about 7 per week, or about 1 per day.",
    ],
    [
      "Use open in-transit supplier orders",
      "When enabled, the forecast subtracts internal supplier orders already marked Ordered or In Transit so you do not order the same stock twice.",
      "Example: if you need 40 units and 15 are already on the way, the new recommendation drops to about 25.",
    ],
    [
      "Show only reorder-relevant SKUs",
      "When enabled, the export/page focuses on SKUs that need action now, such as rows with a positive order quantity or important warnings.",
      "Example: if 2,000 SKUs exist but only 85 need action, this filter keeps attention on the 85.",
    ],
    [
      "Demand Pattern: New item",
      demandPatternGuide("NEW_ITEM"),
      "Example: a listing created in the last 45 days without enough data yet.",
    ],
    [
      "Demand Pattern: Slow mover",
      demandPatternGuide("SLOW_MOVER" as ForecastLineResult["demandPattern"]),
      "Example: an item that has been listed for months but has very few or no sales in the lookback window.",
    ],
  ];

  let rowNumber = 4;
  sections.forEach(([label, meaning, example]) => {
    worksheet.getRow(rowNumber).values = [label, meaning, example];
    worksheet.getRow(rowNumber).height = 40;
    rowNumber += 1;
  });

  rowNumber += 1;
  worksheet.getRow(rowNumber).values = ["Column", "What it means", "Simple example"];
  worksheet.getRow(rowNumber).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(rowNumber).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F2937" },
  };
  worksheet.getRow(rowNumber).alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  worksheet.views = [{ state: "frozen", ySplit: rowNumber }];

  const columnGuide: Array<[string, string, string]> = [
    ["Product Title", "The product name tied to the SKU row.", "Used to visually identify the item."],
    ["UPC Image", "Barcode image generated from the UPC when available.", "Scan this with a barcode scanner if needed."],
    ["UPC", "The UPC code stored for the SKU.", "Blank means no UPC was available."],
    ["SKU", "Internal SKU used to join sales and inventory.", "This is the main row identifier across the forecast."],
    ["Product Image", "Reference image pulled into the sheet.", "Helps the buyer visually confirm the item."],
    ["Required Quantity to Order", HEADER_NOTES["Required Quantity to Order"], "19 becomes 20, 23 becomes 25, 96 becomes 100."],
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

  columnGuide.forEach(([header, meaning, example], index) => {
    const row = worksheet.getRow(rowNumber + 1 + index);
    row.values = [header, meaning, example];
    row.height = 34;
    row.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    row.eachCell((cell) => {
      cell.border = {
        top: { style: "thin", color: { argb: "FF374151" } },
        left: { style: "thin", color: { argb: "FF374151" } },
        bottom: { style: "thin", color: { argb: "FF374151" } },
        right: { style: "thin", color: { argb: "FF374151" } },
      };
    });
  });
}

export async function buildInventoryForecastWorkbook(result: ForecastResult) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Inventory Forecast");
  const metadata = metadataItems(result);
  const headerRowNumber = 5;
  styleWorksheet(worksheet, headerRowNumber);

  worksheet.mergeCells(1, 1, 1, EXPORT_COLUMNS.length);
  worksheet.getCell(1, 1).value = "Inventory Forecast Export";
  worksheet.getCell(1, 1).font = { size: 16, bold: true };
  worksheet.getCell(1, 1).alignment = { vertical: "middle", horizontal: "left" };

  metadata.forEach((item, index) => {
    const columnNumber = index + 1;
    worksheet.getCell(2, columnNumber).value = item.label;
    worksheet.getCell(2, columnNumber).font = {
      bold: true,
      size: 10,
      color: { argb: "FF1F2937" },
    };
    worksheet.getCell(2, columnNumber).alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true,
    };
    worksheet.getCell(2, columnNumber).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE5E7EB" },
    };
    worksheet.getCell(3, columnNumber).value = item.value as string | number;
    worksheet.getCell(3, columnNumber).alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true,
    };
  });
  worksheet.getRow(3).height = 30;
  const orderCostIndex = metadata.findIndex((item) => item.label === "Estimated Total Order Cost");
  if (orderCostIndex >= 0) {
    worksheet.getCell(3, orderCostIndex + 1).numFmt = '$#,##0.00';
  }

  worksheet.getRow(headerRowNumber).values = [...EXPORT_HEADERS];
  EXPORT_HEADERS.forEach((header, index) => {
    const note = HEADER_NOTES[header];
    if (!note) return;
    worksheet.getCell(headerRowNumber, index + 1).note = note;
  });

  const sortedLines = [...result.lines].sort((left, right) =>
    left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
  );

  type PrefetchedImage = { buffer: Buffer; extension: WorkbookImageExtension } | null;
  const IMAGE_BATCH = 50;
  const productImages: PrefetchedImage[] = new Array(sortedLines.length).fill(null);
  const barcodeBuffers: (Buffer | null)[] = new Array(sortedLines.length).fill(null);

  for (let start = 0; start < sortedLines.length; start += IMAGE_BATCH) {
    const end = Math.min(start + IMAGE_BATCH, sortedLines.length);
    await Promise.allSettled(
      sortedLines.slice(start, end).flatMap((line, i) => [
        fetchImageBuffer(line.imageUrl).then((r) => { productImages[start + i] = r; }),
        buildBarcodeBuffer(line.upc).then((r) => { barcodeBuffers[start + i] = r; }),
      ]),
    );
  }

  for (let index = 0; index < sortedLines.length; index += 1) {
    const line = sortedLines[index];
    const rowNumber = headerRowNumber + 1 + index;
    const row = worksheet.getRow(rowNumber);
    row.values = lineValues(line);
    row.height = 108;
    row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    row.eachCell((cell) => {
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = {
        top: { style: "thin", color: { argb: "FF374151" } },
        left: { style: "thin", color: { argb: "FF374151" } },
        bottom: { style: "thin", color: { argb: "FF374151" } },
        right: { style: "thin", color: { argb: "FF374151" } },
      };
    });
    worksheet.getCell(rowNumber, 7).numFmt = '$#,##0.00';
    worksheet.getCell(rowNumber, 8).numFmt = '$#,##0.00';

    if (line.supplierCost == null && line.finalQty > 0) {
      worksheet.getCell(rowNumber, 7).fill = {
        type: "pattern", pattern: "solid", fgColor: { argb: "33DC2626" },
      };
      worksheet.getCell(rowNumber, 7).font = { color: { argb: "FFEF4444" } };
      worksheet.getCell(rowNumber, 8).fill = {
        type: "pattern", pattern: "solid", fgColor: { argb: "33DC2626" },
      };
      worksheet.getCell(rowNumber, 8).font = { color: { argb: "FFEF4444" } };
    }

    const barcode = barcodeBuffers[index];
    if (barcode) {
      await addImageToCell({
        workbook, worksheet, rowNumber, columnNumber: 2,
        buffer: barcode, extension: "png",
        maxWidth: BARCODE_MAX_WIDTH, maxHeight: BARCODE_MAX_HEIGHT,
      });
    }
    const product = productImages[index];
    if (product) {
      await addImageToCell({
        workbook, worksheet, rowNumber, columnNumber: 5,
        buffer: product.buffer, extension: product.extension,
        maxWidth: PRODUCT_IMAGE_SIZE, maxHeight: PRODUCT_IMAGE_SIZE,
      });
    }
  }

  addGuideSheet(workbook);

  return workbook.xlsx.writeBuffer();
}

export function inventoryForecastExportFileName(runDateTime: string) {
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
  const stamp = `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}`;
  return `Inventory_Forecast_${stamp}.xlsx`;
}
