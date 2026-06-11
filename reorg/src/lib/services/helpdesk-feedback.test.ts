import test from "node:test";
import assert from "node:assert/strict";
import { HelpdeskFeedbackKind } from "@prisma/client";
import {
  applyFeedbackRemovals,
  filterFeedbackSnapshotsToOrder,
  isEbayAutomatedFeedbackComment,
  isEbayAutomatedFeedbackSnapshot,
  suppressReplacedAutomatedFeedback,
  type HelpdeskFeedbackSnapshot,
} from "@/lib/services/helpdesk-feedback";

function snapshot(
  overrides: Partial<HelpdeskFeedbackSnapshot> = {},
): HelpdeskFeedbackSnapshot {
  return {
    id: "fb-1",
    externalId: "ext-1",
    kind: HelpdeskFeedbackKind.NEGATIVE,
    starRating: null,
    comment: "Item arrived broken",
    sellerResponse: null,
    ebayOrderNumber: "26-14643-94920",
    ebayItemId: "204430636029",
    buyerUserId: "buyer1",
    leftAt: "2026-06-10T19:11:50.000Z",
    source: "mirror",
    isAutomated: false,
    ...overrides,
  };
}

test("detects eBay automated feedback comment", () => {
  assert.equal(
    isEbayAutomatedFeedbackComment("Order delivered on time with no issues"),
    true,
  );
  assert.equal(
    isEbayAutomatedFeedbackComment(" order delivered on time with no issues. "),
    true,
  );
});

test("does not treat normal buyer feedback as automated", () => {
  assert.equal(isEbayAutomatedFeedbackComment("Great seller, thanks!"), false);
  assert.equal(
    isEbayAutomatedFeedbackSnapshot({
      kind: HelpdeskFeedbackKind.POSITIVE,
      comment: "Great seller, thanks!",
    }),
    false,
  );
  assert.equal(
    isEbayAutomatedFeedbackSnapshot({
      kind: HelpdeskFeedbackKind.NEGATIVE,
      comment: "Order delivered on time with no issues",
    }),
    false,
  );
});

test("marks positive eBay automated feedback snapshots", () => {
  assert.equal(
    isEbayAutomatedFeedbackSnapshot({
      kind: HelpdeskFeedbackKind.POSITIVE,
      comment: "Order delivered on time with no issues",
    }),
    true,
  );
});

test("applyFeedbackRemovals marks buyer feedback left before the notice", () => {
  const out = applyFeedbackRemovals(
    [snapshot()],
    [{ at: "2026-06-10T21:19:36.000Z", ebayItemId: "204430636029" }],
  );
  assert.equal(out[0]!.removedAt, "2026-06-10T21:19:36.000Z");
});

test("applyFeedbackRemovals leaves removedAt null without notices", () => {
  const out = applyFeedbackRemovals([snapshot()], []);
  assert.equal(out[0]!.removedAt, null);
});

test("applyFeedbackRemovals never marks automated feedback", () => {
  const out = applyFeedbackRemovals(
    [
      snapshot({
        id: "fb-auto",
        kind: HelpdeskFeedbackKind.POSITIVE,
        comment: "Order delivered on time with no issues",
        isAutomated: true,
      }),
    ],
    [{ at: "2026-06-10T21:19:36.000Z", ebayItemId: null }],
  );
  assert.equal(out[0]!.removedAt, null);
});

test("applyFeedbackRemovals skips feedback left after the notice", () => {
  const out = applyFeedbackRemovals(
    [snapshot({ leftAt: "2026-06-11T00:00:00.000Z" })],
    [{ at: "2026-06-10T21:19:36.000Z", ebayItemId: null }],
  );
  assert.equal(out[0]!.removedAt, null);
});

test("applyFeedbackRemovals scopes by item id and marks one snapshot per notice", () => {
  const out = applyFeedbackRemovals(
    [
      snapshot({ id: "a", externalId: "a", ebayItemId: "111" }),
      snapshot({ id: "b", externalId: "b", ebayItemId: "222" }),
    ],
    [{ at: "2026-06-10T21:19:36.000Z", ebayItemId: "222" }],
  );
  const a = out.find((s) => s.id === "a")!;
  const b = out.find((s) => s.id === "b")!;
  assert.equal(a.removedAt, null);
  assert.equal(b.removedAt, "2026-06-10T21:19:36.000Z");
});

