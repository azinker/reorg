import assert from "node:assert/strict";
import test from "node:test";
import {
  isReturnClosed,
  isReplacement,
  getReturnLifecycle,
  matchesStatusFilter,
  getSellerActionAvailability,
  isActionExecutable,
  deriveSellerActionDue,
  normalizeTotalRefund,
  validateDeduction,
  validateRefundAmount,
  isSupportedCarrier,
  humanizeReturnState,
  normalizeReturnSummary,
  extractItemPresentation,
  type EbayAvailableOption,
} from "@/lib/helpdesk/returns";

// ─── State classification ────────────────────────────────────────────────────

test("isReturnClosed: terminal states are closed", () => {
  assert.equal(isReturnClosed("CLOSED"), true);
  assert.equal(isReturnClosed("ITEM_KEPT"), true);
  assert.equal(isReturnClosed("PARTIAL_REFUNDED"), true);
  assert.equal(isReturnClosed("REPLACEMENT_CLOSED"), true);
});

test("isReturnClosed: in-flight refund states are NOT closed", () => {
  assert.equal(isReturnClosed("REFUND_INITIATED"), false);
  assert.equal(isReturnClosed("PARTIAL_REFUND_INITIATED"), false);
  assert.equal(isReturnClosed("RETURN_REQUESTED"), false);
  assert.equal(isReturnClosed("ITEM_DELIVERED"), false);
});

test("isReplacement: detects replacement states and currentType", () => {
  assert.equal(isReplacement("REPLACEMENT_SHIPPED"), true);
  assert.equal(isReplacement("ITEM_SHIPPED", "REPLACEMENT"), true);
  assert.equal(isReplacement("ITEM_SHIPPED", "RETURN"), false);
});

test("getReturnLifecycle maps states to coarse buckets", () => {
  assert.equal(getReturnLifecycle("RETURN_REQUESTED"), "requested");
  assert.equal(getReturnLifecycle("ITEM_SHIPPED"), "in_transit");
  assert.equal(getReturnLifecycle("ITEM_DELIVERED"), "delivered");
  assert.equal(getReturnLifecycle("REFUND_INITIATED"), "refund_pending");
  assert.equal(getReturnLifecycle("CLOSED"), "closed");
});

// ─── Status filters (eBay dropdown parity) ───────────────────────────────────

test("matchesStatusFilter: open_all matches any non-closed return", () => {
  assert.equal(
    matchesStatusFilter("open_all", { state: "ITEM_SHIPPED", sellerActionDue: false }),
    true,
  );
  assert.equal(
    matchesStatusFilter("open_all", { state: "CLOSED", sellerActionDue: false }),
    false,
  );
});

test("matchesStatusFilter: needs_attention requires open AND seller action due", () => {
  assert.equal(
    matchesStatusFilter("needs_attention", { state: "RETURN_REQUESTED", sellerActionDue: true }),
    true,
  );
  assert.equal(
    matchesStatusFilter("needs_attention", { state: "RETURN_REQUESTED", sellerActionDue: false }),
    false,
  );
  assert.equal(
    matchesStatusFilter("needs_attention", { state: "CLOSED", sellerActionDue: true }),
    false,
  );
});

test("matchesStatusFilter: returns vs replacements split", () => {
  assert.equal(
    matchesStatusFilter("open_replacements", { state: "REPLACEMENT_SHIPPED", sellerActionDue: false }),
    true,
  );
  assert.equal(
    matchesStatusFilter("open_returns", { state: "REPLACEMENT_SHIPPED", sellerActionDue: false }),
    false,
  );
  assert.equal(
    matchesStatusFilter("open_returns", { state: "ITEM_SHIPPED", sellerActionDue: false }),
    true,
  );
});

