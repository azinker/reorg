import assert from "node:assert/strict";
import test from "node:test";
import { buildFolderWhere, FOLDER_LABELS, type HelpdeskFolderKey } from "@/lib/helpdesk/folders";

const ctx = { userId: "user_123" };

test("FOLDER_LABELS covers every folder key", () => {
  const keys: HelpdeskFolderKey[] = [
    "pre_sales",
    "my_tickets",
    "all_tickets",
    "all_new",
    "all_to_do",
    "all_waiting",
    "buyer_cancellation",
    "snoozed",
    "resolved",
    "unassigned",
    "mentioned",
    "favorites",
    "spam",
    "archived",
  ];
  for (const k of keys) {
    assert.ok(FOLDER_LABELS[k], `missing label for ${k}`);
  }
});

test("buildFolderWhere(pre_sales) constrains kind=PRE_SALES and excludes archived/spam", () => {
  const where = buildFolderWhere("pre_sales", ctx) as Record<string, unknown>;
  assert.ok(Array.isArray(where.AND));
  const json = JSON.stringify(where);
  assert.match(json, /"kind":"PRE_SALES"/);
  assert.match(json, /"isArchived":false/);
  assert.match(json, /"isSpam":false/);
});

test("buildFolderWhere(my_tickets) checks both primary and additional assignee", () => {
  const where = buildFolderWhere("my_tickets", ctx);
  const json = JSON.stringify(where);
  assert.match(json, /"primaryAssigneeId":"user_123"/);
  assert.match(json, /"additionalAssignees"/);
});

test("buildFolderWhere(snoozed) requires snoozedUntil > now", () => {
  const where = buildFolderWhere("snoozed", ctx) as {
    snoozedUntil: { gt: Date };
    isArchived: boolean;
  };
  assert.ok(where.snoozedUntil.gt instanceof Date);
  assert.equal(where.isArchived, false);
});

test("buildFolderWhere(resolved) excludes archived", () => {
  const where = buildFolderWhere("resolved", ctx) as Record<string, unknown>;
  assert.equal(where.status, "RESOLVED");
  assert.equal(where.isArchived, false);
});

test("buildFolderWhere(archived) only matches archived rows", () => {
  const where = buildFolderWhere("archived", ctx) as { isArchived: boolean };
  assert.equal(where.isArchived, true);
});

test("buildFolderWhere(spam) excludes archived spam", () => {
  const where = buildFolderWhere("spam", ctx) as {
    isSpam: boolean;
    isArchived: boolean;
  };
  assert.equal(where.isSpam, true);
  assert.equal(where.isArchived, false);
});

test("buildFolderWhere(unassigned) requires primaryAssigneeId IS NULL", () => {
  const where = buildFolderWhere("unassigned", ctx);
  const json = JSON.stringify(where);
  assert.match(json, /"primaryAssigneeId":null/);
});

test("buildFolderWhere(mentioned) filters notes by ctx user", () => {
  const where = buildFolderWhere("mentioned", ctx);
  const json = JSON.stringify(where);
  assert.match(json, /"array_contains":\[\{"userId":"user_123"\}\]/);
  assert.match(json, /"isDeleted":false/);
});

test("buildFolderWhere(all_to_do) accepts both NEW and TO_DO so legacy rows still surface", () => {
  const where = buildFolderWhere("all_to_do", ctx);
  const json = JSON.stringify(where);
  // v2 semantics: NEW is folded into TO_DO. The Prisma `in` clause must
  // include both so historical rows from before the routing rewrite remain
  // visible without a one-off backfill.
  assert.match(json, /"status":\{"in":\["NEW","TO_DO"\]\}/);
  assert.match(json, /"snoozedUntil"/);
});

test("buildFolderWhere(all_new) is a back-compat alias for all_to_do (v2)", () => {
  const a = JSON.stringify(buildFolderWhere("all_new", ctx));
  const b = JSON.stringify(buildFolderWhere("all_to_do", ctx));
  assert.equal(a, b);
});

test("buildFolderWhere(favorites) matches starred non-archived tickets across statuses", () => {
  const where = buildFolderWhere("favorites", ctx) as {
    isFavorite: boolean;
    isArchived: boolean;
  };
  // Crucially, no status filter — agents can star RESOLVED tickets too.
  assert.equal(where.isFavorite, true);
  assert.equal(where.isArchived, false);
});

test("buildFolderWhere(buyer_cancellation) requires the cancellation tag and open status", () => {
  const where = buildFolderWhere("buyer_cancellation", ctx);
  const json = JSON.stringify(where);
  // Only matches open + not-snoozed tickets carrying the reserved tag.
  assert.match(json, /"name":"Buyer Request Cancellation"/);
  assert.match(json, /"isArchived":false/);
  assert.match(json, /"isSpam":false/);
  assert.match(json, /"snoozedUntil"/);
});
