import test from "node:test";
import assert from "node:assert/strict";
import { HelpdeskFeedbackKind } from "@prisma/client";
import {
  isEbayAutomatedFeedbackComment,
  isEbayAutomatedFeedbackSnapshot,
} from "@/lib/services/helpdesk-feedback";

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