test("matchesStatusFilter: shipped/delivered/closed buckets", () => {
  assert.equal(matchesStatusFilter("shipped", { state: "ITEM_SHIPPED", sellerActionDue: false }), true);
  assert.equal(matchesStatusFilter("delivered", { state: "ITEM_DELIVERED", sellerActionDue: false }), true);
  assert.equal(matchesStatusFilter("closed", { state: "CLOSED", sellerActionDue: false }), true);
  assert.equal(matchesStatusFilter("shipped", { state: "ITEM_DELIVERED", sellerActionDue: false }), false);
});

// ─── Seller action availability ──────────────────────────────────────────────

const opts = (...types: string[]): EbayAvailableOption[] =>
  types.map((t) => ({ actionType: t }));

test("isActionExecutable: maps eBay options to internal actions", () => {
  assert.equal(isActionExecutable("MARK_AS_RECEIVED", opts("SELLER_MARK_AS_RECEIVED")), true);
  assert.equal(isActionExecutable("ISSUE_REFUND", opts("SELLER_ISSUE_REFUND")), true);
  assert.equal(isActionExecutable("APPROVE_RETURN", opts("SELLER_APPROVE_REQUEST")), true);
  assert.equal(isActionExecutable("MARK_AS_RECEIVED", opts("SELLER_ISSUE_REFUND")), false);
});

test("isActionExecutable: PROVIDE_EBAY_LABEL is executable when eBay offers it", () => {
  // PROVIDE_EBAY_LABEL is now wired: when eBay offers SELLER_PRINT_SHIPPING_LABEL
  // we let the seller buy a prepaid eBay label (eBay charges the seller). It is
  // no longer policy-blocked — it runs through the standard preview/commit gate.
  assert.equal(isActionExecutable("PROVIDE_EBAY_LABEL", opts("SELLER_PRINT_SHIPPING_LABEL")), true);
  const avail = getSellerActionAvailability(opts("SELLER_PRINT_SHIPPING_LABEL"));
  const ebayLabel = avail.find((a) => a.key === "PROVIDE_EBAY_LABEL");
  assert.equal(ebayLabel?.availableOnEbay, true);
  assert.equal(ebayLabel?.policyBlocked, false);
});

test("deriveSellerActionDue: true when an actionable seller option exists and not closed", () => {
  assert.equal(
    deriveSellerActionDue({ sellerAvailableOptions: opts("SELLER_APPROVE_REQUEST"), state: "RETURN_REQUESTED" }),
    true,
  );
  assert.equal(
    deriveSellerActionDue({ sellerAvailableOptions: opts("SELLER_APPROVE_REQUEST"), state: "CLOSED" }),
    false,
  );
  assert.equal(
    deriveSellerActionDue({ sellerAvailableOptions: opts("SELLER_SEND_MESSAGE"), state: "ITEM_SHIPPED" }),
    false,
  );
});

// ─── Refund normalization ────────────────────────────────────────────────────

test("normalizeTotalRefund prefers actual over estimated", () => {
  const out = normalizeTotalRefund({
    actualRefundAmount: { value: 12.5, currency: "USD" },
    estimatedRefundAmount: { value: 20, currency: "USD" },
  });
  assert.equal(out.value, 12.5);
  assert.equal(out.isActual, true);
});

test("normalizeTotalRefund falls back to estimated", () => {
  const out = normalizeTotalRefund({ estimatedRefundAmount: { value: 20, currency: "USD" } });
  assert.equal(out.value, 20);
  assert.equal(out.isActual, false);
});

// ─── Deduction validation ────────────────────────────────────────────────────

test("validateDeduction: no deduction returns full refund", () => {
  const out = validateDeduction({ originalAmount: 30, deductionType: "none", deductionValue: 0 });
  assert.equal(out.ok, true);
  assert.equal(out.finalRefund, 30);
  assert.equal(out.deductionAmount, 0);
});

test("validateDeduction: percent deduction computes final refund", () => {
  const out = validateDeduction({
    originalAmount: 30,
    deductionType: "percent",
    deductionValue: 20,
    reason: "Used item",
    comment: "Item shows wear",
  });
  assert.equal(out.ok, true);
  assert.equal(out.deductionAmount, 6);
  assert.equal(out.finalRefund, 24);
});

