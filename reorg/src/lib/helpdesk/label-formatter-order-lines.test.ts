import test from "node:test";
import assert from "node:assert/strict";
import { resolveLabelFormatterOrderLineItems } from "@/lib/helpdesk/label-formatter-order-lines";

test("resolveLabelFormatterOrderLineItems merges duplicate SKUs", async () => {
  const lines = await resolveLabelFormatterOrderLineItems("integration-1", [
    { sku: "ABC", quantity: 1, itemId: "111" },
    { sku: "ABC", quantity: 2, itemId: "111" },
  ]);
  assert.deepEqual(lines, [{ sku: "ABC", quantity: 3 }]);
});

test("resolveLabelFormatterOrderLineItems skips lines without resolvable SKU", async () => {
  const lines = await resolveLabelFormatterOrderLineItems("integration-1", [
    { sku: null, quantity: 1, itemId: "" },
  ]);
  assert.deepEqual(lines, []);
});
