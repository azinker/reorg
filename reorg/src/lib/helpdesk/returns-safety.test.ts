import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateReturnWriteGate,
  type ReturnWriteGateContext,
} from "@/lib/helpdesk/returns-safety";
import type { EbayAvailableOption } from "@/lib/helpdesk/returns";

const opts = (...types: string[]): EbayAvailableOption[] =>
  types.map((t) => ({ actionType: t }));

// A base context where EVERY gate is satisfied for MARK_AS_RECEIVED.
function ctx(overrides: Partial<ReturnWriteGateContext> = {}): ReturnWriteGateContext {
  return {
    isAdmin: true,
    appEnv: "production",
    globalAndIntegrationAllowed: true,
    returnsLiveWritesEnabled: true,
    action: "MARK_AS_RECEIVED",
    freshSellerOptions: opts("SELLER_MARK_AS_RECEIVED"),
    ...overrides,
  };
}

test("all gates satisfied → allowed", () => {
  const r = evaluateReturnWriteGate(ctx());
  assert.equal(r.allowed, true);
  assert.equal(r.code, "OK");
});

test("non-admin blocked", () => {
  const r = evaluateReturnWriteGate(ctx({ isAdmin: false }));
  assert.equal(r.allowed, false);
  assert.equal(r.code, "NOT_ADMIN");
});

test("staging blocked even when everything else is on", () => {
  const r = evaluateReturnWriteGate(ctx({ appEnv: "staging" }));
  assert.equal(r.allowed, false);
  assert.equal(r.code, "STAGING_BLOCKED");
});

test("global/integration write lock blocks", () => {
  const r = evaluateReturnWriteGate(
    ctx({ globalAndIntegrationAllowed: false, globalAndIntegrationReason: "Global write lock is enabled." }),
  );
  assert.equal(r.allowed, false);
  assert.equal(r.code, "WRITE_LOCK");
  assert.match(r.reason, /write lock/i);
});

test("returns master toggle OFF blocks (the default LOCKED state)", () => {
  const r = evaluateReturnWriteGate(ctx({ returnsLiveWritesEnabled: false }));
  assert.equal(r.allowed, false);
  assert.equal(r.code, "RETURNS_LOCKED");
});

test("action not offered by fresh eBay options blocks", () => {
  const r = evaluateReturnWriteGate(
    ctx({ action: "ISSUE_REFUND", freshSellerOptions: opts("SELLER_MARK_AS_RECEIVED") }),
  );
  assert.equal(r.allowed, false);
  assert.equal(r.code, "ACTION_UNAVAILABLE");
});

test("empty fresh options → unavailable with state-based message", () => {
  const r = evaluateReturnWriteGate(
    ctx({ action: "ISSUE_REFUND", freshSellerOptions: [] }),
  );
  assert.equal(r.allowed, false);
  assert.equal(r.code, "ACTION_UNAVAILABLE");
  assert.match(r.reason, /not available on the current return state/i);
});

test("PROVIDE_EBAY_LABEL is allowed when eBay offers it (now wired)", () => {
  // Buying a prepaid eBay return label is wired in v1, so the gate must allow it
  // once eBay offers SELLER_PRINT_SHIPPING_LABEL and the live-write lock is off.
  const r = evaluateReturnWriteGate(
    ctx({ action: "PROVIDE_EBAY_LABEL", freshSellerOptions: opts("SELLER_PRINT_SHIPPING_LABEL") }),
  );
  assert.equal(r.allowed, true);
});

test("gate order: admin checked before everything (non-admin in staging still NOT_ADMIN)", () => {
  const r = evaluateReturnWriteGate(ctx({ isAdmin: false, appEnv: "staging" }));
  assert.equal(r.code, "NOT_ADMIN");
});

test("ISSUE_REFUND allowed when eBay offers SELLER_ISSUE_REFUND", () => {
  const r = evaluateReturnWriteGate(
    ctx({ action: "ISSUE_REFUND", freshSellerOptions: opts("SELLER_ISSUE_REFUND") }),
  );
  assert.equal(r.allowed, true);
});

test("APPROVE_RETURN allowed when eBay offers SELLER_APPROVE_REQUEST", () => {
  const r = evaluateReturnWriteGate(
    ctx({ action: "APPROVE_RETURN", freshSellerOptions: opts("SELLER_APPROVE_REQUEST") }),
  );
  assert.equal(r.allowed, true);
});
