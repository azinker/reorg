import test from "node:test";
import assert from "node:assert/strict";
import {
  primarySkuSortKey,
  sortLabelFormatterRowsByPrimarySku,
  validateLabelFormatterRowsForShip,
} from "@/lib/label-formatter/row-validation";
import type { LabelFormatterRow } from "@/lib/label-formatter/types";

const baseRow: LabelFormatterRow = {
  orderNumber: "20-14808-76476",
  sourceStore: "EBAY_TPP",
  buyerName: "James Lawson",
  addressLine1: "123 Main",
  city: "Troy",
  state: "SC",
  zipCode: "29609-7635",
  lineItems: [{ sku: "LB252_FSHN_BOXES", quantity: 1 }],
};

test("validateLabelFormatterRowsForShip reports every bad order", () => {
  const issues = validateLabelFormatterRowsForShip([
    baseRow,
    {
      ...baseRow,
      orderNumber: "21-14729-51042",
      buyerName: "",
      lineItems: [{ sku: "", quantity: 1 }],
    },
    {
      ...baseRow,
      orderNumber: "",
      addressLine1: "",
      lineItems: [],
    },
  ]);

  assert.ok(issues.some((issue) => issue.orderNumber === "21-14729-51042" && issue.field === "Buyer name"));
  assert.ok(issues.some((issue) => issue.orderNumber === "21-14729-51042" && issue.field === "SKU line 1"));
  assert.ok(issues.some((issue) => issue.orderNumber === "(working table row 3)" && issue.field === "Order number"));
  assert.ok(issues.length >= 4);
});

test("sortLabelFormatterRowsByPrimarySku orders merged PDF pages alphabetically by SKU", () => {
  const rows: LabelFormatterRow[] = [
    { ...baseRow, orderNumber: "C", lineItems: [{ sku: "ZZZ_LAST", quantity: 1 }] },
    { ...baseRow, orderNumber: "A", lineItems: [{ sku: "AAA_FIRST", quantity: 1 }] },
    { ...baseRow, orderNumber: "B", lineItems: [{ sku: "MMM_MIDDLE", quantity: 1 }, { sku: "AAA_SECOND", quantity: 1 }] },
  ];

  const sorted = sortLabelFormatterRowsByPrimarySku(rows);
  assert.deepEqual(sorted.map((row) => primarySkuSortKey(row)), [
    "AAA_FIRST",
    "AAA_SECOND",
    "ZZZ_LAST",
  ]);
});
