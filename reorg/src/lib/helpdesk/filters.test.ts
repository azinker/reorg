import assert from "node:assert/strict";
import test from "node:test";

import { parseAction, parseConditions } from "@/lib/helpdesk/filters";
import {
  buildFolderWhere,
  BUYER_CANCELLATION_TAG_NAME,
} from "@/lib/helpdesk/folders";

const ctx = { userId: "user_test" };

test("parseAction accepts cancel_requests as a valid folder", () => {
  const action = parseAction({
    type: "MOVE_TO_FOLDER",
    folder: "cancel_requests",
  });
  assert.equal(action.type, "MOVE_TO_FOLDER");
  assert.equal(action.folder, "cancel_requests");
});

test("parseAction rejects unknown folder values", () => {
  assert.throws(
    () => parseAction({ type: "MOVE_TO_FOLDER", folder: "garbage" }),
    /Invalid action folder/,
  );
});

test("parseConditions accepts a typical Cancel-Requests-by-subject rule", () => {
  // The whole point of the new action: an agent writes a one-rule filter on
  // subject and routes hits straight to Cancel Requests. Locking the shape
  // here so a future refactor can't quietly break the editor's saved rules.
  const conds = parseConditions({
    match: "ALL",
    rules: [
      {
        field: "subject",
        op: "contains",
        value: "wants to cancel an order",
        caseSensitive: false,
      },
    ],
  });
  assert.equal(conds.match, "ALL");
  assert.equal(conds.rules.length, 1);
  assert.equal(conds.rules[0].field, "subject");
});

// The exclusion contract: every "open" folder must hide tickets carrying
// the cancellation tag. If someone adds a new open folder later and forgets
// the `notCancellation` clause, this test will catch it.
const OPEN_FOLDERS_THAT_MUST_EXCLUDE_CANCEL = [
  "all_tickets",
  "all_new",
  "all_to_do",
  "all_waiting",
  "pre_sales",
  "my_tickets",
  "unassigned",
  "mentioned",
] as const;

for (const folder of OPEN_FOLDERS_THAT_MUST_EXCLUDE_CANCEL) {
  test(`buildFolderWhere(${folder}) excludes cancellation-tagged tickets`, () => {
    const where = buildFolderWhere(folder, ctx);
    const json = JSON.stringify(where);
    // We assert on the tag name string and the presence of a NOT clause —
    // which together mean "exclude tickets carrying this tag". This is loose
    // enough to survive minor refactors (re-ordering of AND clauses, etc.)
    // but tight enough to fail loudly if the exclusion is dropped.
    assert.match(json, new RegExp(`"name":"${BUYER_CANCELLATION_TAG_NAME}"`));
    assert.match(json, /"NOT":\{"tags":\{"some"/);
  });
}

test("buildFolderWhere(buyer_cancellation) REQUIRES the cancellation tag", () => {
  const where = buildFolderWhere("buyer_cancellation", ctx);
  const json = JSON.stringify(where);
  assert.match(json, new RegExp(`"name":"${BUYER_CANCELLATION_TAG_NAME}"`));
  // Inverse of the open-folder check: the buyer_cancellation folder uses
  // `tags: { some: ... }` (positive), not `NOT`. We make sure the tag clause
  // is the positive form by checking that there's no `NOT` wrapping it.
  assert.ok(
    !/"NOT":\{"tags"/.test(json),
    "buyer_cancellation must REQUIRE the tag, not exclude it",
  );
});
