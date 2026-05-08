import assert from "node:assert/strict";
import test from "node:test";
import {
  createHumanActionToken,
  isBlockedAutomationContext,
  liveEbayOrderMutationsEnabled,
  parseHumanActionToken,
} from "@/lib/manage-orders/safety";

test("human action token is scoped to user, store, order, action, and expiry", () => {
  process.env.MANAGE_ORDERS_HUMAN_ACTION_SECRET = "test-secret-value-with-enough-length";
  const token = createHumanActionToken({
    userId: "user_1",
    orderId: "10-14584-35650",
    store: "TPP_EBAY",
    actionType: "add_tracking",
    now: Date.now(),
  });
  const payload = parseHumanActionToken(token);
  assert.equal(payload.userId, "user_1");
  assert.equal(payload.orderId, "10-14584-35650");
  assert.equal(payload.store, "TPP_EBAY");
  assert.equal(payload.actionType, "add_tracking");
});

test("live eBay mutation flag fails closed unless explicitly true", () => {
  delete process.env.ENABLE_LIVE_EBAY_ORDER_MUTATIONS;
  assert.equal(liveEbayOrderMutationsEnabled(), false);
  process.env.ENABLE_LIVE_EBAY_ORDER_MUTATIONS = "false";
  assert.equal(liveEbayOrderMutationsEnabled(), false);
  process.env.ENABLE_LIVE_EBAY_ORDER_MUTATIONS = "true";
  assert.equal(liveEbayOrderMutationsEnabled(), true);
});

test("automation and Playwright contexts are blocked", () => {
  process.env.PLAYWRIGHT_TEST = "1";
  assert.equal(isBlockedAutomationContext(new Headers()), true);
  delete process.env.PLAYWRIGHT_TEST;
  assert.equal(isBlockedAutomationContext(new Headers({ "user-agent": "Playwright" })), true);
  assert.equal(isBlockedAutomationContext(new Headers({ "x-trigger-source": "scheduler" })), true);
});