test("validateDeduction: rejects > 50%", () => {
  const out = validateDeduction({
    originalAmount: 30,
    deductionType: "percent",
    deductionValue: 60,
    reason: "x",
    comment: "y",
  });
  assert.equal(out.ok, false);
});

test("validateDeduction: amount deduction over 50% cap rejected", () => {
  const out = validateDeduction({
    originalAmount: 30,
    deductionType: "amount",
    deductionValue: 20, // > $15 (50%)
    reason: "x",
    comment: "y",
  });
  assert.equal(out.ok, false);
});

test("validateDeduction: requires reason and comment when deducting", () => {
  const noReason = validateDeduction({
    originalAmount: 30,
    deductionType: "percent",
    deductionValue: 10,
    reason: "",
    comment: "c",
  });
  assert.equal(noReason.ok, false);
  const noComment = validateDeduction({
    originalAmount: 30,
    deductionType: "percent",
    deductionValue: 10,
    reason: "r",
    comment: "",
  });
  assert.equal(noComment.ok, false);
});

// ─── Refund amount validation ────────────────────────────────────────────────

test("validateRefundAmount: zero/negative rejected, over-max rejected", () => {
  assert.equal(validateRefundAmount({ amount: 0, maxAmount: 30 }).ok, false);
  assert.equal(validateRefundAmount({ amount: -5, maxAmount: 30 }).ok, false);
  assert.equal(validateRefundAmount({ amount: 31, maxAmount: 30 }).ok, false);
  assert.equal(validateRefundAmount({ amount: 30, maxAmount: 30 }).ok, true);
});

// ─── Misc ────────────────────────────────────────────────────────────────────

test("isSupportedCarrier matches eBay enum subset", () => {
  assert.equal(isSupportedCarrier("USPS"), true);
  assert.equal(isSupportedCarrier("fedex"), true);
  assert.equal(isSupportedCarrier("CANADA_POST"), false);
});

test("humanizeReturnState renders a readable label", () => {
  assert.equal(humanizeReturnState("RETURN_REQUESTED"), "Return Requested");
  assert.equal(humanizeReturnState("ITEM_DELIVERED"), "Item Delivered");
});

// ─── normalizeReturnSummary ──────────────────────────────────────────────────

test("normalizeReturnSummary maps a typical eBay return summary", () => {
  const out = normalizeReturnSummary({
    returnId: "5012345678",
    orderId: "26-14643-94920",
    state: "RETURN_REQUESTED",
    status: "OPEN",
    currentType: "RETURN",
    buyerLoginName: "buyer123",
    sellerLoginName: "theperfectpart",
    creationInfo: {
      comments: { content: "Item arrived damaged" },
      creationDate: { value: "2026-06-01T12:00:00.000Z" },
      item: { itemId: "115500001", returnQuantity: 1, transactionId: "tx-99" },
      reason: "DEFECTIVE_ITEM",
      reasonType: "SNAD",
    },
    sellerAvailableOptions: [{ actionType: "SELLER_APPROVE_REQUEST" }],
    sellerResponseDue: { respondByDate: { value: "2026-06-06T12:00:00.000Z" } },
    sellerTotalRefund: { estimatedRefundAmount: { value: 20.99, currency: "USD" } },
  });
  assert.equal(out.returnId, "5012345678");
  assert.equal(out.ebayOrderNumber, "26-14643-94920");
  assert.equal(out.ebayItemId, "115500001");
  assert.equal(out.transactionId, "tx-99");
  assert.equal(out.returnQuantity, 1);
  assert.equal(out.buyerUserId, "buyer123");
  assert.equal(out.returnState, "RETURN_REQUESTED");
  assert.equal(out.sellerActionDue, true);
  assert.equal(out.buyerComments, "Item arrived damaged");
  assert.equal(out.sellerRefundValue, 20.99);
  assert.equal(out.sellerRefundCurrency, "USD");
  assert.equal(out.refundIsActual, false);
  assert.ok(out.openedAt instanceof Date);
  assert.ok(out.sellerResponseDueAt instanceof Date);
  assert.equal(out.closedAt, null);
});

