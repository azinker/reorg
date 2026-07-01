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
        ItemInfoList: [{
          SellerPartNumber: "AB84 DIG METER BLU",
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
    assert.equal(result.orders[0]?.items[0]?.sellerPartNumber, "AB84 DIG METER BLU");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.NEWEGG_SELLER_ID;
    delete process.env.NEWEGG_API_KEY;
    delete process.env.NEWEGG_SECRET_KEY;
  }
});
