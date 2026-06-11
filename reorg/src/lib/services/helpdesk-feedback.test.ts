import test from "node:test";
import assert from "node:assert/strict";
import { HelpdeskFeedbackKind } from "@prisma/client";
import {
  applyFeedbackRemovals,
  isEbayAutomatedFeedbackComment,
  isEbayAutomatedFeedbackSnapshot,
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
