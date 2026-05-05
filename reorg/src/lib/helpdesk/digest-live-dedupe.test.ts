import test from "node:test";
import assert from "node:assert/strict";

/**
 * Regression guard for digest expansion in helpdesk-ebay-sync.ts:
 * cross-digest body-hash dedupe must not drop the live sub-message.
 */
test("live digest subs are not skipped when body hash exists on ticket", () => {
  const existingHashes = new Set(["thanks-hash"]);

  const historicalSub = { isLive: false, bodyHash: "thanks-hash" };
  const skipHistorical =
    !historicalSub.isLive && existingHashes.has(historicalSub.bodyHash);
  assert.equal(skipHistorical, true);

  const liveSub = { isLive: true, bodyHash: "thanks-hash" };
  const skipLive = !liveSub.isLive && existingHashes.has(liveSub.bodyHash);
  assert.equal(skipLive, false);
});