function automated(
  overrides: Partial<HelpdeskFeedbackSnapshot> = {},
): HelpdeskFeedbackSnapshot {
  return snapshot({
    id: "fb-auto",
    externalId: "ext-auto",
    kind: HelpdeskFeedbackKind.POSITIVE,
    comment: "Order delivered on time with no issues",
    isAutomated: true,
    leftAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  });
}

test("suppressReplacedAutomatedFeedback drops automated when buyer authored later", () => {
  const out = suppressReplacedAutomatedFeedback([
    automated(),
    snapshot({ leftAt: "2026-06-11T00:00:00.000Z" }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.isAutomated, false);
});

test("suppressReplacedAutomatedFeedback keeps automated when no buyer feedback exists", () => {
  const out = suppressReplacedAutomatedFeedback([automated()]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.isAutomated, true);
});

test("suppressReplacedAutomatedFeedback keeps automated left AFTER the buyer feedback", () => {
  // buyer negative (later removed) → automated positive posted afterwards.
  const out = suppressReplacedAutomatedFeedback([
    snapshot({ leftAt: "2026-05-01T00:00:00.000Z", removedAt: "2026-05-02T00:00:00.000Z" }),
    automated({ leftAt: "2026-05-20T12:00:00.000Z" }),
  ]);
  assert.equal(out.length, 2);
});

test("suppressReplacedAutomatedFeedback scopes by item id", () => {
  const out = suppressReplacedAutomatedFeedback([
    automated({ id: "auto-111", externalId: "auto-111", ebayItemId: "111" }),
    automated({ id: "auto-222", externalId: "auto-222", ebayItemId: "222" }),
    snapshot({ ebayItemId: "111", leftAt: "2026-06-11T00:00:00.000Z" }),
  ]);
  // Buyer replaced item 111's automated entry; item 222's stays.
  assert.deepEqual(
    out.map((s) => s.id).sort(),
    ["auto-222", "fb-1"],
  );
});

test("suppressReplacedAutomatedFeedback treats missing item ids as order-wide", () => {
  const out = suppressReplacedAutomatedFeedback([
    automated({ ebayItemId: null }),
    snapshot({ ebayItemId: "111", leftAt: "2026-06-11T00:00:00.000Z" }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.isAutomated, false);
});

// ─── filterFeedbackSnapshotsToOrder ──────────────────────────────────────────
// Same buyer, same listing, two orders: feedback must be split by the
// transaction id each piece of feedback was left on.

test("filterFeedbackSnapshotsToOrder keeps only this order's transactions", () => {
  const out = filterFeedbackSnapshotsToOrder(
    [
      snapshot({ id: "this", externalId: "this", transactionId: "111", ebayOrderNumber: null }),
      snapshot({ id: "other", externalId: "other", transactionId: "999", ebayOrderNumber: null }),
    ],
    {
      ebayOrderNumber: "22-14652-54249",
      lineItems: [{ transactionId: "111", orderLineItemId: "226335769140-111" }],
    },
  );
  assert.deepEqual(out.map((s) => s.id), ["this"]);
});

test("filterFeedbackSnapshotsToOrder matches via orderLineItemId too", () => {
  const out = filterFeedbackSnapshotsToOrder(
    [
      snapshot({
        id: "a",
        externalId: "a",
        transactionId: null,
        orderLineItemId: "226335769140-111",
        ebayOrderNumber: null,
      }),
    ],
    {
      ebayOrderNumber: "22-14652-54249",
      lineItems: [{ transactionId: null, orderLineItemId: "226335769140-111" }],
    },
  );
  assert.equal(out.length, 1);
});

test("filterFeedbackSnapshotsToOrder falls back to order number without transaction info", () => {
  const out = filterFeedbackSnapshotsToOrder(
    [
      snapshot({ id: "mine", externalId: "mine", ebayOrderNumber: "22-14652-54249" }),
      snapshot({ id: "other", externalId: "other", ebayOrderNumber: "16-14695-46545" }),
    ],
    { ebayOrderNumber: "22-14652-54249", lineItems: null },
  );
  assert.deepEqual(out.map((s) => s.id), ["mine"]);
});

test("filterFeedbackSnapshotsToOrder keeps snapshots when nothing is comparable", () => {
  const out = filterFeedbackSnapshotsToOrder(
    [snapshot({ transactionId: null, orderLineItemId: null, ebayOrderNumber: null })],
    { ebayOrderNumber: "22-14652-54249", lineItems: [] },
  );
  assert.equal(out.length, 1);
});
