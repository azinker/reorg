import { db } from "@/lib/db";
import type { LabelFormatterLineItem, LabelFormatterWorkingRowInput } from "@/lib/label-formatter/types";

export type LabelFormatterWorkingRowRecord = Omit<LabelFormatterWorkingRowInput, "createdAt" | "updatedAt"> & {
  id: string;
  createdAt: Date;
  updatedAt: Date;
};

function normalizeLineItems(value: unknown): LabelFormatterLineItem[] {
  if (!Array.isArray(value)) return [{ sku: "", quantity: 1 }];

  const rows = value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const sku = typeof record.sku === "string" ? record.sku : "";
    const quantity = Number(record.quantity);
    return [{
      sku,
      quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1,
    }];
  });

  return rows.length > 0 ? rows : [{ sku: "", quantity: 1 }];
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

export function filterRowsForNonStaleReplace(
  rows: LabelFormatterWorkingRowInput[],
  existingIds: Set<string>,
  clientLoadedAt?: Date | null,
): LabelFormatterWorkingRowInput[] {
  if (!clientLoadedAt) return rows;

  return rows.filter((row) => {
    if (!row.id || existingIds.has(row.id)) return true;

    const rowCreatedAt = parseDate(row.createdAt);
    if (!rowCreatedAt) return false;

    return rowCreatedAt > clientLoadedAt;
  });
}

export async function listLabelFormatterWorkingRows(userId: string): Promise<LabelFormatterWorkingRowRecord[]> {
  const rows = await db.labelFormatterWorkingRow.findMany({
    where: { createdByUserId: userId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    note: row.note ?? "",
    orderNumber: row.orderNumber,
    sourceStore: row.sourceStore as LabelFormatterWorkingRowRecord["sourceStore"],
    buyerName: row.buyerName,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2 ?? "",
    city: row.city,
    state: row.state,
    zipCode: row.zipCode,
    lineItems: normalizeLineItems(row.lineItems),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function replaceLabelFormatterWorkingRows(
  userId: string,
  rows: LabelFormatterWorkingRowInput[],
  options?: { clientLoadedAt?: Date | null },
): Promise<LabelFormatterWorkingRowRecord[]> {
  await db.$transaction(async (tx) => {
    const existingRows = await tx.labelFormatterWorkingRow.findMany({
      where: { createdByUserId: userId },
      select: { id: true },
    });
    const existingIds = new Set(existingRows.map((row) => row.id));
    const rowsToReplace = filterRowsForNonStaleReplace(rows, existingIds, options?.clientLoadedAt);
    const incomingIds = rowsToReplace.flatMap((row) => (row.id ? [row.id] : []));
    const rowsAddedAfterClientLoad = options?.clientLoadedAt
      ? await tx.labelFormatterWorkingRow.findMany({
          where: {
            createdByUserId: userId,
            createdAt: { gt: options.clientLoadedAt },
            ...(incomingIds.length > 0 ? { id: { notIn: incomingIds } } : {}),
          },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        })
      : [];

    await tx.labelFormatterWorkingRow.deleteMany({
      where: { createdByUserId: userId },
    });

    const rowsToWrite = [
      ...rowsToReplace.map((row, index) => ({
        ...(row.id ? { id: row.id } : {}),
        createdByUserId: userId,
        note: row.note ?? "",
        orderNumber: row.orderNumber,
        sourceStore: row.sourceStore,
        buyerName: row.buyerName,
        addressLine1: row.addressLine1,
        addressLine2: row.addressLine2 ?? "",
        city: row.city,
        state: row.state,
        zipCode: row.zipCode,
        lineItems: row.lineItems,
        sortOrder: index,
      })),
      ...rowsAddedAfterClientLoad.map((row, index) => ({
        id: row.id,
        createdByUserId: row.createdByUserId,
        note: row.note ?? "",
        orderNumber: row.orderNumber,
        sourceStore: row.sourceStore,
        buyerName: row.buyerName,
        addressLine1: row.addressLine1,
        addressLine2: row.addressLine2 ?? "",
        city: row.city,
        state: row.state,
        zipCode: row.zipCode,
        lineItems: normalizeLineItems(row.lineItems),
        sortOrder: rowsToReplace.length + index,
      })),
    ];

    if (rowsToWrite.length === 0) return;

    await tx.labelFormatterWorkingRow.createMany({
      data: rowsToWrite,
    });
  });

  return listLabelFormatterWorkingRows(userId);
}

export async function appendOrUpdateLabelFormatterWorkingRow(
  userId: string,
  row: LabelFormatterWorkingRowInput,
): Promise<{ row: LabelFormatterWorkingRowRecord; created: boolean; totalRows: number }> {
  const result = await db.$transaction(async (tx) => {
    const existing = await tx.labelFormatterWorkingRow.findFirst({
      where: {
        createdByUserId: userId,
        orderNumber: row.orderNumber,
        sourceStore: row.sourceStore,
      },
      orderBy: { createdAt: "asc" },
    });

    if (existing) {
      const nextNote = row.note?.trim()
        ? row.note.trim()
        : existing.note ?? "";
      const updated = await tx.labelFormatterWorkingRow.update({
        where: { id: existing.id },
        data: {
          note: nextNote,
          buyerName: row.buyerName,
          addressLine1: row.addressLine1,
          addressLine2: row.addressLine2 ?? "",
          city: row.city,
          state: row.state,
          zipCode: row.zipCode,
          lineItems: row.lineItems,
        },
      });
      const totalRows = await tx.labelFormatterWorkingRow.count({
        where: { createdByUserId: userId },
      });
      return { dbRow: updated, created: false, totalRows };
    }

    const last = await tx.labelFormatterWorkingRow.findFirst({
      where: { createdByUserId: userId },
      orderBy: [{ sortOrder: "desc" }, { createdAt: "desc" }],
      select: { sortOrder: true },
    });
    const created = await tx.labelFormatterWorkingRow.create({
      data: {
        ...(row.id ? { id: row.id } : {}),
        createdByUserId: userId,
        note: row.note ?? "",
        orderNumber: row.orderNumber,
        sourceStore: row.sourceStore,
        buyerName: row.buyerName,
        addressLine1: row.addressLine1,
        addressLine2: row.addressLine2 ?? "",
        city: row.city,
        state: row.state,
        zipCode: row.zipCode,
        lineItems: row.lineItems,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
    });
    const totalRows = await tx.labelFormatterWorkingRow.count({
      where: { createdByUserId: userId },
    });
    return { dbRow: created, created: true, totalRows };
  });

  return {
    row: {
      id: result.dbRow.id,
      note: result.dbRow.note ?? "",
      orderNumber: result.dbRow.orderNumber,
      sourceStore: result.dbRow.sourceStore as LabelFormatterWorkingRowRecord["sourceStore"],
      buyerName: result.dbRow.buyerName,
      addressLine1: result.dbRow.addressLine1,
      addressLine2: result.dbRow.addressLine2 ?? "",
      city: result.dbRow.city,
      state: result.dbRow.state,
      zipCode: result.dbRow.zipCode,
      lineItems: normalizeLineItems(result.dbRow.lineItems),
      createdAt: result.dbRow.createdAt,
      updatedAt: result.dbRow.updatedAt,
    },
    created: result.created,
    totalRows: result.totalRows,
  };
}
