import assert from "node:assert/strict";
import test from "node:test";
import {
  isReturnClosed,
  isReplacement,
  getReturnLifecycle,
  matchesStatusFilter,
  getSellerActionAvailability,
  getReturnActionModel,
  describeReturnStatus,
  extractReturnShipmentTracking,
  isActionExecutable,
  deriveSellerActionDue,
  normalizeTotalRefund,
  validateDeduction,
  validateRefundAmount,
  isSupportedCarrier,
  humanizeReturnState,
  normalizeReturnSummary,
  extractItemPresentation,
  parseEstimatedRefundLines,
  buildItemizedRefund,
  isDeductionAllowedForShippingService,
  labelForRefundFeeType,
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
  // A partial refund that was already issued is a refund stage, not "requested".
  assert.equal(
    getReturnLifecycle("LESS_THAN_A_FULL_REFUND_ISSUED"),
    "refund_pending",
  );
  assert.equal(getReturnLifecycle("FULL_REFUND_ISSUED"), "refund_pending");
});

test("describeReturnStatus: a refund already issued reads as issued, not action-needed", () => {
  const partial = describeReturnStatus({
    state: "LESS_THAN_A_FULL_REFUND_ISSUED",
    sellerActionDue: true, // must NOT bleed an "- action needed" suffix
  });
  assert.equal(partial.label, "Partial refund issued");
  assert.equal(partial.tone, "closed");
  assert.equal(describeReturnStatus({ state: "FULL_REFUND_ISSUED" }).label, "Refund issued");
});

// ─── Refund itemization (issue_refund payload) ───────────────────────────────

const SNAD_REFUND_BODY = {
  detail: {
    refundInfo: {
      estimatedRefundDetail: {
        itemizedRefundDetails: [
          {
            refundFeeType: "PURCHASE_PRICE",
            estimatedAmount: { value: 12.85, currency: "USD" },
            overwritableBySeller: false,
            amountEditable: false,
          },
          {
            refundFeeType: "ORIGINAL_SHIPPING",
            estimatedAmount: { value: 1.99, currency: "USD" },
            overwritableBySeller: false,
            amountEditable: false,
          },
        ],
      },
    },
  },
};

// Free-shipping return (seller free returns): NO original shipping line.
const FREE_SHIPPING_REFUND_BODY = {
  detail: {
    refundInfo: {
      estimatedRefundDetail: {
        itemizedRefundDetails: [
          {
            refundFeeType: "PURCHASE_PRICE",
            estimatedAmount: { value: 21.89, currency: "USD" },
            overwritableBySeller: false,
            amountEditable: false,
          },
        ],
      },
    },
  },
};

test("parseEstimatedRefundLines: editable flags only the item-price line", () => {
  // `editable` marks the line a deduction subtracts FROM (item price), not
  // whether a deduction is allowed at all. The shipping line is never editable.
  const lines = parseEstimatedRefundLines(SNAD_REFUND_BODY);
  assert.deepEqual(lines, [
    { refundFeeType: "PURCHASE_PRICE", estimated: 12.85, editable: true },
    { refundFeeType: "ORIGINAL_SHIPPING", estimated: 1.99, editable: false },
  ]);
  assert.deepEqual(parseEstimatedRefundLines(null), []);
  assert.deepEqual(parseEstimatedRefundLines({}), []);
});

test("parseEstimatedRefundLines: item price is always the editable line", () => {
  const lines = parseEstimatedRefundLines(FREE_SHIPPING_REFUND_BODY);
  assert.deepEqual(lines, [
    { refundFeeType: "PURCHASE_PRICE", estimated: 21.89, editable: true },
  ]);
});

test("isDeductionAllowedForShippingService: only the no-free-option code blocks", () => {
  // ShippingMethodStandard = the buyer had no free option and had to pay.
  assert.equal(isDeductionAllowedForShippingService("ShippingMethodStandard"), false);
  assert.equal(isDeductionAllowedForShippingService("shippingmethodstandard"), false);
  // Free used, or a free option existed but the buyer upgraded → deduction OK.
  assert.equal(isDeductionAllowedForShippingService("USPSParcel"), true);
  assert.equal(isDeductionAllowedForShippingService("USPSPriority"), true);
  assert.equal(isDeductionAllowedForShippingService("USPSPriorityMailExpress"), true);
  // Unknown → allow (never wrongly block; eBay is the final authority).
  assert.equal(isDeductionAllowedForShippingService(null), true);
  assert.equal(isDeductionAllowedForShippingService(undefined), true);
  assert.equal(isDeductionAllowedForShippingService(""), true);
});

