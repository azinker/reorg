import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HelpdeskMessageDirection,
  HelpdeskMessageSource,
} from "@prisma/client";
import { classifyMessageSource } from "./message-source";

const NO_AR = new Set<string>();

describe("classifyMessageSource", () => {
  it("inbound buyer mail is always EBAY", () => {
    const source = classifyMessageSource({
      direction: HelpdeskMessageDirection.INBOUND,
      ebayMessageId: "msg-1",
      externalMessageId: null,
      autoResponderMessageIds: NO_AR,
    });
    assert.equal(source, HelpdeskMessageSource.EBAY);
  });

  it("inbound mail with our envelope still classifies as EBAY (we never send to ourselves)", () => {
    // Defensive: even if eBay echoed back our externalMessageID on an
    // inbound row (it doesn't, but a future API change shouldn't flip
    // direction-based classification), we should not call it AR.
    const source = classifyMessageSource({
      direction: HelpdeskMessageDirection.INBOUND,
      ebayMessageId: "msg-1",
      externalMessageId: "reorg:job_abc",
      autoResponderMessageIds: new Set(["msg-1"]),
    });
    assert.equal(source, HelpdeskMessageSource.EBAY);
  });

  it("outbound with reorG envelope classifies as EBAY (sent through outbound worker)", () => {
    const source = classifyMessageSource({
      direction: HelpdeskMessageDirection.OUTBOUND,
      ebayMessageId: "msg-1",
      externalMessageId: "reorg:job_abc",
      autoResponderMessageIds: NO_AR,
    });
    assert.equal(source, HelpdeskMessageSource.EBAY);
  });

  it("outbound matched in the AR send log classifies as AUTO_RESPONDER", () => {
    const source = classifyMessageSource({
      direction: HelpdeskMessageDirection.OUTBOUND,
      ebayMessageId: "msg-42",
      externalMessageId: null,
      autoResponderMessageIds: new Set(["msg-42"]),
    });
    assert.equal(source, HelpdeskMessageSource.AUTO_RESPONDER);
  });

  it("reorG envelope wins over the AR set (covers AR jobs that ran through outbound)", () => {
    // Defensive: if a future code path queues an AR message through the
    // outbound worker (giving it a `reorg:` envelope) AND records it in
    // the AR log, we should classify by the most specific route — EBAY.
    // This documents the precedence and prevents accidental drift.
    const source = classifyMessageSource({
      direction: HelpdeskMessageDirection.OUTBOUND,
      ebayMessageId: "msg-7",
      externalMessageId: "reorg:job_xyz",
      autoResponderMessageIds: new Set(["msg-7"]),
    });
    assert.equal(source, HelpdeskMessageSource.EBAY);
  });

  it("outbound without envelope or AR match falls back to EBAY_UI", () => {
    const source = classifyMessageSource({
      direction: HelpdeskMessageDirection.OUTBOUND,
      ebayMessageId: "msg-99",
      externalMessageId: null,
      autoResponderMessageIds: NO_AR,
    });
    assert.equal(source, HelpdeskMessageSource.EBAY_UI);
  });

  it("outbound with a non-reorG envelope falls back to EBAY_UI", () => {
    // eBay sometimes round-trips an external-id we don't own (legacy
    // integrations, manual edits). It should not be misread as a reorG
    // send.
    const source = classifyMessageSource({
      direction: HelpdeskMessageDirection.OUTBOUND,
      ebayMessageId: "msg-100",
      externalMessageId: "shopify:abc-123",
      autoResponderMessageIds: NO_AR,
    });
    assert.equal(source, HelpdeskMessageSource.EBAY_UI);
  });

  it("missing ebayMessageId on outbound cannot match the AR set (set lookup is safe)", () => {
    const source = classifyMessageSource({
      direction: HelpdeskMessageDirection.OUTBOUND,
      ebayMessageId: null,
      externalMessageId: null,
      autoResponderMessageIds: new Set(["msg-1"]),
    });
    assert.equal(source, HelpdeskMessageSource.EBAY_UI);
  });
});
