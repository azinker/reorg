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

function serializeWorkingRow(row: {
  id: string;
  note: string | null;
  orderNumber: string;
  sourceStore: string;
  buyerName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  zipCode: string;
  lineItems: unknown;
  createdAt: Date;
  updatedAt: Date;
}): LabelFormatterWorkingRowRecord {
  return {
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
  };
}

export async function listLabelFormatterWorkingRows(): Promise<LabelFormatterWorkingRowRecord[]> {
  const rows = await db.labelFormatterWorkingRow.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  return rows.map(serializeWorkingRow);
}

export async function replaceLabelFormatterWorkingRows(
  actorUserId: string,
  rows: LabelFormatterWorkingRowInput[],
  options?: { clientLoadedAt?: Date | null; clientKnownRowIds?: string[] },
): Promise<LabelFormatterWorkingRowRecord[]> {
  await db.$transaction(async (tx) => {
    const existingRows = await tx.labelFormatterWorkingRow.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    const existingIds = new Set(existingRows.map((row) => row.id));
    const existingById = new Map(existingRows.map((row) => [row.id, row]));
    const clientKnownIds = options?.clientKnownRowIds
      ? new Set(options.clientKnownRowIds)
      : null;
    const rowsToReplace = filterRowsForNonStaleReplace(rows, existingIds, options?.clientLoadedAt);
    const incomingIds = rowsToReplace.flatMap((row) => (row.id ? [row.id] : []));
    const incomingIdSet = new Set(incomingIds);
    const rowsToPreserve = existingRows.filter((row) => {
      if (incomingIdSet.has(row.id)) return false;
      if (!clientKnownIds) return true;
      if (!clientKnownIds.has(row.id)) return true;
      return Boolean(options?.clientLoadedAt && row.createdAt > options.clientLoadedAt);
    });

    const desiredIds = new Set([
      ...rowsToReplace.flatMap((row) => (row.id ? [row.id] : [])),
      ...rowsToPreserve.map((row) => row.id),
    ]);
    const idsToDelete = existingRows
      .filter((row) => !desiredIds.has(row.id))
      .map((row) => row.id);

    if (idsToDelete.length > 0) {
      await tx.labelFormatterWorkingRow.deleteMany({
        where: { id: { in: idsToDelete } },
      });
    }

    for (const [index, row] of rowsToReplace.entries()) {
      const existing = row.id ? existingById.get(row.id) : null;
      const data = {
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
      };

      if (existing) {
        await tx.labelFormatterWorkingRow.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await tx.labelFormatterWorkingRow.create({
          data: {
            ...(row.id ? { id: row.id } : {}),
            createdByUserId: actorUserId,
            ...data,
          },
        });
      }
    }

    for (const [index, row] of rowsToPreserve.entries()) {
      await tx.labelFormatterWorkingRow.update({
        where: { id: row.id },
        data: { sortOrder: rowsToReplace.length + index },
      });
    }
  });

  return listLabelFormatterWorkingRows();
}

export async function deleteLabelFormatterWorkingRows(
  _actorUserId: string,
  rowIds: string[],
): Promise<LabelFormatterWorkingRowRecord[]> {
  const uniqueRowIds = [...new Set(rowIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueRowIds.length === 0) return listLabelFormatterWorkingRows();

  await db.labelFormatterWorkingRow.deleteMany({
    where: { id: { in: uniqueRowIds } },
  });

  return listLabelFormatterWorkingRows();
}

export async function appendOrUpdateLabelFormatterWorkingRow(
  actorUserId: string,
  row: LabelFormatterWorkingRowInput,
): Promise<{ row: LabelFormatterWorkingRowRecord; created: boolean; totalRows: number }> {
  const result = await db.$transaction(async (tx) => {
    const existing = await tx.labelFormatterWorkingRow.findFirst({
      where: {
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
      const totalRows = await tx.labelFormatterWorkingRow.count();
      return { dbRow: updated, created: false, totalRows };
    }

    const last = await tx.labelFormatterWorkingRow.findFirst({
      orderBy: [{ sortOrder: "desc" }, { createdAt: "desc" }],
      select: { sortOrder: true },
    });
    const created = await tx.labelFormatterWorkingRow.create({
      data: {
        ...(row.id ? { id: row.id } : {}),
        createdByUserId: actorUserId,
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
    const totalRows = await tx.labelFormatterWorkingRow.count();
    return { dbRow: created, created: true, totalRows };
  });

  return {
    row: serializeWorkingRow(result.dbRow),
    created: result.created,
    totalRows: result.totalRows,
  };
}