test("buildItemizedRefund: full refund itemizes PURCHASE_PRICE + ORIGINAL_SHIPPING", () => {
  // The exact bug: a full $14.84 refund must split, not lump into PURCHASE_PRICE.
  const lines = parseEstimatedRefundLines(SNAD_REFUND_BODY);
  const out = buildItemizedRefund(lines, 14.84);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.total, 14.84);
    assert.deepEqual(out.lines, [
      { refundFeeType: "PURCHASE_PRICE", amount: 12.85 },
      { refundFeeType: "ORIGINAL_SHIPPING", amount: 1.99 },
    ]);
  }
});

test("buildItemizedRefund: a request over the estimate is clamped, never exceeds", () => {
  const lines = parseEstimatedRefundLines(SNAD_REFUND_BODY);
  const out = buildItemizedRefund(lines, 99);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.total, 14.84);
});

test("buildItemizedRefund: a deduction is rejected when not allowed (no free option)", () => {
  const lines = parseEstimatedRefundLines(SNAD_REFUND_BODY);
  const out = buildItemizedRefund(lines, 14.83, false); // $0.01 deduction, not allowed
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error, /full refund|no free-shipping option/i);
});

test("buildItemizedRefund: a full refund is always allowed even when deductions aren't", () => {
  const lines = parseEstimatedRefundLines(SNAD_REFUND_BODY);
  const out = buildItemizedRefund(lines, 14.84, false); // full refund, no deduction
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.total, 14.84);
});

test("buildItemizedRefund: an allowed deduction comes off the item price, shipping intact", () => {
  // Return has original shipping AND a deduction is allowed (free option existed,
  // buyer upgraded): the deduction subtracts from item price only.
  const lines = parseEstimatedRefundLines(SNAD_REFUND_BODY); // 12.85 item + 1.99 ship
  const out = buildItemizedRefund(lines, 13.84, true); // $1 deduction
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.total, 13.84);
    assert.deepEqual(out.lines, [
      { refundFeeType: "PURCHASE_PRICE", amount: 11.85 },
      { refundFeeType: "ORIGINAL_SHIPPING", amount: 1.99 },
    ]);
  }
});

test("buildItemizedRefund: deduction comes off the item price on free-shipping returns", () => {
  const lines = parseEstimatedRefundLines(FREE_SHIPPING_REFUND_BODY); // $21.89, free shipping
  const out = buildItemizedRefund(lines, 18.89, true); // $3 deduction off the item price
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.total, 18.89);
    assert.deepEqual(out.lines, [{ refundFeeType: "PURCHASE_PRICE", amount: 18.89 }]);
  }
});

test("buildItemizedRefund: empty estimate falls back (caller uses single line)", () => {
  const out = buildItemizedRefund([], 10);
  assert.equal(out.ok, false);
});

test("labelForRefundFeeType: buyer-friendly fee labels", () => {
  assert.equal(labelForRefundFeeType("PURCHASE_PRICE"), "Item price");
  assert.equal(labelForRefundFeeType("ORIGINAL_SHIPPING"), "Original shipping");
  assert.equal(labelForRefundFeeType("RESTOCKING_FEE"), "Restocking fee");
  assert.equal(labelForRefundFeeType("SOMETHING_ELSE"), "Something Else");
});

