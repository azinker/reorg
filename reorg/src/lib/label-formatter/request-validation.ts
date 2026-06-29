import type { ZodIssue } from "zod";

export type LabelFormatterInvalidRow = {
  rowIndex: number;
  id?: string;
  orderNumber?: string;
  field?: string;
  message: string;
};

function getReadableField(path: Array<PropertyKey>) {
  if (path[0] === "fromAddress" && path.length === 2) {
    switch (String(path[1])) {
      case "name":
        return "Shipper name";
      case "street":
        return "Street address";
      case "aptSuite":
        return "Apt / Suite";
      case "city":
        return "Ship-from city";
      case "state":
        return "Ship-from state";
      case "zip":
        return "Ship-from zip";
      default:
        return `Ship-from ${String(path[1])}`;
    }
  }

  const field = path.slice(2).map(String).join(".");
  switch (field) {
    case "orderNumber":
      return "Order number";
    case "buyerName":
      return "Buyer name";
    case "addressLine1":
      return "Address line 1";
    case "addressLine2":
      return "Address line 2";
    case "city":
      return "City";
    case "state":
      return "State";
    case "zipCode":
      return "Zip code";
    case "lineItems":
      return "SKU lines";
    default:
      if (field.startsWith("lineItems.")) return `SKU ${field.replaceAll(".", " ")}`;
      return field || "Rows";
  }
}

export function summarizeInvalidLabelFormatterRows(
  body: unknown,
  issues: ZodIssue[],
): LabelFormatterInvalidRow[] {
  const rows = typeof body === "object" && body !== null && Array.isArray((body as { rows?: unknown }).rows)
    ? (body as { rows: unknown[] }).rows
    : [];

  return issues.flatMap((issue) => {
    if (issue.path[0] === "rows" && typeof issue.path[1] === "number") {
      const rowIndex = issue.path[1] + 1;
      const row = rows[issue.path[1]];
      const rowRecord = typeof row === "object" && row !== null ? row as Record<string, unknown> : {};
      return [{
        rowIndex,
        id: typeof rowRecord.id === "string" ? rowRecord.id : undefined,
        orderNumber: typeof rowRecord.orderNumber === "string" ? rowRecord.orderNumber : undefined,
        field: getReadableField(issue.path),
        message: issue.message,
      }];
    }

    if (issue.path[0] === "fromAddress") {
      return [{
        rowIndex: 0,
        field: getReadableField(issue.path),
        message: issue.message,
      }];
    }

    if (issue.path[0] === "rows" && issue.path.length === 1) {
      return [{
        rowIndex: 0,
        field: "Rows",
        message: issue.message,
      }];
    }

    return [];
  });
}

export function formatLabelFormatterInvalidRowsMessage(
  fallback: string,
  invalidRows: LabelFormatterInvalidRow[] | undefined,
): string {
  if (!invalidRows?.length) return fallback;

  const lines = invalidRows.map((issue) => {
    if (issue.rowIndex === 0) {
      const fieldLabel = issue.field ? `${issue.field}: ` : "";
      return `${fieldLabel}${issue.message}`;
    }
    const orderLabel = issue.orderNumber?.trim() || `row ${issue.rowIndex}`;
    const fieldLabel = issue.field ? `${issue.field}: ` : "";
    return `Order ${orderLabel} — ${fieldLabel}${issue.message}`;
  });

  const header = invalidRows.length === 1
    ? "Cannot ship until this is fixed:"
    : `Cannot ship until these are fixed (${invalidRows.length} issues):`;

  return `${fallback}\n${header}\n${lines.map((line) => `• ${line}`).join("\n")}`;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function normalizeLineItem(item: unknown) {
  if (typeof item !== "object" || item === null) {
    return { sku: "", quantity: 1 };
  }
  const record = item as Record<string, unknown>;
  const quantity = Number(record.quantity);
  return {
    sku: stringOrEmpty(record.sku).trim(),
    quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1,
  };
}

/** Coerce nullable draft/working-table values before strict reship validation. */
export function normalizeLabelFormatterReshipBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;

  const record = body as Record<string, unknown>;
  const rows = Array.isArray(record.rows)
    ? record.rows.map((row) => {
        if (typeof row !== "object" || row === null) return row;
        const entry = row as Record<string, unknown>;
        return {
          ...entry,
          note: stringOrEmpty(entry.note).trim(),
          addressLine2: stringOrEmpty(entry.addressLine2).trim(),
          lineItems: Array.isArray(entry.lineItems)
            ? entry.lineItems.map(normalizeLineItem)
            : [{ sku: "", quantity: 1 }],
        };
      })
    : record.rows;

  const fromAddress = typeof record.fromAddress === "object" && record.fromAddress !== null
    ? {
        ...(record.fromAddress as Record<string, unknown>),
        aptSuite: stringOrEmpty((record.fromAddress as Record<string, unknown>).aptSuite).trim(),
      }
    : record.fromAddress;

  return {
    ...record,
    rows,
    fromAddress,
  };
}
