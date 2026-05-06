import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCaseStatusSummary,
  buildConversationSummary,
  type ConversationMessage,
  type ConversationTicket,
  type HelpdeskTimelineEvent,
} from "@/lib/helpdesk/conversation-summary";

const caseEvents: HelpdeskTimelineEvent[] = [
  event("1", "EBAY_ORDER_RECEIVED", "order_received", "Order Received", "2026-04-16T14:00:00.000Z"),
  event("2", "EBAY_ORDER_SHIPPED", "order_shipped", "Order Shipped", "2026-04-17T14:00:00.000Z"),
  event(
    "3",
    "EBAY_ITEM_NOT_RECEIVED_CASE",
    "case",
    "Buyer Opened INR Case",
    "2026-04-27T14:00:00.000Z",
  ),
  event(
    "4",
    "EBAY_CASE_ESCALATED",
    "case",
    "Buyer Escalated Case to eBay",
    "2026-05-01T14:00:00.000Z",
  ),
  event(
    "5",
    "EBAY_CASE_ON_HOLD",
    "case",
    "eBay Put Item Not Received Claim #5378488528 On Hold",
    "2026-05-01T15:00:00.000Z",
  ),
];

const messages: ConversationMessage[] = [
  {
    direction: "INBOUND",
    source: "SYSTEM",
    subject: "Case #5378488528: Your case is on hold",
    bodyText:
      "eBay Customer Support has placed the case on hold until May 11, 2026 to allow time to provide additional documentation.",
    sentAt: "2026-05-01T15:00:00.000Z",
    fromName: "eBay",
    fromIdentifier: null,
  },
  {
    direction: "INBOUND",
    source: "EBAY",
    subject: null,
    bodyText: "I want a refund. Why is it hard to get a refund of something i DID NOT GET?",
    sentAt: "2026-05-04T18:04:00.000Z",
    fromName: "Emiliano",
    fromIdentifier: "ians835",
  },
  {
    direction: "OUTBOUND",
    source: "EBAY",
    subject: null,
    bodyText: "I am so sorry. I am working with USPS to get the delay resolved this week.",
    sentAt: "2026-05-04T18:38:00.000Z",
    fromName: "Mike",
    fromIdentifier: null,
  },
];

test("buildCaseStatusSummary recognizes an INR case on hold with an expiry date", () => {
  const summary = buildCaseStatusSummary(caseEvents, messages);

  assert.ok(summary);
  assert.equal(summary.title, "Item Not Received Case");
  assert.equal(summary.status, "On Hold");
  assert.equal(summary.holdUntil, "May 11, 2026");
  assert.match(summary.agentNote, /on hold until May 11, 2026/);
});

test("buildConversationSummary includes order, case, buyer, and agent context", () => {
  const ticket: ConversationTicket = {
    subject: "Re: Thank You! Your item has been Shipped",
    buyerName: "Emiliano Ian II Suson",
    buyerUserId: "ians835",
    ebayOrderNumber: "04-14521-78193",
    ebayItemTitle: "High Speed Memory For Micro SD Card 32GB 64GB 128GB",
    type: "ITEM_NOT_RECEIVED",
    status: "TO_DO",
    messages,
  };

  const lines = buildConversationSummary(ticket, caseEvents);

  assert.ok(lines.some((line) => line.includes("Order 04-14521-78193")));
  assert.ok(lines.some((line) => line.includes("Order received Apr 16")));
  assert.ok(lines.some((line) => line.includes("hold expires May 11, 2026")));
  assert.ok(lines.some((line) => line.includes("Latest buyer message")));
  assert.ok(lines.some((line) => line.includes("Latest agent reply")));
});

function event(
  id: string,
  action: string,
  kind: string,
  text: string,
  at: string,
): HelpdeskTimelineEvent {
  return {
    id,
    type: "system",
    action,
    kind,
    text,
    at,
  };
}