test("extractItemPresentation: pulls title/image/sku from a Get Return detail", () => {
  const detailBody = {
    detail: {
      returnId: "5322177775",
      itemDetail: {
        itemId: "111222333",
        itemTitle: "OEM Brake Caliper Bracket Front Left",
        itemPicUrl: "https://i.ebayimg.com/images/g/abc/s-l500.jpg",
        sku: "BRK-001",
      },
    },
  };
  const p = extractItemPresentation(detailBody);
  assert.equal(p.itemTitle, "OEM Brake Caliper Bracket Front Left");
  assert.equal(p.imageUrl, "https://i.ebayimg.com/images/g/abc/s-l500.jpg");
  assert.equal(p.sku, "BRK-001");
});

test("extractItemPresentation: search summaries (no itemDetail) return all-null", () => {
  const p = extractItemPresentation({ returnId: "5", creationInfo: { item: { itemId: "9" } } });
  assert.equal(p.itemTitle, null);
  assert.equal(p.imageUrl, null);
  assert.equal(p.sku, null);
});

test("normalizeReturnSummary unwraps the Get Return detail wrapper", () => {
  const fields = normalizeReturnSummary({
    detail: {
      returnId: "5322177775",
      orderId: "26-99999-11111",
      state: "RETURN_APPROVED",
      itemDetail: {
        itemId: "111222333",
        itemTitle: "OEM Brake Caliper Bracket",
        itemPicUrl: "https://i.ebayimg.com/images/g/abc/s-l500.jpg",
        transactionId: "tx-1",
        returnQuantity: 2,
      },
    },
  });
  assert.equal(fields.returnId, "5322177775");
  assert.equal(fields.returnState, "RETURN_APPROVED");
  assert.equal(fields.ebayItemId, "111222333");
  assert.equal(fields.transactionId, "tx-1");
  assert.equal(fields.returnQuantity, 2);
  assert.equal(fields.itemTitle, "OEM Brake Caliper Bracket");
  assert.equal(fields.imageUrl, "https://i.ebayimg.com/images/g/abc/s-l500.jpg");
});

test("normalizeReturnSummary unwraps the Get Return SUMMARY wrapper with seller options", () => {
  // fieldgroups=SUMMARY returns the return under `summary` — the only container
  // that carries sellerAvailableOptions. The detail refresh must read these
  // instead of wiping them.
  const fields = normalizeReturnSummary({
    summary: {
      returnId: "5322195906",
      orderId: "06-14766-18901",
      state: "RETURN_REQUESTED",
      sellerAvailableOptions: [
        { actionType: "SELLER_PROVIDE_LABEL" },
        { actionType: "CONFIRM_LABEL_SENT" },
        { actionType: "SELLER_ISSUE_REFUND" },
      ],
      sellerResponseDue: { activityDue: "SELLER_PROVIDE_LABEL", respondByDate: { value: "2026-06-20T00:00:00.000Z" } },
    },
  });
  assert.equal(fields.returnId, "5322195906");
  assert.equal(fields.ebayOrderNumber, "06-14766-18901");
  assert.equal(fields.sellerActionDue, true);
  assert.equal(fields.sellerAvailableOptions.length, 3);
});

test("normalizeReturnSummary is defensive against an empty payload", () => {
  const out = normalizeReturnSummary({});
  assert.equal(out.returnId, null);
  assert.equal(out.sellerActionDue, false);
  assert.deepEqual(out.sellerAvailableOptions, []);
});

test("normalizeReturnSummary marks closed returns with no action due", () => {
  const out = normalizeReturnSummary({
    returnId: "5012345679",
    state: "CLOSED",
    closedDate: { value: "2026-06-05T12:00:00.000Z" },
    sellerAvailableOptions: [{ actionType: "SELLER_APPROVE_REQUEST" }],
  });
  assert.equal(out.sellerActionDue, false);
  assert.ok(out.closedAt instanceof Date);
});
