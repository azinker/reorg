import assert from "node:assert/strict";
import test from "node:test";
import { fetchNeweggOrdersPage } from "@/lib/services/newegg";

test("fetchNeweggOrdersPage parses OrderInfoList when returned as a bare array", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    IsSuccess: true,
    ResponseBody: {
      PageInfo: { TotalCount: 1, TotalPageCount: 1, PageIndex: 1 },
      OrderInfoList: [{
        OrderNumber: 565421574,
        OrderStatus: 0,
        OrderStatusDescription: "Unshipped",
        OrderDate: "06/30/2026 20:10:21",
        CustomerName: "Jane Buyer",
        ShipToAddress1: "123 Main St",
        ShipToCityName: "Riverside",
        ShipToStateCode: "CA",
        ShipToZipCode: "92501",
        ShipToCountryCode: "USA",
        ShipService: "Standard Shipping (5-7 business days)",
        ItemInfoList: [{
          SellerPartNumber: "AB84_DIG_METER_BLU",
          OrderedQty: 1,
          ShippedQty: 0,
          Status: 0,
        }],
        PackageInfoList: [],
      }],
    },
  }), { status: 200 })) as typeof fetch;

  process.env.NEWEGG_SELLER_ID = "BBFJ";
  process.env.NEWEGG_API_KEY = "test-key";
  process.env.NEWEGG_SECRET_KEY = "test-secret";

  try {
    const result = await fetchNeweggOrdersPage({ status: 0 });
    assert.equal(result.totalCount, 1);
    assert.equal(result.orders.length, 1);
    assert.equal(result.orders[0]?.orderNumber, "565421574");
    assert.equal(result.orders[0]?.items[0]?.sellerPartNumber, "AB84_DIG_METER_BLU");
    assert.equal(result.orders[0]?.shipService, "Standard Shipping (5-7 business days)");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.NEWEGG_SELLER_ID;
    delete process.env.NEWEGG_API_KEY;
    delete process.env.NEWEGG_SECRET_KEY;
  }
});

test("shipNeweggOrder uses v304 orderstatus endpoint and order ship service", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.Value.Shipment.PackageList.Package[0].ShipCarrier, "USPS");
    assert.equal(body.Value.Shipment.PackageList.Package[0].ShipService, "Standard Shipping (5-7 business days)");
    return new Response(JSON.stringify({
      IsSuccess: true,
      PackageProcessingSummary: { FailCount: 0 },
      Result: { OrderStatus: "Shipped" },
    }), { status: 200 });
  }) as typeof fetch;

  process.env.NEWEGG_SELLER_ID = "BBFJ";
  process.env.NEWEGG_API_KEY = "test-key";
  process.env.NEWEGG_SECRET_KEY = "test-secret";

  const { shipNeweggOrder } = await import("@/lib/services/newegg");

  try {
    await shipNeweggOrder({
      orderNumber: "565421574",
      trackingNumber: "9400111899223197428490",
      shipService: "Standard Shipping (5-7 business days)",
      items: [{ sellerPartNumber: "AB84_DIG_METER_BLU", neweggItemNumber: "9SIBBFJK1P9860", shippedQty: 1 }],
    });
    assert.match(requestedUrl, /version=304/);
    assert.match(requestedUrl, /565421574/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.NEWEGG_SELLER_ID;
    delete process.env.NEWEGG_API_KEY;
    delete process.env.NEWEGG_SECRET_KEY;
  }
});
