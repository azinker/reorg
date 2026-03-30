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

  for (const id of orderedValidMasterIds) {
    const master = byId.get(id)!;
    const page = pdf.addPage([BIN_LABEL_PAGE_WIDTH_PT, BIN_LABEL_PAGE_HEIGHT_PT]);
    const { width, height } = page.getSize();

    const binText = binPrefixFromSku(master.sku);
    const binFontSize = 34;
    const binW = fontBold.widthOfTextAtSize(binText, binFontSize);
    page.drawText(binText, {
      x: (width - binW) / 2,
      y: height - 52,
      size: binFontSize,
      font: fontBold,
      color: rgb(0, 0, 0),
    });

    const canUseUpc =
      tppMasterIds.has(master.id) && master.upc != null && master.upc.trim().length > 0;
    if (canUseUpc) {
      const pngBytes = await buildBarcodePngBuffer(master.upc!);
      if (pngBytes) {
        const png = await pdf.embedPng(pngBytes);
        const maxW = width - 72;
        const maxH = 120;
        const s = Math.min(maxW / png.width, maxH / png.height, 1);
        const dw = png.width * s;
        const dh = png.height * s;
        const imgY = (height - dh) / 2;
        page.drawImage(png, {
          x: (width - dw) / 2,
          y: imgY,
          width: dw,
          height: dh,
        });
      }
    }

    const skuText = master.sku;
    const skuSize = 15;
    const skuW = font.widthOfTextAtSize(skuText, skuSize);
    page.drawText(skuText, {
      x: (width - skuW) / 2,
      y: 40,
      size: skuSize,
      font,
      color: rgb(0, 0, 0),
    });
  }

  return pdf.save();
}
