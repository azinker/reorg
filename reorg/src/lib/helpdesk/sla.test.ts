import assert from "node:assert/strict";
import test from "node:test";
import { computeSla } from "@/lib/helpdesk/sla";

// Use a fixed UTC timezone for tests so DST transitions in NY don't change
// expected business-hour math. UTC has no DST, and the default config is just
// 9-17 Mon-Fri, so we override to UTC for deterministic numbers.
const UTC_CFG = {
  timezone: "UTC",
};

test("computeSla returns NA when buyer has not messaged", () => {
  const r = computeSla(
    { lastBuyerMessageAt: null, firstResponseAt: null },
    UTC_CFG,
  );
  assert.equal(r.bucket, "NA");
  assert.equal(r.elapsedBusinessMs, 0);
});

test("computeSla returns MET when agent replied after buyer's last message", () => {
  const lastBuyer = new Date("2026-01-05T10:00:00Z"); // Mon 10:00 UTC
  const replied = new Date("2026-01-05T10:30:00Z");
  const r = computeSla(
    { lastBuyerMessageAt: lastBuyer, firstResponseAt: replied },
    UTC_CFG,
  );
  assert.equal(r.bucket, "MET");
});

test("computeSla returns GREEN within first 12 business hours", () => {
  const lastBuyer = new Date("2026-01-05T10:00:00Z"); // Mon 10:00 UTC
  const now = new Date("2026-01-05T16:00:00Z"); // 6 business hours later
  const r = computeSla(
    { lastBuyerMessageAt: lastBuyer, firstResponseAt: null, now },
    UTC_CFG,
  );
  assert.equal(r.bucket, "GREEN");
  assert.ok(r.elapsedBusinessMs >= 5.9 * 3600_000);
  assert.ok(r.elapsedBusinessMs <= 6.1 * 3600_000);
});

test("computeSla skips weekend hours when calculating elapsed", () => {
  // Buyer messages Friday 16:30 UTC. Now is Monday 09:30 UTC.
  // Business hours from Fri 16:30 → Fri 17:00 = 30 min.
  // Weekend skipped. Mon 09:00 → 09:30 = 30 min. Total = 1h business.
  const lastBuyer = new Date("2026-01-02T16:30:00Z"); // Fri
  const now = new Date("2026-01-05T09:30:00Z"); // Mon
  const r = computeSla(
    { lastBuyerMessageAt: lastBuyer, firstResponseAt: null, now },
    UTC_CFG,
  );
  // Allow a little slack for the sweep granularity (default 1 minute).
  assert.ok(
    Math.abs(r.elapsedBusinessMs - 60 * 60_000) < 5 * 60_000,
    `expected ~1h, got ${r.elapsedBusinessMs / 60_000}m`,
  );
  assert.equal(r.bucket, "GREEN");
});

test("computeSla flags AMBER between 12h and 24h business", () => {
  const lastBuyer = new Date("2026-01-05T09:00:00Z"); // Mon 09:00 UTC
  // After 8h Mon + 8h Tue = 16h business, well past 12h amber threshold.
  const now = new Date("2026-01-06T13:00:00Z"); // Tue 13:00 UTC
  const r = computeSla(
    { lastBuyerMessageAt: lastBuyer, firstResponseAt: null, now },
    UTC_CFG,
  );
  assert.equal(r.bucket, "AMBER");
});

test("computeSla flags RED past 24 business hours", () => {
  const lastBuyer = new Date("2026-01-05T09:00:00Z"); // Mon 09:00 UTC
  // After Mon 8h + Tue 8h + Wed 8h = 24h. Use Wed 17:00 to land at the boundary,
  // and bump 1 minute to ensure RED.
  const now = new Date("2026-01-07T17:01:00Z");
  const r = computeSla(
    { lastBuyerMessageAt: lastBuyer, firstResponseAt: null, now },
    UTC_CFG,
  );
  assert.equal(r.bucket, "RED");
});