test("deriveSellerActionDue: a refund already issued is NOT a seller to-do", () => {
  // eBay still returns an escalation respondByDate after a partial refund, but
  // there's nothing for the seller to do — must resolve to false.
  assert.equal(
    deriveSellerActionDue({
      sellerAvailableOptions: opts("OTHER"),
      sellerResponseDueAt: new Date("2026-06-23T06:59:59.000Z"),
      state: "LESS_THAN_A_FULL_REFUND_ISSUED",
    }),
    false,
  );
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

// ─── eBay-parity action model ────────────────────────────────────────────────

test("getReturnActionModel: RETURN_REQUESTED shows Accept / Decline / Offer refund", () => {
  const groups = getReturnActionModel({
    state: "RETURN_REQUESTED",
    sellerOptions: opts(
      "SELLER_APPROVE_REQUEST",
      "SELLER_DECLINE_REQUEST",
      "SELLER_ISSUE_REFUND",
      "SELLER_OFFER_PARTIAL_REFUND",
    ),
  });
  const ids = groups.map((g) => g.id);
  assert.deepEqual(ids, ["accept", "decline", "refund"]);
  const refund = groups.find((g) => g.id === "refund")!;
  assert.equal(refund.label, "Offer a full or partial refund");
  assert.deepEqual(
    refund.choices.map((c) => c.actionKey),
    ["ISSUE_REFUND", "OFFER_PARTIAL_REFUND"],
  );
  // No label or track actions while the request awaits a verdict.
  assert.equal(ids.includes("label"), false);
  assert.equal(ids.includes("track"), false);
});

test("getReturnActionModel: label stage shows Provide eBay label / Upload a label / Confirm sent", () => {
  const groups = getReturnActionModel({
    state: "RETURN_LABEL_PENDING",
    sellerOptions: opts("SELLER_PROVIDE_LABEL", "SELLER_ISSUE_REFUND"),
  });
  const label = groups.find((g) => g.id === "label");
  assert.ok(label, "expected a label group");
  assert.deepEqual(
    label!.choices.map((c) => c.actionKey),
    ["PROVIDE_EBAY_LABEL", "UPLOAD_LABEL", "CONFIRM_LABEL_SENT"],
  );
});

test("getReturnActionModel: in-transit shows Mark received + Track + Start refund, no label", () => {
  const groups = getReturnActionModel({
    state: "ITEM_SHIPPED",
    sellerOptions: opts(
      "SELLER_MARK_AS_RECEIVED",
      "SELLER_ISSUE_REFUND",
      "SELLER_OFFER_PARTIAL_REFUND",
      // Even if eBay still lists a label option, we hide it once shipped.
      "SELLER_PROVIDE_LABEL",
    ),
  });
  const ids = groups.map((g) => g.id);
  assert.equal(ids.includes("mark_received"), true);
  assert.equal(ids.includes("track"), true);
  assert.equal(ids.includes("label"), false);
  const refund = groups.find((g) => g.id === "refund")!;
  assert.equal(refund.label, "Start refund");
});

test("getReturnActionModel: closed returns expose no actions", () => {
  assert.deepEqual(
    getReturnActionModel({ state: "CLOSED", sellerOptions: opts("SELLER_ISSUE_REFUND") }),
    [],
  );
});

// ─── Status descriptors ──────────────────────────────────────────────────────

test("describeReturnStatus: label-provided stage reads clearly", () => {
  const d = describeReturnStatus({ state: "ITEM_READY_TO_SHIP" });
  assert.equal(d.label, "Label provided - awaiting returned item");
  assert.equal(d.tone, "progress");
});

test("describeReturnStatus: shipped/delivered/closed tones", () => {
  assert.equal(describeReturnStatus({ state: "ITEM_SHIPPED" }).tone, "shipped");
  assert.equal(describeReturnStatus({ state: "ITEM_DELIVERED" }).tone, "delivered");
  assert.equal(describeReturnStatus({ state: "CLOSED" }).tone, "closed");
});

// ─── Return shipment tracking extraction ─────────────────────────────────────

test("extractReturnShipmentTracking pulls carrier + tracking from Get Return detail", () => {
  const t = extractReturnShipmentTracking({
    detail: {
      returnShipmentInfo: {
        shipmentTracking: {
          carrierUsed: "USPS",
          carrierName: "USPS",
          trackingNumber: "9302086041594397619130",
          deliveryStatus: "IN_TRANSIT",
        },
      },
    },
  } as unknown as Parameters<typeof extractReturnShipmentTracking>[0]);
  assert.equal(t.carrierUsed, "USPS");
  assert.equal(t.trackingNumber, "9302086041594397619130");
  assert.equal(t.deliveryStatus, "IN_TRANSIT");
});

test("extractReturnShipmentTracking is null-safe on an empty payload", () => {
  const t = extractReturnShipmentTracking({});
  assert.equal(t.trackingNumber, null);
  assert.equal(t.carrierUsed, null);
});
