import test from "node:test";
import assert from "node:assert/strict";
import { filterRowsForNonStaleReplace } from "@/lib/label-formatter/working-rows";
import type { LabelFormatterWorkingRowInput } from "@/lib/label-formatter/types";

const baseRow: LabelFormatterWorkingRowInput = {
  id: "row-1",
  note: "",
  orderNumber: "21-14661-95538",
  sourceStore: "EBAY_TPP",
  buyerName: "Buyer",
  addressLine1: "1 Main St",
  addressLine2: "",
  city: "Miami",
  state: "FL",
  zipCode: "33101",
  lineItems: [{ sku: "SKU-1", quantity: 1 }],
  createdAt: "2026-05-29T04:00:00.000Z",
};

test("working row replace keeps rows that still exist in storage", () => {
  const rows = filterRowsForNonStaleReplace(
    [baseRow],
    new Set(["row-1"]),
    new Date("2026-05-29T04:10:00.000Z"),
  );

  assert.deepEqual(rows, [baseRow]);
});

test("working row replace drops stale rows that were deleted after tab load", () => {
  const rows = filterRowsForNonStaleReplace(
    [baseRow],
    new Set(),
    new Date("2026-05-29T04:10:00.000Z"),
  );

  assert.deepEqual(rows, []);
});

test("working row replace allows rows created in the current stale tab", () => {
  const newRow = {
    ...baseRow,
    id: "client-created-row",
    createdAt: "2026-05-29T04:15:00.000Z",
  };

  const rows = filterRowsForNonStaleReplace(
    [newRow],
    new Set(),
    new Date("2026-05-29T04:10:00.000Z"),
  );

  assert.deepEqual(rows, [newRow]);
});
