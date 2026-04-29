import test from "node:test";
import assert from "node:assert/strict";
import { selectCurrentInventory } from "@/lib/helpdesk/inventory";

test("selectCurrentInventory prefers TPP eBay inventory", () => {
  assert.equal(
    selectCurrentInventory([
      { platform: "TT_EBAY", inventory: 18 },
      { platform: "TPP_EBAY", inventory: 7 },
    ]),
    7,
  );
});

test("selectCurrentInventory falls back to another platform when TPP inventory is unknown", () => {
  assert.equal(
    selectCurrentInventory([
      { platform: "TPP_EBAY", inventory: null },
      { platform: "SHOPIFY", inventory: 11 },
      { platform: "BIGCOMMERCE", inventory: 9 },
    ]),
    11,
  );
});

test("selectCurrentInventory preserves zero as known inventory", () => {
  assert.equal(
    selectCurrentInventory([
      { platform: "TPP_EBAY", inventory: 0 },
      { platform: "TT_EBAY", inventory: 4 },
    ]),
    0,
  );
});
