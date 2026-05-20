import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { LabelFormatterRow } from "@/lib/label-formatter/types";

const PAGE_WIDTH = 4 * 72;
const PAGE_HEIGHT = 6 * 72;
const BLACK = rgb(0, 0, 0);

function fontSizeForWidth(font: PDFFont, text: string, maxWidth: number, preferred: number, min: number) {
  let size = preferred;
  while (size > min && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= 0.5;
  }
  return size;
}

function fitText(font: PDFFont, text: string, size: number, maxWidth: number) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}...`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

export async function buildLabelFormatterPackingSlipPdf(rows: LabelFormatterRow[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  for (const row of rows) {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

    const orderSize = fontSizeForWidth(bold, row.orderNumber, PAGE_WIDTH - 36, 24, 12);
    page.drawText(row.orderNumber, {
      x: (PAGE_WIDTH - bold.widthOfTextAtSize(row.orderNumber, orderSize)) / 2,
      y: PAGE_HEIGHT - 58,
      size: orderSize,
      font: bold,
      color: BLACK,
    });

    page.drawLine({
      start: { x: 22, y: PAGE_HEIGHT - 78 },
      end: { x: PAGE_WIDTH - 22, y: PAGE_HEIGHT - 78 },
      thickness: 1,
      color: BLACK,
    });

    page.drawText("SKU", { x: 30, y: PAGE_HEIGHT - 115, size: 13, font: bold, color: BLACK });
    page.drawText("QUANTITY", { x: PAGE_WIDTH - 96, y: PAGE_HEIGHT - 115, size: 13, font: bold, color: BLACK });

    let y = PAGE_HEIGHT - 143;
    const lines = row.lineItems.length > 0
      ? row.lineItems
      : [{ sku: "No SKU data available", quantity: 0 }];
    for (const line of lines) {
      if (y < 36) break;
      const sku = fitText(regular, line.sku, 12, PAGE_WIDTH - 126);
      const quantity = line.quantity > 0 ? String(line.quantity) : "";
      page.drawText(sku, { x: 30, y, size: 12, font: regular, color: BLACK });
      page.drawText(quantity, {
        x: PAGE_WIDTH - 46 - regular.widthOfTextAtSize(quantity, 12),
        y,
        size: 12,
        font: regular,
        color: BLACK,
      });
      y -= 22;
    }
  }

  return pdf.save();
}
