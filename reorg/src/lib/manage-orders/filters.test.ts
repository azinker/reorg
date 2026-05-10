import assert from "node:assert/strict";
import test from "node:test";
import {
  isExpeditedShippingService,
  matchesSearch,
  matchesStatusFilter,
  periodToDateRange,
} from "@/lib/manage-orders/filters";
import type { ManageOrder } from "@/lib/manage-orders/types";

const baseOrder: ManageOrder = {
  orderId: "10-14584-35650",
  apiOrderId: "10-14584-35650",
  store: "TPP_EBAY",
  platform: "TPP_EBAY",
  buyerName: "Jane Buyer",
  buyerUsername: "janeb",
  shippingPostalCode: "33064",
  shippingAddress: null,
  createdTime: "2026-05-07T10:00:00.000Z",
  paidTime: "2026-05-07T10:05:00.000Z",
  shipBy: "2026-05-08T10:00:00.000Z",
  estimatedDeliveryMin: null,
  estimatedDeliveryMax: null,
  actualDeliveryTime: null,
  shippedTime: null,
  shippingService: "USPSPriority",
  trackingNumbers: [],
  subtotalCents: 1000,
  shippingCents: 0,
  taxCents: null,
  totalCents: 1000,
  currency: "USD",
  salesRecordNumber: null,
  finance: {
    transactionFeesCents: null,
    adFeeCents: null,
    otherFeesCents: null,
    shippingLabelCents: null,
    orderEarningsCents: null,
    fundsStatus: null,
    fundsStatusDetail: null,
    feesKnown: false,
    source: "unavailable",
  },
  internalProfit: {
    itemCostCents: null,
    supplierShippingCents: null,
    outboundShippingCents: null,
    totalCogsCents: null,
    estimatedProfitCents: null,
    dataComplete: false,
  },
  feedback: {
    state: "UNKNOWN",
    items: [],
    checkedLive: false,
    leaveBy: null,
  },
  cases: {
    hasCases: false,
    openCount: 0,
    items: [],
  },
  lines: [
    {
      itemId: "123",
      orderLineItemId: null,
      transactionId: null,
      title: "Rechargeable light",
      variationSelections: [],
      sku: "AA01_LIGHT",
      quantity: 2,
      availableQuantity: 9,
      unitPriceCents: 500,
      imageUrl: null,
      listingUrl: null,
      supplierCostCents: null,
      supplierShippingCents: null,
      outboundShippingCents: null,
      adRate: null,
    },
  ],
};

test("expedited classification uses service metadata, not shipping price", () => {
  assert.equal(isExpeditedShippingService("USPSPriority"), true);
  assert.equal(isExpeditedShippingService("FedExStandardOvernight"), true);
  assert.equal(isExpeditedShippingService("USPSGroundAdvantage"), false);
  assert.equal(isExpeditedShippingService(null), false);
});

test("status filters exclude shipped orders and detect ship-by window", () => {
  const now = new Date("2026-05-07T12:00:00.000Z");
  assert.equal(matchesStatusFilter(baseOrder, "awaiting_shipment", now), true);
  assert.equal(matchesStatusFilter(baseOrder, "ship_within_24h", now), true);
  assert.equal(matchesStatusFilter(baseOrder, "awaiting_expedited", now), true);
  assert.equal(matchesStatusFilter({ ...baseOrder, shippedTime: "2026-05-07T13:00:00.000Z" }, "awaiting_shipment", now), false);
  assert.equal(matchesStatusFilter({ ...baseOrder, shippedTime: "2026-05-07T13:00:00.000Z" }, "shipped", now), true);
  assert.equal(matchesStatusFilter({ ...baseOrder, shippedTime: "2026-05-07T13:00:00.000Z" }, "all_orders", now), true);
});

test("search prioritizes exact and allows partial fallback", () => {
  assert.equal(matchesSearch(baseOrder, "order_number", "10-14584-35650"), true);
  assert.equal(matchesSearch(baseOrder, "sku", "AA01"), true);
  assert.equal(matchesSearch(baseOrder, "item_title", "light"), true);
  assert.equal(
    matchesSearch(
      { ...baseOrder, trackingNumbers: [{ carrier: "USPS", number: "9501993814438233627164", shippedTime: null }] },
      "tracking_number",
      "9501993814438233627164",
    ),
    true,
  );
  assert.equal(
    matchesSearch(
      { ...baseOrder, trackingNumbers: [{ carrier: "USPS", number: "9501 9938 1443 8233 6271 64", shippedTime: null }] },
      "tracking_number",
      "9501993814438233627164",
    ),
    true,
  );
  assert.equal(matchesSearch(baseOrder, "buyer_username", "missing"), false);
});

test("period mapping creates expected rough ranges", () => {
  const now = new Date("2026-05-07T12:00:00.000Z");
  assert.equal(Math.round((now.getTime() - periodToDateRange("last_week", now).from.getTime()) / 86_400_000), 7);
  assert.equal(Math.round((now.getTime() - periodToDateRange("last_90_days", now).from.getTime()) / 86_400_000), 90);
});
