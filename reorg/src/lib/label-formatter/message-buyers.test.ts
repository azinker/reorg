import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Platform } from "@prisma/client";
import {
  canMessageReshipRow,
  channelForSourceStore,
  templateContextForReshipRow,
} from "./message-buyers";

describe("message-buyers", () => {
  it("maps eBay source stores to help desk channels", () => {
    assert.equal(channelForSourceStore("EBAY_TPP"), Platform.TPP_EBAY);
    assert.equal(channelForSourceStore("EBAY_TT"), Platform.TT_EBAY);
    assert.equal(channelForSourceStore("SHOPIFY"), null);
    assert.equal(channelForSourceStore("BIGCOMMERCE"), null);
    assert.equal(channelForSourceStore("MANUAL"), null);
  });

  it("allows messaging only for eBay stores", () => {
    assert.equal(canMessageReshipRow("EBAY_TPP"), true);
    assert.equal(canMessageReshipRow("EBAY_TT"), true);
    assert.equal(canMessageReshipRow("SHOPIFY"), false);
  });

  it("builds template context from reship row and ticket", () => {
    const ctx = templateContextForReshipRow(
      {
        reshipRowId: "row-1",
        orderNumber: "01-12345-67890",
        sourceStore: "EBAY_TPP",
        buyerName: "Jane Doe",
        trackingNumber: "9400111899223344556677",
        sourceStoreLabel: "eBay TPP",
      },
      {
        id: "ticket-1",
        buyerName: "Jane Q Doe",
        buyerUserId: "janebuyer",
        ebayItemId: "1234567890",
        ebayItemTitle: "Widget",
      } as never,
    );

    assert.equal(ctx.deliveryName, "Jane Doe");
    assert.equal(ctx.buyerName, "Jane Q Doe");
    assert.equal(ctx.buyerUserId, "janebuyer");
    assert.equal(ctx.ebayOrderNumber, "01-12345-67890");
    assert.equal(ctx.trackingNumber, "9400111899223344556677");
    assert.equal(ctx.storeName, "eBay TPP");
    assert.equal(ctx.ebayItemId, "1234567890");
    assert.equal(ctx.ebayItemTitle, "Widget");
  });
});
