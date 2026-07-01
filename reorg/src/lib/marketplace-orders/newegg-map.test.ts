import assert from "node:assert/strict";
import test from "node:test";
import { mapNeweggOrder, neweggShipItemsFromRow } from "@/lib/marketplace-orders/newegg-map";
import type { NeweggOrder } from "@/lib/services/newegg";

const sampleOrder: NeweggOrder = {
  orderNumber: "557128772",
  orderStatus: 0,
  orderStatusDescription: "Unshipped",
  orderDate: "06/20/2026 10:15:20",
  customerName: "Jane Buyer",
  customerEmail: "buyer@example.com",
  customerPhone: "555-0100",
  shipToAddress1: "123 Main St",
  shipToAddress2: "Apt 4",
  shipToCity: "Columbus",
  shipToState: "OH",
  shipToZip: "43215",
  shipToCountry: "USA",
  orderTotalAmount: 19.99,
  trackingNumbers: [],
  items: [{
    sellerPartNumber: "SKU-123",
    neweggItemNumber: "NE-999",
    description: "Widget",
    orderedQty: 2,
    shippedQty: 0,
    status: 0,
    statusDescription: "Unshipped",
  }],
  packages: [],
};

test("mapNeweggOrder marks unshipped orders as shippable", () => {
  const row = mapNeweggOrder(sampleOrder);
  assert.equal(row.store, "NEWEGG");
  assert.equal(row.canShip, true);
  assert.equal(row.lineItems[0]?.sku, "SKU-123");
  assert.equal(row.lineItems[0]?.quantity, 2);
});

test("neweggShipItemsFromRow uses seller part numbers", () => {
  const row = mapNeweggOrder(sampleOrder);
  assert.deepEqual(neweggShipItemsFromRow(row), [{
    sellerPartNumber: "SKU-123",
    neweggItemNumber: "NE-999",
    shippedQty: 2,
  }]);
});
