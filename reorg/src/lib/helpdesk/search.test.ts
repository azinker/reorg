import assert from "node:assert/strict";
import test from "node:test";
import {
  HELPDESK_ORDER_ID_PATTERN,
  resolveHelpdeskSearch,
} from "@/lib/helpdesk/search";

test("HELPDESK_ORDER_ID_PATTERN matches the canonical eBay Order ID shape", () => {
  assert.equal(HELPDESK_ORDER_ID_PATTERN.test("03-14290-90166"), true);
  assert.equal(HELPDESK_ORDER_ID_PATTERN.test("19-14450-91775"), true);
});

test("HELPDESK_ORDER_ID_PATTERN rejects sales record numbers (7-digit, no hyphens)", () => {
  // The whole reason this regex exists: a sales record like 5141775 must
  // never count as an Order ID, because that would let it accidentally
  // collide with substrings of real order numbers.
  assert.equal(HELPDESK_ORDER_ID_PATTERN.test("5141775"), false);
});

test("HELPDESK_ORDER_ID_PATTERN rejects partial / wrong-shape inputs", () => {
  assert.equal(HELPDESK_ORDER_ID_PATTERN.test("03-14290"), false);
  assert.equal(HELPDESK_ORDER_ID_PATTERN.test("03-14290-90166-1"), false);
  assert.equal(HELPDESK_ORDER_ID_PATTERN.test(" 03-14290-90166"), false);
  assert.equal(HELPDESK_ORDER_ID_PATTERN.test("3-14290-90166"), false);
  assert.equal(HELPDESK_ORDER_ID_PATTERN.test("aa-bbbbb-ccccc"), false);
});

test("resolveHelpdeskSearch returns null for empty / whitespace-only input", () => {
  assert.equal(resolveHelpdeskSearch(null), null);
  assert.equal(resolveHelpdeskSearch(undefined), null);
  assert.equal(resolveHelpdeskSearch(""), null);
  assert.equal(resolveHelpdeskSearch("   "), null);
});

test("resolveHelpdeskSearch resolves a canonical Order ID to an EXACT ebayOrderNumber match", () => {
  const result = resolveHelpdeskSearch("03-14290-90166");
  assert.ok(result);
  assert.equal(result.kind, "order_id");
  assert.deepEqual(result.where, {
    ebayOrderNumber: { equals: "03-14290-90166", mode: "insensitive" },
  });
});

test("resolveHelpdeskSearch trims surrounding whitespace before classifying", () => {
  const result = resolveHelpdeskSearch("  03-14290-90166  ");
  assert.ok(result);
  assert.equal(result.kind, "order_id");
  assert.equal(result.query, "03-14290-90166");
});

test("resolveHelpdeskSearch treats a 7-digit sales record number as a USERNAME query", () => {
  // Regression guard: typing a sales record number must NOT fuzzy-match a
  // longer order number AND must NOT do anything sneaky like substring-
  // search ebayOrderNumber. It should fall through to the username branch
  // and return zero rows in practice.
  const result = resolveHelpdeskSearch("5141775");
  assert.ok(result);
  assert.equal(result.kind, "username");
  assert.deepEqual(result.where, {
    OR: [
      { buyerUserId: { contains: "5141775", mode: "insensitive" } },
      { buyerName: { contains: "5141775", mode: "insensitive" } },
    ],
  });
  // No ebayOrderNumber clause anywhere in the resolved where.
  assert.ok(!JSON.stringify(result.where).includes("ebayOrderNumber"));
});

test("resolveHelpdeskSearch treats normal strings as username substring search", () => {
  const result = resolveHelpdeskSearch("jlfra9");
  assert.ok(result);
  assert.equal(result.kind, "username");
  assert.deepEqual(result.where, {
    OR: [
      { buyerUserId: { contains: "jlfra9", mode: "insensitive" } },
      { buyerName: { contains: "jlfra9", mode: "insensitive" } },
    ],
  });
});

test("resolveHelpdeskSearch does NOT search subject / body / item id / item title", () => {
  const result = resolveHelpdeskSearch("Apple iPhone Case");
  assert.ok(result);
  const where = JSON.stringify(result.where);
  assert.ok(!where.includes("subject"));
  assert.ok(!where.includes("bodyText"));
  assert.ok(!where.includes("itemId"));
  assert.ok(!where.includes("itemTitle"));
  assert.ok(!where.includes("ebayOrderNumber"));
});
