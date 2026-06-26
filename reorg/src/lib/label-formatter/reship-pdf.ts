import { PDFDocument } from "pdf-lib";
import { buildLabelFormatterPackingSlipPdf } from "@/lib/label-formatter/packing-slip-pdf";
import type { LabelFormatterRow } from "@/lib/label-formatter/types";

export async function mergeLabelAndPackingSlipPdf(
  labelPdfBytes: Buffer,
  row: LabelFormatterRow,
): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  const labelDoc = await PDFDocument.load(labelPdfBytes);
  const slipBytes = await buildLabelFormatterPackingSlipPdf([row]);
  const slipDoc = await PDFDocument.load(slipBytes);

  for (const pageIndex of labelDoc.getPageIndices()) {
    const [page] = await merged.copyPages(labelDoc, [pageIndex]);
    merged.addPage(page);
  }
  for (const pageIndex of slipDoc.getPageIndices()) {
    const [page] = await merged.copyPages(slipDoc, [pageIndex]);
    merged.addPage(page);
  }

  return merged.save();
}

export async function appendMergedOrderPdf(
  target: PDFDocument,
  labelPdfBytes: Buffer,
  row: LabelFormatterRow,
): Promise<void> {
  const labelDoc = await PDFDocument.load(labelPdfBytes);
  const slipBytes = await buildLabelFormatterPackingSlipPdf([row]);
  const slipDoc = await PDFDocument.load(slipBytes);

  for (const pageIndex of labelDoc.getPageIndices()) {
    const [page] = await target.copyPages(labelDoc, [pageIndex]);
    target.addPage(page);
  }
  for (const pageIndex of slipDoc.getPageIndices()) {
    const [page] = await target.copyPages(slipDoc, [pageIndex]);
    target.addPage(page);
  }
}
