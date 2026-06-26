import { PDFDocument } from "pdf-lib";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  findLabelCrowSeries,
  resolveLabelCrowSeriesId,
} from "@/lib/label-formatter/labelcrow-options";
import { appendMergedOrderPdf } from "@/lib/label-formatter/reship-pdf";
import { buildReshipDataSheet, type ReshipDataSheetRow } from "@/lib/label-formatter/reship-data-sheet";
import {
  LABEL_FORMATTER_RESHIP_DATA_FILENAME,
  type LabelFormatterReshipInput,
} from "@/lib/label-formatter/types";
import {
  createLabelCrowLabel,
  downloadLabelCrowLabel,
  fetchLabelCrowAccountSeries,
  type LabelCrowAddress,
} from "@/lib/services/labelcrow";

export type LabelFormatterReshipResult = {
  batchId: string;
  pdfBuffer: Buffer | null;
  dataSheetBuffer: Buffer;
  successCount: number;
  failedCount: number;
  firstError: string | null;
};

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
  const accountSeries = await fetchLabelCrowAccountSeries();
  const matchedSeries = findLabelCrowSeries(accountSeries, {
    seriesCode: input.seriesCode,
    serviceClass: input.serviceClass,
  });
  const seriesId = resolveLabelCrowSeriesId(accountSeries, {
    seriesCode: input.seriesCode,
    serviceClass: input.serviceClass,
  });
  const seriesCodeForApi = matchedSeries?.series_code ?? input.seriesCode;

  const combinedPdf = await PDFDocument.create();
  const dataSheetRows: ReshipDataSheetRow[] = [];
  let successCount = 0;
  let failedCount = 0;
  let firstError: string | null = null;

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
      zipFileName: null,
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
        seriesCode: seriesCodeForApi,
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
      if (!firstError) firstError = message;
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

  const dataSheetBuffer = await buildReshipDataSheet(dataSheetRows);
  const pdfBuffer =
    successCount > 0 ? Buffer.from(await combinedPdf.save()) : null;

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
          seriesId,
          firstError,
        } as Prisma.InputJsonValue,
      },
    }),
  ]);

  return {
    batchId: batch.id,
    pdfBuffer,
    dataSheetBuffer,
    successCount,
    failedCount,
    firstError,
  };
}

export async function buildReshipDataSheetForBatch(batchId: string): Promise<Buffer | null> {
  const batch = await db.labelFormatterReshipBatch.findUnique({
    where: { id: batchId },
    include: { rows: { orderBy: { createdAt: "asc" } } },
  });
  if (!batch) return null;

  const rows: ReshipDataSheetRow[] = batch.rows.map((row) => ({
    note: row.note ?? "",
    orderNumber: row.orderNumber,
    sourceStore: row.sourceStore as ReshipDataSheetRow["sourceStore"],
    buyerName: row.buyerName,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2 ?? "",
    city: row.city,
    state: row.state,
    zipCode: row.zipCode,
    lineItems: Array.isArray(row.lineItems)
      ? (row.lineItems as ReshipDataSheetRow["lineItems"])
      : [],
    trackingNumber: row.trackingNumber,
    labelStatus: row.status === "created" ? "created" : "failed",
    errorMessage: row.errorMessage,
    carrier: row.carrier,
    serviceClass: row.serviceClass,
    providerKey: row.providerKey,
    seriesCode: row.seriesCode,
  }));

  return buildReshipDataSheet(rows);
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
