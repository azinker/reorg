import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import archiver from "archiver";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { buildLabelFormatterWorkbook } from "@/lib/label-formatter/excel";
import { buildLabelFormatterPackingSlipPdf } from "@/lib/label-formatter/packing-slip-pdf";
import {
  LABEL_FORMATTER_EXCEL_FILENAME,
  LABEL_FORMATTER_PDF_FILENAME,
  LABEL_FORMATTER_ZIP_FILENAME,
  type LabelFormatterExportInput,
} from "@/lib/label-formatter/types";

export type LabelFormatterExportResult = {
  batchId: string;
  zipBuffer: Buffer;
  excelBuffer: Buffer;
  pdfBuffer: Buffer;
};

async function zipExportFiles(excelBuffer: Buffer, pdfBuffer: Uint8Array): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const pass = new PassThrough();
  const chunks: Buffer[] = [];

  pass.on("data", (chunk: Buffer) => chunks.push(chunk));
  archive.on("error", (error: Error) => pass.destroy(error));
  archive.pipe(pass);
  archive.append(excelBuffer, { name: LABEL_FORMATTER_EXCEL_FILENAME });
  archive.append(Buffer.from(pdfBuffer), { name: LABEL_FORMATTER_PDF_FILENAME });
  await archive.finalize();
  await finished(pass);
  return Buffer.concat(chunks);
}

export async function createLabelFormatterExport(
  input: LabelFormatterExportInput,
  actorUserId: string,
): Promise<LabelFormatterExportResult> {
  const excelBuffer = await buildLabelFormatterWorkbook(input.rows);
  const pdfBytes = await buildLabelFormatterPackingSlipPdf(input.rows);
  const pdfBuffer = Buffer.from(pdfBytes);
  const zipBuffer = await zipExportFiles(excelBuffer, pdfBytes);

  const orderNumbers = [...new Set(input.rows.map((row) => row.orderNumber))];
  const sourceStores = [...new Set(input.rows.map((row) => row.sourceStore))];

  const batch = await db.$transaction(async (tx) => {
    const created = await tx.labelFormatterExportBatch.create({
      data: {
        createdByUserId: actorUserId,
        rowCount: input.rows.length,
        orderNumbers: orderNumbers as Prisma.InputJsonValue,
        sourceStores: sourceStores as Prisma.InputJsonValue,
        excelFileName: LABEL_FORMATTER_EXCEL_FILENAME,
        pdfFileName: LABEL_FORMATTER_PDF_FILENAME,
        zipFileName: LABEL_FORMATTER_ZIP_FILENAME,
      },
    });

    await tx.labelFormatterExportRow.createMany({
      data: input.rows.map((row) => ({
        batchId: created.id,
        note: row.note?.trim() || null,
        orderNumber: row.orderNumber,
        sourceStore: row.sourceStore,
        buyerName: row.buyerName,
        addressLine1: row.addressLine1,
        addressLine2: row.addressLine2?.trim() || null,
        city: row.city,
        state: row.state,
        zipCode: row.zipCode,
        lineItems: row.lineItems as unknown as Prisma.InputJsonValue,
      })),
    });

    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        action: "label_formatter_export",
        entityType: "label_formatter_export_batch",
        entityId: created.id,
        details: {
          mode: input.mode,
          rowCount: input.rows.length,
          orderNumbers,
          sourceStores,
          excelFileName: LABEL_FORMATTER_EXCEL_FILENAME,
          pdfFileName: LABEL_FORMATTER_PDF_FILENAME,
        } as Prisma.InputJsonValue,
      },
    });

    return created;
  });

  return { batchId: batch.id, zipBuffer, excelBuffer, pdfBuffer };
}

export async function listLabelFormatterExportHistory(limit = 25) {
  return db.labelFormatterExportBatch.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      rows: { select: { id: true, orderNumber: true, sourceStore: true }, orderBy: { createdAt: "asc" } },
    },
  });
}
