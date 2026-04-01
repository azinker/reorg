import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNetworkTransferRouteLabel,
  getNetworkTransferChannelForApiPath,
  normalizeApiPathForNetworkTransfer,
} from "@/lib/network-transfer-request";

test("normalizeApiPathForNetworkTransfer collapses dynamic id-like segments", () => {
  assert.equal(
    normalizeApiPathForNetworkTransfer("/api/backup/cmng6tm310007l504352o9kk9/download"),
    "/api/backup/:id/download",
  );
  assert.equal(
    normalizeApiPathForNetworkTransfer("/api/users/123"),
    "/api/users/:id",
  );
});

test("buildNetworkTransferRouteLabel keeps method and normalized path", () => {
  assert.equal(
    buildNetworkTransferRouteLabel("post", "/api/inventory-forecaster/order/cmng6tm310007l504352o9kk9/download"),
    "POST /api/inventory-forecaster/order/:id/download",
  );
});

test("getNetworkTransferChannelForApiPath keeps forecaster traffic in the forecast bucket", () => {
  assert.equal(getNetworkTransferChannelForApiPath("/api/inventory-forecaster"), "FORECAST");
  assert.equal(getNetworkTransferChannelForApiPath("/api/grid"), "CLIENT_API_RESPONSE");
});
