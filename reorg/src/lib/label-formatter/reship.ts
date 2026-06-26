import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import archiver from "archiver";
import { PDFDocument } from "pdf-lib";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { resolveLabelCrowSeriesId } from "@/lib/label-formatter/labelcrow-options";
import { appendMergedOrderPdf } from "@/lib/label-formatter/reship-pdf";
import { buildReshipDataSheet, type ReshipDataSheetRow } from "@/lib/label-formatter/reship-data-sheet";
import {
  LABEL_FORMATTER_RESHIP_DATA_FILENAME,
  LABEL_FORMATTER_RESHIP_PDF_FILENAME,
  LABEL_FORMATTER_RESHIP_ZIP_FILENAME,
  type LabelFormatterReshipInput,
} from "@/lib/label-formatter/types";
import {
  createLabelCrowLabel,
  downloadLabelCrowLabel,
  type LabelCrowAddress,
} from "@/lib/services/labelcrow";

export type LabelFormatterReshipResult = {
  batchId: string;
  zipBuffer: Buffer;
  successCount: number;
  failedCount: number;
};

async function zipReshipFiles(pdfBuffer: Buffer, dataSheetBuffer: Buffer): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const pass = new PassThrough();
  const chunks: Buffer[] = [];

  pass.on("data", (chunk: Buffer) => chunks.push(chunk));
  archive.on("error", (error: Error) => pass.destroy(error));
  archive.pipe(pass);
  archive.append(pdfBuffer, { name: LABEL_FORMATTER_RESHIP_PDF_FILENAME });
  archive.append(dataSheetBuffer, { name: LABEL_FORMATTER_RESHIP_DATA_FILENAME });
  await archive.finalize();
  await finished(pass);
  return Buffer.concat(chunks);
}

function buildFromAddress(input: LabelFormatterReshipInput): LabelCrowAddress {
  return {
    name: input.fromAddress.name,
    address: input.fromAddress.street,
    address2: input.fromAddress.aptSuite ?? "",
    city: input.fromAddress.city,
    state: input.fromAddress.state,
    zip: input.fromAddress.zip,
  };
}

function buildToAddress(row: LabelFormatterReshipInput["rows"][number]): LabelCrowAddress {
  return {
    name: row.buyerName,
    address: row.addressLine1,
    address2: row.addressLine2 ?? "",
    city: row.city,
    state: row.state,
    zip: row.zipCode,
  };
}

async function resolveLabelPdfBytes(label: Awaited<ReturnType<typeof createLabelCrowLabel>>): Promise<Buffer> {
  if (label.pdfBytes) return label.pdfBytes;
  const downloaded = await downloadLabelCrowLabel({
    labelCrowId: label.labelCrowId,
    downloadUrl: label.downloadUrl,
    trackingNumber: label.trackingNumber,
  });
  return downloaded.bytes;
}

export async function createLabelFormatterReship(
  input: LabelFormatterReshipInput,
  actorUserId: string,
): Promise<LabelFormatterReshipResult> {
  const fromAddress = buildFromAddress(input);
  const seriesId = resolveLabelCrowSeriesId(input.seriesCode);
  const combinedPdf = await PDFDocument.create();
  const dataSheetRows: ReshipDataSheetRow[] = [];
  let successCount = 0;
  let failedCount = 0;

  const batch = await db.labelFormatterReshipBatch.create({
    data: {
      createdByUserId: actorUserId,
      rowCount: input.rows.length,
      carrier: "usps",
      serviceClass: input.serviceClass,
      providerKey: input.providerKey,
      seriesCode: input.seriesCode,
      fromName: input.fromAddress.name,
      fromStreet: input.fromAddress.street,
      fromStreet2: input.fromAddress.aptSuite?.trim() || null,
      fromCity: input.fromAddress.city,
      fromState: input.fromAddress.state,
      fromZip: input.fromAddress.zip,
      zipFileName: LABEL_FORMATTER_RESHIP_ZIP_FILENAME,
    },
  });

  for (const row of input.rows) {
    const baseDataSheetRow: ReshipDataSheetRow = {
      ...row,
      carrier: "usps",
      serviceClass: input.serviceClass,
      providerKey: input.providerKey,
      seriesCode: input.seriesCode,
      labelStatus: "failed",
      trackingNumber: null,
      errorMessage: null,
    };

    try {
      const label = await createLabelCrowLabel({
        from: fromAddress,
        to: buildToAddress(row),
        orderNumber: row.orderNumber,
        carrier: "usps",
        serviceClass: input.serviceClass,
        providerKey: input.providerKey,
        seriesId,
        seriesCode: input.seriesCode,
        weightLbs: 2,
      });
      const labelPdf = await resolveLabelPdfBytes(label);
      await appendMergedOrderPdf(combinedPdf, labelPdf, row);

      await db.labelFormatterReshipRow.create({
        data: {
          batchId: batch.id,
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
          trackingNumber: label.trackingNumber,
          labelCrowId: label.labelCrowId,
          carrier: "usps",
          serviceClass: input.serviceClass,
          providerKey: input.providerKey,
          seriesCode: input.seriesCode,
          status: "created",
        },
      });

      successCount += 1;
      dataSheetRows.push({
        ...baseDataSheetRow,
        labelStatus: "created",
        trackingNumber: label.trackingNumber,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Label creation failed.";
      failedCount += 1;

      await db.labelFormatterReshipRow.create({
        data: {
          batchId: batch.id,
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
          carrier: "usps",
          serviceClass: input.serviceClass,
          providerKey: input.providerKey,
          seriesCode: input.seriesCode,
          status: "failed",
          errorMessage: message,
        },
      });

      dataSheetRows.push({
        ...baseDataSheetRow,
        labelStatus: "failed",
        errorMessage: message,
      });
    }
  }

  if (successCount === 0) {
    await db.labelFormatterReshipBatch.update({
      where: { id: batch.id },
      data: { successCount: 0, failedCount },
    });
    throw new Error("No labels were created. Check the data sheet errors and try again.");
  }

  const pdfBuffer = Buffer.from(await combinedPdf.save());
  const dataSheetBuffer = await buildReshipDataSheet(dataSheetRows);
  const zipBuffer = await zipReshipFiles(pdfBuffer, dataSheetBuffer);

  await db.$transaction([
    db.labelFormatterReshipBatch.update({
      where: { id: batch.id },
      data: { successCount, failedCount },
    }),
    db.auditLog.create({
      data: {
        userId: actorUserId,
        action: "label_formatter_reship",
        entityType: "label_formatter_reship_batch",
        entityId: batch.id,
        details: {
          rowCount: input.rows.length,
          successCount,
          failedCount,
          serviceClass: input.serviceClass,
          providerKey: input.providerKey,
          seriesCode: input.seriesCode,
        } as Prisma.InputJsonValue,
      },
    }),
  ]);

  return { batchId: batch.id, zipBuffer, successCount, failedCount };
}

export async function listLabelFormatterReshipHistory(limit = 25) {
  return db.labelFormatterReshipBatch.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      rows: { orderBy: { createdAt: "asc" } },
    },
  });
}
