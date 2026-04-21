import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGlobalWriteLock,
  type HelpdeskFlagsSnapshot,
} from "@/lib/helpdesk/flags";

// These tests pin the SAFE-MODE-COUPLES-WRITE-LOCK contract:
//   - The global write lock can ONLY tighten safety; it can never enable a send.
//   - When the lock is ON, every effectiveCan* output is FALSE regardless of
//     env flags (HELPDESK_ENABLE_EBAY_SEND, etc.).
//   - When the lock is OFF, behavior matches env-only safe-mode rules.
//
// Together with the existing flags.test.ts (env-only) and the regression cases
// below, this guarantees flipping the Settings → Write Safety toggle
// immediately silences Help Desk outbound traffic.

function snapshot(overrides: Partial<HelpdeskFlagsSnapshot> = {}): HelpdeskFlagsSnapshot {
  // A fully-permissive base snapshot (sends would be allowed if not for the
  // lock). Tests then layer the lock on top and assert the lock dominates.
  return {
    safeMode: false,
    envSafeMode: false,
    globalWriteLock: false,
    enableEbaySend: true,
    enableResendExternal: true,
    enableAttachments: true,
    enableEbayReadSync: true,
    effectiveCanSendEbay: true,
    effectiveCanSendEmail: true,
    effectiveCanSyncReadState: true,
    ...overrides,
  };
}

test("lock OFF + env safe OFF → sends remain allowed (env wins)", () => {
  const out = applyGlobalWriteLock(snapshot(), false);
  assert.equal(out.safeMode, false);
  assert.equal(out.globalWriteLock, false);
  assert.equal(out.effectiveCanSendEbay, true);
  assert.equal(out.effectiveCanSendEmail, true);
  assert.equal(out.effectiveCanSyncReadState, true);
});

test("lock ON forces safeMode=true and disables ALL outbound, even with env flags on", () => {
  const out = applyGlobalWriteLock(snapshot(), true);
  assert.equal(out.safeMode, true);
  assert.equal(out.globalWriteLock, true);
  assert.equal(out.effectiveCanSendEbay, false);
  assert.equal(out.effectiveCanSendEmail, false);
  assert.equal(out.effectiveCanSyncReadState, false);
});

test("lock ON dominates even when env safe mode is also ON (no double-negative bug)", () => {
  const out = applyGlobalWriteLock(snapshot({ envSafeMode: true }), true);
  assert.equal(out.safeMode, true);
  assert.equal(out.globalWriteLock, true);
  assert.equal(out.effectiveCanSendEbay, false);
});

test("lock OFF preserves env safe mode behavior (env safe ON → no sends)", () => {
  const out = applyGlobalWriteLock(snapshot({ envSafeMode: true }), false);
  assert.equal(out.safeMode, true);
  assert.equal(out.globalWriteLock, false);
  assert.equal(out.effectiveCanSendEbay, false);
  assert.equal(out.effectiveCanSendEmail, false);
  assert.equal(out.effectiveCanSyncReadState, false);
});

test("lock cannot ENABLE a send that the env disabled", () => {
  // Even with the lock OFF, if the env explicitly disabled the channel the
  // resolver must not magically re-enable it.
  const out = applyGlobalWriteLock(
    snapshot({ enableEbaySend: false, effectiveCanSendEbay: false }),
    false,
  );
  assert.equal(out.effectiveCanSendEbay, false);
});

test("lock ON preserves the unrelated `enableAttachments` env value (display-only flag)", () => {
  // `enableAttachments` is a permissioning flag that doesn't gate eBay calls
  // by itself — it gates whether the composer accepts files. The lock should
  // not silently mutate it.
  const out = applyGlobalWriteLock(snapshot({ enableAttachments: true }), true);
  assert.equal(out.enableAttachments, true);
});

test("envSafeMode is preserved on the output (so the UI can still tell which lock is engaged)", () => {
  // The Settings page distinguishes "env safe mode" (set by deploy) from
  // "global write lock" (toggleable in the UI). Both fields must survive
  // the composition unchanged so the banner shows the right reason.
  const out = applyGlobalWriteLock(snapshot({ envSafeMode: true }), true);
  assert.equal(out.envSafeMode, true);
  assert.equal(out.globalWriteLock, true);
});
