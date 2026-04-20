import assert from "node:assert/strict";
import test from "node:test";
import { fillTemplate, findUnfilledPlaceholders } from "@/lib/helpdesk/template-fill";

const ctx = {
  buyerName: "John Smith",
  buyerUserId: "jsmith2024",
  ebayItemId: "12345",
  ebayItemTitle: "Vintage Lamp",
  ebayOrderNumber: "ORDER-789",
  trackingNumber: "1Z999",
  storeName: "TPP eBay",
};

test("fillTemplate replaces {{buyer_name}} with buyer name", () => {
  assert.equal(fillTemplate("Hi {{buyer_name}},", ctx), "Hi John Smith,");
});

test("fillTemplate falls back to buyer username when name missing", () => {
  const out = fillTemplate("Hello {{buyer_name}}!", { ...ctx, buyerName: null });
  assert.equal(out, "Hello jsmith2024!");
});

test("fillTemplate handles {{first_name}}", () => {
  assert.equal(fillTemplate("Hi {{first_name}}", ctx), "Hi John");
});

test("fillTemplate is whitespace tolerant inside braces", () => {
  assert.equal(fillTemplate("Order {{ order_number }}", ctx), "Order ORDER-789");
});

test("fillTemplate is case-insensitive on placeholder name", () => {
  assert.equal(fillTemplate("ID: {{ITEM_ID}}", ctx), "ID: 12345");
});

test("fillTemplate keeps unknown placeholders intact", () => {
  assert.equal(
    fillTemplate("Unknown: {{xyz}}", ctx),
    "Unknown: {{xyz}}",
  );
});

test("fillTemplate keeps placeholder when value is null", () => {
  assert.equal(
    fillTemplate("Tracking: {{tracking_number}}", { ...ctx, trackingNumber: null }),
    "Tracking: {{tracking_number}}",
  );
});

test("findUnfilledPlaceholders enumerates all placeholders", () => {
  const list = findUnfilledPlaceholders(
    "Hi {{buyer_name}}, your order {{order_number}} ships from {{store_name}}.",
  );
  assert.deepEqual(list.sort(), ["buyer_name", "order_number", "store_name"].sort());
});
