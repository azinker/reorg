import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import bwipjs from "bwip-js";
import { db } from "@/lib/db";

/** 6\" × 4\" at 72 points per inch (landscape). */
export const BIN_LABEL_PAGE_WIDTH_PT = 6 * 72;
export const BIN_LABEL_PAGE_HEIGHT_PT = 4 * 72;

export const BIN_LABEL_MAX_ROW_IDS = 300;

/** Grid uses `child-${MasterRow.id}` for variation children; parents may be `variation-parent:...` (no label). */
export function resolveMasterRowIdFromGridId(gridRowId: string): string | null {
  if (gridRowId.startsWith("variation-parent:")) return null;
  if (gridRowId.startsWith("child-")) return gridRowId.slice("child-".length);
  return gridRowId;
}

export function binPrefixFromSku(sku: string): string {
  if (!sku.includes("_")) return "—";
  const first = sku.split("_")[0];
  return first && first.length > 0 ? first : "—";
}

function buildBarcodeFormat(upc: string) {
  const digits = upc.replace(/\D/g, "");
  if (digits.length === 12) return { bcid: "upca" as const, text: digits };
  if (digits.length === 13) return { bcid: "ean13" as const, text: digits };
  return { bcid: "code128" as const, text: upc };
}

/** Largest font size (pt) so measured text width ≤ maxWidth. */
function maxFontSizeForWidth(
  measureWidth: (fontSize: number) => number,
  maxWidth: number,
  minSize: number,
  maxSize: number,
): number {
  let lo = minSize;
  let hi = maxSize;
  let best = minSize;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    const w = measureWidth(mid);
    if (w <= maxWidth) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 0.25) break;
  }
  return Math.round(best * 4) / 4;
}

async function buildBarcodePngBuffer(upc: string): Promise<Uint8Array | null> {
  const trimmed = upc.trim();
  if (!trimmed) return null;
  const configs = [buildBarcodeFormat(trimmed), { bcid: "code128" as const, text: trimmed }] as const;
  for (const config of configs) {
    try {
      const buf = await bwipjs.toBuffer({
        ...config,
        scale: 3,
        height: 22,
        includetext: false,
        backgroundcolor: "FFFFFF",
      });
      return new Uint8Array(buf);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Builds a multi-page PDF — one 6×4\" page per valid master row id, in request order.
 * UPC barcode is drawn only when the row has a TPP eBay listing and a non-empty MasterRow.upc
 * (listing rows do not store UPC in Prisma; master row holds synced TPP values).
 */
export async function buildBinLabelsPdf(orderedRowIds: string[]): Promise<Uint8Array> {
  if (orderedRowIds.length === 0) {
    throw new Error("No row IDs provided");
  }
  if (orderedRowIds.length > BIN_LABEL_MAX_ROW_IDS) {
    throw new Error(`At most ${BIN_LABEL_MAX_ROW_IDS} labels per request`);
  }

  const resolvedMasterIds: string[] = [];
  for (const gridId of orderedRowIds) {
    const mid = resolveMasterRowIdFromGridId(gridId);
    if (mid) resolvedMasterIds.push(mid);
  }

  const masters = await db.masterRow.findMany({
    where: { id: { in: [...new Set(resolvedMasterIds)] }, isActive: true },
    select: { id: true, sku: true, upc: true },
  });
  const byId = new Map(masters.map((m) => [m.id, m]));

  const tppListings = await db.marketplaceListing.findMany({
    where: {
      masterRowId: { in: masters.map((m) => m.id) },
      integration: { platform: "TPP_EBAY" },
    },
    select: { masterRowId: true },
  });
  const tppMasterIds = new Set(tppListings.map((l) => l.masterRowId));

  const orderedValidMasterIds = resolvedMasterIds.filter((id) => byId.has(id));
  if (orderedValidMasterIds.length === 0) {
    throw new Error("No valid active rows to print");
  }

  const pdf = await PDFDocument.create();
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const marginX = 20;
  const maxTextW = BIN_LABEL_PAGE_WIDTH_PT - 2 * marginX;
  const HELV_CAP = 0.72;

  for (const id of orderedValidMasterIds) {
    const master = byId.get(id)!;
    const page = pdf.addPage([BIN_LABEL_PAGE_WIDTH_PT, BIN_LABEL_PAGE_HEIGHT_PT]);
    const { width, height } = page.getSize();

    const binText = binPrefixFromSku(master.sku);
    const skuText = master.sku;

    const canUseUpc =
      tppMasterIds.has(master.id) && master.upc != null && master.upc.trim().length > 0;

    const binPtMax = canUseUpc ? 96 : 118;
    const skuPtMax = canUseUpc ? 60 : 78;
    const binVertFrac = canUseUpc ? 0.37 : 0.46;
    const skuVertFrac = canUseUpc ? 0.31 : 0.41;

    let binFontSize = maxFontSizeForWidth(
      (s) => fontBold.widthOfTextAtSize(binText, s),
      maxTextW,
      22,
      binPtMax,
    );
    let skuFontSize = maxFontSizeForWidth(
      (s) => font.widthOfTextAtSize(skuText, s),
      maxTextW,
      18,
      skuPtMax,
    );

    const topPad = 10;
    const bottomPad = 14;
    binFontSize = Math.min(binFontSize, (height * binVertFrac - topPad) / HELV_CAP);
    skuFontSize = Math.min(skuFontSize, (height * skuVertFrac - bottomPad) / HELV_CAP);

    const binBaseline = height - topPad - HELV_CAP * binFontSize;
    const skuBaseline = bottomPad + 0.22 * skuFontSize;
    const skuTopY = skuBaseline + HELV_CAP * skuFontSize;
    const binGap = 14;
    const verticalSlot = binBaseline - binGap - (skuTopY + binGap);

    const binW = fontBold.widthOfTextAtSize(binText, binFontSize);
    page.drawText(binText, {
      x: (width - binW) / 2,
      y: binBaseline,
      size: binFontSize,
      font: fontBold,
      color: rgb(0, 0, 0),
    });

    if (canUseUpc) {
      const pngBytes = await buildBarcodePngBuffer(master.upc!);
      if (pngBytes) {
        const png = await pdf.embedPng(pngBytes);
        const maxBarW = width - 64;
        const maxBarH =
          verticalSlot > 36 ? Math.min(118, verticalSlot - 4) : Math.min(118, Math.max(56, height * 0.28));
        const s = Math.min(maxBarW / png.width, maxBarH / png.height, 1);
        const dw = png.width * s;
        const dh = png.height * s;
        const minBottomY = skuTopY + binGap;
        const maxBottomY = binBaseline - binGap - dh;
        const imgY =
          maxBottomY >= minBottomY
            ? minBottomY + (maxBottomY - minBottomY) / 2
            : (height - dh) / 2;
        page.drawImage(png, {
          x: (width - dw) / 2,
          y: imgY,
          width: dw,
          height: dh,
        });
      }
    }

    const skuW = font.widthOfTextAtSize(skuText, skuFontSize);
    page.drawText(skuText, {
      x: (width - skuW) / 2,
      y: skuBaseline,
      size: skuFontSize,
      font,
      color: rgb(0, 0, 0),
    });
  }

  return pdf.save();
}
