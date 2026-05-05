import test from "node:test";
import assert from "node:assert/strict";

import { detectFromEbay, SYSTEM_MESSAGE_TYPES } from "@/lib/helpdesk/from-ebay-detect";

test("classifies eBay hold notices before broader INR wording", () => {
  const result = detectFromEbay({
    sender: "eBay",
    subject: "Case #5378488528: Your case is on hold",
    bodyText:
      "Your case was placed on hold temporarily. We will get back to you with an update by May 11, 2026. Case ID 5378488528 Case opened Apr 27, 2026 Case closed",
  });

  assert.equal(result.isFromEbay, true);
  assert.equal(result.systemMessageType, SYSTEM_MESSAGE_TYPES.CASE_ON_HOLD);
});

test("keeps item not received open notices classified as INR", () => {
  const result = detectFromEbay({
    sender: "eBay",
    subject: "Your buyer opened an item not received request: Request 5378488528",
    bodyText: "Your buyer opened a request because they haven't received their item.",
  });

  assert.equal(result.isFromEbay, true);
  assert.equal(result.systemMessageType, SYSTEM_MESSAGE_TYPES.ITEM_NOT_RECEIVED);
});
