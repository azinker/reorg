import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReturnActionError } from "./returns-errors";

test("normalizeReturnActionError turns eBay deduction errors into a seller-friendly message", () => {
  const normalized = normalizeReturnActionError({
    source: "EBAY",
    message: "eBay 400: Refund amount deduction not allowed.",
    httpStatus: 400,
    ebayRequestId: "request-1",
    ebayErrors: [
      {
        errorId: 1760,
        domain: "returnErrorDomain",
        category: "REQUEST",
        message: "Refund amount deduction not allowed.",
        parameters: [{ name: "parameter", value: "refundFeeType" }],
      },
    ],
  });

  assert.equal(
    normalized.userMessage,
    "A refund deduction is not available for this return. Check the return case directly on eBay, then refresh reorG before trying again.",
  );
  assert.equal(normalized.technicalDetails.httpStatus, 400);
  assert.equal(normalized.technicalDetails.ebayErrors?.[0]?.errorId, 1760);
  assert.equal(normalized.technicalDetails.ebayRequestId, "request-1");
});

test("normalizeReturnActionError hides generic eBay details behind a calm message", () => {
  const normalized = normalizeReturnActionError({
    source: "EBAY",
    httpStatus: 409,
    ebayErrors: [{ errorId: "123", message: "Some current eBay state rejected this." }],
  });

  assert.equal(
    normalized.userMessage,
    "eBay did not accept this return action. Check the return case directly on eBay, then refresh reorG before trying again.",
  );
  assert.equal(normalized.technicalDetails.ebayErrors?.[0]?.message, "Some current eBay state rejected this.");
});
