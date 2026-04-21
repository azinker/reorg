import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HelpdeskTicketType } from "@prisma/client";
import { detectTicketType } from "./type-detect";

describe("detectTicketType", () => {
  it("returns null when nothing matches", () => {
    assert.equal(
      detectTicketType({ subject: "Hi", bodyText: "Just saying hello" }),
      null,
    );
  });

  it("maps eBay questionType=Return to RETURN_REQUEST (highest priority)", () => {
    assert.equal(
      detectTicketType({
        ebayQuestionType: "Return",
        subject: "Quick question about shipping",
      }),
      HelpdeskTicketType.RETURN_REQUEST,
    );
  });

  it("maps eBay questionType=ItemNotReceived to ITEM_NOT_RECEIVED", () => {
    assert.equal(
      detectTicketType({ ebayQuestionType: "ItemNotReceived" }),
      HelpdeskTicketType.ITEM_NOT_RECEIVED,
    );
  });

  it("maps eBay questionType=Shipping to SHIPPING_QUERY", () => {
    assert.equal(
      detectTicketType({ ebayQuestionType: "Shipping" }),
      HelpdeskTicketType.SHIPPING_QUERY,
    );
  });

  it("falls through to subject heuristics when questionType is unknown", () => {
    assert.equal(
      detectTicketType({
        ebayQuestionType: "UnknownNewEbayValue",
        subject: "Return Request for order 03-14290-90166",
      }),
      HelpdeskTicketType.RETURN_REQUEST,
    );
  });

  it("matches INR shorthand on subject", () => {
    assert.equal(
      detectTicketType({ subject: "INR claim filed" }),
      HelpdeskTicketType.ITEM_NOT_RECEIVED,
    );
  });

  it("matches refund on subject", () => {
    assert.equal(
      detectTicketType({ subject: "Need a refund please" }),
      HelpdeskTicketType.REFUND,
    );
  });

  it("matches cancellation on subject", () => {
    assert.equal(
      detectTicketType({ subject: "Please cancel my order" }),
      HelpdeskTicketType.CANCELLATION,
    );
  });

  it("matches negative feedback intent", () => {
    assert.equal(
      detectTicketType({
        subject: "About to leave feedback if not resolved",
      }),
      HelpdeskTicketType.NEGATIVE_FEEDBACK,
    );
  });

  it("matches shipping subject", () => {
    assert.equal(
      detectTicketType({ subject: "When will it ship?" }),
      HelpdeskTicketType.SHIPPING_QUERY,
    );
  });

  it("falls through to body when subject is generic", () => {
    assert.equal(
      detectTicketType({
        subject: "Order question",
        bodyText: "Hi, I haven't received my package yet, it's been 3 weeks.",
      }),
      HelpdeskTicketType.ITEM_NOT_RECEIVED,
    );
  });

  it("only scans first 500 chars of body", () => {
    // Stuff a "please cancel" deep in the body — should NOT match.
    const filler = "x".repeat(600);
    assert.equal(
      detectTicketType({
        subject: "Order question",
        bodyText: `${filler} please cancel`,
      }),
      null,
    );
  });

  it("subject takes precedence over body when both match different types", () => {
    assert.equal(
      detectTicketType({
        subject: "Refund please",
        bodyText: "Please cancel my order, I want a refund",
      }),
      HelpdeskTicketType.REFUND,
    );
  });
});
