import { db } from "@/lib/db";
import type { LabelFormatterLineItem, LabelFormatterWorkingRowInput } from "@/lib/label-formatter/types";

export type LabelFormatterWorkingRowRecord = LabelFormatterWorkingRowInput & {
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
): Promise<LabelFormatterWorkingRowRecord[]> {
  await db.$transaction(async (tx) => {
    await tx.labelFormatterWorkingRow.deleteMany({
      where: { createdByUserId: userId },
    });

    if (rows.length === 0) return;

    await tx.labelFormatterWorkingRow.createMany({
      data: rows.map((row, index) => ({
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
    });
  });

  return listLabelFormatterWorkingRows(userId);
}
