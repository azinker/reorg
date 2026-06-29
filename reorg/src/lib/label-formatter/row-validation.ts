import type { LabelFormatterLineItem, LabelFormatterRow } from "@/lib/label-formatter/types";

export type LabelFormatterRowValidationIssue = {
  rowIndex: number;
  orderNumber: string;
  field: string;
  message: string;
};

function orderLabel(row: LabelFormatterRow, rowIndex: number): string {
  const trimmed = row.orderNumber?.trim();
  return trimmed || `(working table row ${rowIndex})`;
}

function validateLineItems(
  lineItems: LabelFormatterLineItem[],
  orderNumber: string,
  rowIndex: number,
): LabelFormatterRowValidationIssue[] {
  const issues: LabelFormatterRowValidationIssue[] = [];

  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    issues.push({
      rowIndex,
      orderNumber,
      field: "SKU lines",
      message: "Add at least one SKU with a positive quantity.",
    });
    return issues;
  }

  lineItems.forEach((line, lineIndex) => {
    if (!line.sku?.trim()) {
      issues.push({
        rowIndex,
        orderNumber,
        field: `SKU line ${lineIndex + 1}`,
        message: "SKU is required.",
      });
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      issues.push({
        rowIndex,
        orderNumber,
        field: `SKU line ${lineIndex + 1} quantity`,
        message: "Quantity must be a whole number of at least 1.",
      });
    }
  });

  return issues;
}

export function validateLabelFormatterRowForShip(
  row: LabelFormatterRow,
  rowIndex: number,
): LabelFormatterRowValidationIssue[] {
  const issues: LabelFormatterRowValidationIssue[] = [];
  const orderNumber = orderLabel(row, rowIndex);

  if (!row.orderNumber?.trim()) {
    issues.push({
      rowIndex,
      orderNumber,
      field: "Order number",
      message: "Order number is required.",
    });
  }
  if (!row.buyerName?.trim()) {
    issues.push({
      rowIndex,
      orderNumber,
      field: "Buyer name",
      message: "Buyer name is required.",
    });
  }
  if (!row.addressLine1?.trim()) {
    issues.push({
      rowIndex,
      orderNumber,
      field: "Address line 1",
      message: "Address line 1 is required.",
    });
  }
  if (!row.city?.trim()) {
    issues.push({
      rowIndex,
      orderNumber,
      field: "City",
      message: "City is required.",
    });
  }
  if (!row.state?.trim()) {
    issues.push({
      rowIndex,
      orderNumber,
      field: "State",
      message: "State is required.",
    });
  }
  if (!row.zipCode?.trim()) {
    issues.push({
      rowIndex,
      orderNumber,
      field: "Zip code",
      message: "Zip code is required.",
    });
  }

  issues.push(...validateLineItems(row.lineItems, orderNumber, rowIndex));
  return issues;
}

export function validateLabelFormatterRowsForShip(
  rows: LabelFormatterRow[],
): LabelFormatterRowValidationIssue[] {
  return rows.flatMap((row, index) => validateLabelFormatterRowForShip(row, index + 1));
}

export function formatLabelFormatterRowValidationSummary(
  issues: LabelFormatterRowValidationIssue[],
): string {
  if (issues.length === 0) return "";

  const uniqueOrders = new Set(issues.map((issue) => issue.orderNumber));
  const header = `Cannot ship: fix ${uniqueOrders.size} order${uniqueOrders.size === 1 ? "" : "s"} (${issues.length} issue${issues.length === 1 ? "" : "s"}).`;
  const lines = issues.map(
    (issue) => `• Order ${issue.orderNumber} — ${issue.field}: ${issue.message}`,
  );

  return [header, ...lines].join("\n");
}

/** Lowest SKU on the packing slip, used for batch sort order. */
export function primarySkuSortKey(row: LabelFormatterRow): string {
  const skus = row.lineItems
    .map((line) => line.sku.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));

  return skus[0] ?? "";
}

export function sortLabelFormatterRowsByPrimarySku<T extends LabelFormatterRow>(rows: T[]): T[] {
  return [...rows].sort((left, right) => {
    const skuCompare = primarySkuSortKey(left).localeCompare(
      primarySkuSortKey(right),
      undefined,
      { sensitivity: "base", numeric: true },
    );
    if (skuCompare !== 0) return skuCompare;
    return left.orderNumber.localeCompare(right.orderNumber, undefined, { numeric: true });
  });
}

export function rowValidationIssuesToInvalidRows(
  issues: LabelFormatterRowValidationIssue[],
): Array<{
  rowIndex: number;
  orderNumber?: string;
  field?: string;
  message: string;
}> {
  return issues.map((issue) => ({
    rowIndex: issue.rowIndex,
    orderNumber: issue.orderNumber,
    field: issue.field,
    message: issue.message,
  }));
}
