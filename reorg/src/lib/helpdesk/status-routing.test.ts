import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HelpdeskTicketStatus } from "@prisma/client";
import {
  deriveStatusOnInbound,
  deriveStatusOnOutbound,
  deriveStatusOnSnoozeWake,
} from "./status-routing";

const baseTicket = {
  hasAgentReplied: false,
  isArchived: false,
  isSpam: false,
};

describe("deriveStatusOnInbound", () => {
  it("routes a brand-new buyer message to TO_DO (NEW is no longer used)", () => {
    const out = deriveStatusOnInbound({
      ...baseTicket,
      status: HelpdeskTicketStatus.NEW,
    });
    assert.equal(out, HelpdeskTicketStatus.TO_DO);
  });

  it("promotes WAITING → TO_DO when buyer replies after our outbound", () => {
    const out = deriveStatusOnInbound({
      ...baseTicket,
      hasAgentReplied: true,
      status: HelpdeskTicketStatus.WAITING,
    });
    assert.equal(out, HelpdeskTicketStatus.TO_DO);
  });

  it("reopens RESOLVED → TO_DO on a buyer follow-up", () => {
    const out = deriveStatusOnInbound({
      ...baseTicket,
      hasAgentReplied: true,
      status: HelpdeskTicketStatus.RESOLVED,
    });
    assert.equal(out, HelpdeskTicketStatus.TO_DO);
  });

  it("does not auto-undo SPAM when buyer follows up", () => {
    const out = deriveStatusOnInbound({
      ...baseTicket,
      isSpam: true,
      status: HelpdeskTicketStatus.SPAM,
    });
    assert.equal(out, HelpdeskTicketStatus.SPAM);
  });

  it("bounces ARCHIVED tickets back to TO_DO when buyer follows up", () => {
    // Per the spec: any archive is "we filed this away because the buyer
    // wasn't expecting a reply" — the moment the buyer messages again we
    // owe them an answer, so it has to land in the active queue. The
    // sync caller is responsible for clearing isArchived/archivedAt; this
    // helper just reports the new status.
    const out = deriveStatusOnInbound({
      ...baseTicket,
      isArchived: true,
      status: HelpdeskTicketStatus.WAITING,
    });
    assert.equal(out, HelpdeskTicketStatus.TO_DO);
  });

  it("still suppresses bounce for SPAM regardless of archive state", () => {
    const out = deriveStatusOnInbound({
      ...baseTicket,
      isArchived: true,
      isSpam: true,
      status: HelpdeskTicketStatus.SPAM,
    });
    assert.equal(out, HelpdeskTicketStatus.SPAM);
  });

  it("rolls TO_DO follow-ups forward to TO_DO (idempotent)", () => {
    const out = deriveStatusOnInbound({
      ...baseTicket,
      hasAgentReplied: true,
      status: HelpdeskTicketStatus.TO_DO,
    });
    assert.equal(out, HelpdeskTicketStatus.TO_DO);
  });

  it("ignores hasAgentReplied — even untouched threads land in TO_DO now", () => {
    const out = deriveStatusOnInbound({
      ...baseTicket,
      hasAgentReplied: false,
      status: HelpdeskTicketStatus.NEW,
    });
    assert.equal(out, HelpdeskTicketStatus.TO_DO);
  });
});

describe("deriveStatusOnOutbound", () => {
  it("honours an explicit RESOLVED choice from the composer", () => {
    const out = deriveStatusOnOutbound(
      HelpdeskTicketStatus.TO_DO,
      HelpdeskTicketStatus.RESOLVED,
    );
    assert.equal(out, HelpdeskTicketStatus.RESOLVED);
  });

  it("honours an explicit WAITING choice from the composer", () => {
    const out = deriveStatusOnOutbound(
      HelpdeskTicketStatus.TO_DO,
      HelpdeskTicketStatus.WAITING,
    );
    assert.equal(out, HelpdeskTicketStatus.WAITING);
  });

  it("defaults to WAITING when the composer did not specify", () => {
    const out = deriveStatusOnOutbound(HelpdeskTicketStatus.TO_DO, null);
    assert.equal(out, HelpdeskTicketStatus.WAITING);
  });

  it("does not unresolve a RESOLVED ticket on duplicate outbound fire", () => {
    const out = deriveStatusOnOutbound(HelpdeskTicketStatus.RESOLVED, null);
    assert.equal(out, HelpdeskTicketStatus.RESOLVED);
  });
});

describe("deriveStatusOnSnoozeWake", () => {
  it("wakes a snoozed ticket back to TO_DO", () => {
    const out = deriveStatusOnSnoozeWake(HelpdeskTicketStatus.WAITING, {
      isSpam: false,
      isArchived: false,
    });
    assert.equal(out, HelpdeskTicketStatus.TO_DO);
  });

  it("preserves SPAM when a snoozed spam row wakes up", () => {
    const out = deriveStatusOnSnoozeWake(HelpdeskTicketStatus.SPAM, {
      isSpam: true,
      isArchived: false,
    });
    assert.equal(out, HelpdeskTicketStatus.SPAM);
  });

  it("preserves the underlying status if archived", () => {
    const out = deriveStatusOnSnoozeWake(HelpdeskTicketStatus.WAITING, {
      isSpam: false,
      isArchived: true,
    });
    assert.equal(out, HelpdeskTicketStatus.WAITING);
  });
});
