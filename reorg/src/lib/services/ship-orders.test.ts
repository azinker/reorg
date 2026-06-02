import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBigCommerceJsonArray,
  parseBigCommerceJsonObject,
} from "@/lib/services/ship-orders";

test("parseBigCommerceJsonArray treats blank successful bodies as an empty list", () => {
  assert.deepEqual(
    parseBigCommerceJsonArray<{ id: number }>("", "BigCommerce shipments list"),
    [],
  );
  assert.deepEqual(
    parseBigCommerceJsonArray<{ id: number }>("   \n", "BigCommerce shipments list"),
    [],
  );
});

test("parseBigCommerceJsonArray rejects non-array bodies with a specific error", () => {
  assert.throws(
    () => parseBigCommerceJsonArray<{ id: number }>("{\"id\":1}", "BigCommerce shipments list"),
    /BigCommerce shipments list returned unexpected JSON shape\./,
  );
});

test("parseBigCommerceJsonObject rejects blank required bodies with context", () => {
  assert.throws(
    () => parseBigCommerceJsonObject("", "BigCommerce shipment detail"),
    /BigCommerce shipment detail returned an empty response body\./,
  );
});
