/**
 * Pure helpers for the eBay Return Cases feature.
 *
 * Everything in this file is framework-free and side-effect-free so it can be
 * unit-tested with `npm test` (tsx --test). It owns:
 *
 *   - Normalizing an eBay ReturnSummaryType (Search Returns) / ReturnType
 *     (Get Return) into the flat shape we persist + render.
 *   - Mapping eBay's ReturnStateEnum into the eBay-equivalent UI status buckets
 *     used by the list filter (screenshot2 labels).
 *   - Deciding which seller actions are currently available from
 *     sellerAvailableOptions (ActivityOptionEnum), so the UI can enable/disable
 *     and the safety gate can re-validate.
 *   - Validating refund amounts and free-return deductions (max 50%, required
 *     reason/comment, no over-refund).
 *
 * Source of truth for the enums/payloads is the captured official docs in
 * `reorg/docs/integrations/ebay-post-order-returns/`.
 */

// ─── Raw eBay shapes (subset we read) ────────────────────────────────────────

export interface EbayAmount {
  value?: number | string;
  currency?: string;
  convertedFromValue?: number | string;
  convertedFromCurrency?: string;
}

export interface EbayDateTime {
  value?: string;
  formattedValue?: string;
}

export interface EbayAvailableOption {
  actionType?: string;
  actionURL?: string;
}

export interface EbayTotalRefund {
  actualRefundAmount?: EbayAmount;
  estimatedRefundAmount?: EbayAmount;
}

export interface EbayReturnSummary {
  returnId?: string;
  orderId?: string;
  state?: string;
  status?: string;
  currentType?: string;
  buyerLoginName?: string;
  sellerLoginName?: string;
  creationInfo?: {
    comments?: { content?: string };
    creationDate?: EbayDateTime;
    item?: { itemId?: string; returnQuantity?: number; transactionId?: string };
    reason?: string;
    reasonType?: string;
    type?: string;
  };
  escalationInfo?: { caseId?: string };
  sellerAvailableOptions?: EbayAvailableOption[];
  buyerAvailableOptions?: EbayAvailableOption[];
  sellerResponseDue?: { activityDue?: string; respondByDate?: EbayDateTime };
  buyerResponseDue?: { activityDue?: string; respondByDate?: EbayDateTime };
  sellerTotalRefund?: EbayTotalRefund;
  buyerTotalRefund?: EbayTotalRefund;
  timeoutDate?: EbayDateTime;
  closedDate?: EbayDateTime;
  /**
   * Present only on the Get Return *detail* payload (ReturnDetailType). The
   * search summary does NOT include item title/image — those live here. The
   * detail also carries closeInfo.returnCloseDate, which we map to closedDate.
   */
  itemDetail?: {
    itemId?: string;
    itemTitle?: string;
    itemPicUrl?: string;
    sku?: string;
    returnQuantity?: number;
    transactionId?: string;
  };
  closeInfo?: { returnCloseDate?: EbayDateTime };
  /** Get Return wraps everything under `detail` (FULL). {@link normalizeReturnSummary} unwraps it. */
  detail?: EbayReturnSummary;
  /** Get Return with fieldgroups=SUMMARY wraps the return under `summary`. */
  summary?: EbayReturnSummary;
}

/** Item title/image/sku, only available from the Get Return *detail* payload. */
export interface ItemPresentation {
  itemTitle: string | null;
  imageUrl: string | null;
  sku: string | null;
}

/**
 * Pull the listing title / primary image / sku out of an eBay return payload.
 * Handles both the `{ detail: { itemDetail } }` wrapper from Get Return and an
 * already-unwrapped detail object. Search summaries return all-null.
 */
export function extractItemPresentation(
  raw: EbayReturnSummary | null | undefined,
): ItemPresentation {
  const node = raw?.detail ?? raw ?? {};
  const item = node.itemDetail;
  const pic = item?.itemPicUrl ? String(item.itemPicUrl).trim() : "";
  return {
    itemTitle: item?.itemTitle ? String(item.itemTitle) : null,
    imageUrl: pic ? pic : null,
    sku: item?.sku ? String(item.sku) : null,
  };
}

// ─── UI status buckets ───────────────────────────────────────────────────────

/** Stable keys for the list status filter (mirrors eBay's Manage Returns dropdown). */
export type ReturnStatusFilterKey =
  | "needs_attention"
  | "open_all"
  | "open_replacements"
  | "open_returns"
  | "in_progress"
  | "shipped"
  | "delivered"
  | "closed";

export interface ReturnStatusFilterDef {
  key: ReturnStatusFilterKey;
  /** eBay-equivalent label from screenshot2. */
  label: string;
  /**
   * Closest eBay ReturnCountFilterEnum value, for documentation/parity. The
   * list itself filters local rows via {@link matchesStatusFilter}; we don't
   * round-trip to eBay per filter (hybrid freshness — list = local DB).
   */
  ebayCountFilter: string;
}

export const RETURN_STATUS_FILTERS: ReturnStatusFilterDef[] = [
  { key: "needs_attention", label: "Open returns - needs attention", ebayCountFilter: "SELLER_ACTION_DUE" },
  { key: "open_all", label: "Open returns/replacements", ebayCountFilter: "ALL_OPEN" },
  { key: "open_replacements", label: "Open replacements", ebayCountFilter: "ALL_OPEN_REPLACEMENT" },
  { key: "open_returns", label: "Open returns", ebayCountFilter: "ALL_OPEN_RETURN" },
  { key: "in_progress", label: "Returns in progress", ebayCountFilter: "RETURN_STARTED" },
  { key: "shipped", label: "Returns shipped", ebayCountFilter: "ITEM_SHIPPED" },
  { key: "delivered", label: "Returns delivered", ebayCountFilter: "ITEM_DELIVERED" },
  { key: "closed", label: "Closed returns/replacements", ebayCountFilter: "CLOSED" },
];

/** Coarse lifecycle bucket used for the progress line + list grouping. */
export type ReturnLifecycle =
  | "requested"
  | "in_transit"
  | "delivered"
  | "refund_pending"
  | "closed";

const CLOSED_STATES = new Set([
  "CLOSED",
  "ITEM_KEPT",
  "REPLACEMENT_CLOSED",
  "RETURN_REQUEST_TIMEOUT",
  "REPLACEMENT_REQUEST_TIMEOUT",
]);

const SHIPPED_STATES = new Set(["ITEM_SHIPPED", "REPLACEMENT_SHIPPED"]);
const DELIVERED_STATES = new Set(["ITEM_DELIVERED", "REPLACEMENT_DELIVERED"]);

const REFUND_PENDING_STATES = new Set([
  "REFUND_INITIATED",
  "REFUND_FAILED",
  "REFUND_AS_PAYOUT_INITIATED",
  "REFUND_SENT_PENDING_CONFIRMATION",
  "PARTIAL_REFUND_INITIATED",
  "PARTIAL_REFUND_REQUESTED",
  "PARTIAL_REFUND_FAILED",
  "PARTIAL_REFUND_AS_PAYOUT_INITIATED",
  "PARTIAL_REFUND_NON_PAYPAL_INITIATED",
  "PAYOUT_INITIATED",
  "AUTO_REFUND_INITIATED",
]);

const REFUNDED_OR_CLOSED_SUFFIX = /(REFUNDED|CLOSED)$/;

export function normalizeState(state: string | null | undefined): string {
  return (state ?? "").trim().toUpperCase();
}

export function isReturnClosed(state: string | null | undefined): boolean {
  const s = normalizeState(state);
  if (!s) return false;
  if (CLOSED_STATES.has(s)) return true;
  // PARTIAL_REFUNDED / AUTO_REFUNDED / REFUNDED terminal states.
  if (REFUNDED_OR_CLOSED_SUFFIX.test(s) && !REFUND_PENDING_STATES.has(s)) return true;
  return false;
}

export function isReplacement(state: string | null | undefined, currentType?: string | null): boolean {
  const s = normalizeState(state);
  if (s.startsWith("REPLACEMENT")) return true;
  return (currentType ?? "").trim().toUpperCase().includes("REPLACEMENT");
}

export function getReturnLifecycle(state: string | null | undefined): ReturnLifecycle {
  const s = normalizeState(state);
  if (isReturnClosed(s)) return "closed";
  if (REFUND_PENDING_STATES.has(s)) return "refund_pending";
  if (DELIVERED_STATES.has(s)) return "delivered";
  if (SHIPPED_STATES.has(s)) return "in_transit";
  return "requested";
}

/**
 * Does this return match the given status-filter bucket? `sellerActionDue` is
 * passed in because "needs attention" is an overlay on top of the open states,
 * not a distinct eBay state.
 */
export function matchesStatusFilter(
  filter: ReturnStatusFilterKey,
  args: { state: string | null | undefined; currentType?: string | null; sellerActionDue: boolean },
): boolean {
  const open = !isReturnClosed(args.state);
  const replacement = isReplacement(args.state, args.currentType);
  const lifecycle = getReturnLifecycle(args.state);
  switch (filter) {
    case "needs_attention":
      return open && args.sellerActionDue;
    case "open_all":
      return open;
    case "open_replacements":
      return open && replacement;
    case "open_returns":
      return open && !replacement;
    case "in_progress":
      return open && (lifecycle === "requested" || lifecycle === "refund_pending");
    case "shipped":
      return open && lifecycle === "in_transit";
    case "delivered":
      return open && lifecycle === "delivered";
    case "closed":
      return !open;
    default:
      return true;
  }
}

/** Short human label for a raw eBay state, for badges. */
export function humanizeReturnState(state: string | null | undefined): string {
  const s = normalizeState(state);
  if (!s) return "Unknown";
  return s
    .toLowerCase()
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ─── Seller action availability ──────────────────────────────────────────────

/** Our internal live-write action keys. */
export type ReturnActionKey =
  | "APPROVE_RETURN"
  | "OFFER_PARTIAL_REFUND"
  | "UPLOAD_LABEL"
  | "CONFIRM_LABEL_SENT"
  | "PROVIDE_EBAY_LABEL"
  | "MARK_AS_RECEIVED"
  | "ISSUE_REFUND";

/**
 * eBay sellerAvailableOptions[].actionType (ActivityOptionEnum) values that, if
 * present, indicate the corresponding internal action is currently available.
 */
const ACTION_OPTION_MAP: Record<ReturnActionKey, string[]> = {
  APPROVE_RETURN: ["SELLER_APPROVE_REQUEST"],
  OFFER_PARTIAL_REFUND: ["SELLER_OFFER_PARTIAL_REFUND"],
  // eBay exposes a single SELLER_PROVIDE_LABEL option that fans out into the
  // three label choices seen in Seller Hub (provide an eBay label / upload a
  // label / confirm you sent one). All three map to that one option; the
  // distinction is the labelAction we send to add_shipping_label.
  PROVIDE_EBAY_LABEL: ["SELLER_PROVIDE_LABEL", "SELLER_PRINT_SHIPPING_LABEL"],
  UPLOAD_LABEL: ["SELLER_PROVIDE_LABEL"],
  CONFIRM_LABEL_SENT: ["SELLER_PROVIDE_LABEL", "SELLER_PROVIDE_TRACKING_INFO", "SELLER_UPDATE_TRACKING"],
  MARK_AS_RECEIVED: ["SELLER_MARK_AS_RECEIVED"],
  ISSUE_REFUND: ["SELLER_ISSUE_REFUND"],
};

/**
 * Actions we deliberately DO NOT execute as a live API write even when eBay
 * offers them, because the write semantics are paid/irreversible and there is
 * no eBay sandbox to validate against. PROVIDE_EBAY_LABEL purchases a paid eBay
 * return label; rather than fire an ambiguous paid call we deep-link the user
 * to eBay's label-purchase flow (handled in the UI). Keeping it here means the
 * commit endpoint will also refuse it as defense-in-depth.
 */
export const POLICY_BLOCKED_ACTIONS: ReturnActionKey[] = ["PROVIDE_EBAY_LABEL"];

export function extractActionTypes(
  options: EbayAvailableOption[] | null | undefined,
): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => (o?.actionType ? String(o.actionType).trim().toUpperCase() : ""))
    .filter(Boolean);
}

export interface ActionAvailability {
  key: ReturnActionKey;
  /** eBay currently offers an option that maps to this action. */
  availableOnEbay: boolean;
  /** We refuse to execute it live by policy (ambiguous/paid). */
  policyBlocked: boolean;
}

export function getSellerActionAvailability(
  options: EbayAvailableOption[] | null | undefined,
): ActionAvailability[] {
  const present = new Set(extractActionTypes(options));
  return (Object.keys(ACTION_OPTION_MAP) as ReturnActionKey[]).map((key) => ({
    key,
    availableOnEbay: ACTION_OPTION_MAP[key].some((opt) => present.has(opt)),
    policyBlocked: POLICY_BLOCKED_ACTIONS.includes(key),
  }));
}

/** Is a specific action currently executable (offered by eBay AND not policy-blocked)? */
export function isActionExecutable(
  action: ReturnActionKey,
  options: EbayAvailableOption[] | null | undefined,
): boolean {
  if (POLICY_BLOCKED_ACTIONS.includes(action)) return false;
  const present = new Set(extractActionTypes(options));
  return ACTION_OPTION_MAP[action].some((opt) => present.has(opt));
}

/** True when eBay currently has a seller action due (drives needs-attention badge). */
export function deriveSellerActionDue(args: {
  sellerAvailableOptions?: EbayAvailableOption[] | null;
  sellerResponseDueAt?: Date | null;
  state?: string | null;
}): boolean {
  if (isReturnClosed(args.state)) return false;
  const actions = extractActionTypes(args.sellerAvailableOptions);
  // Any actionable seller option (approve, refund, provide label, mark received)
  // means the ball is in the seller's court.
  const actionable = actions.some((a) =>
    [
      "SELLER_APPROVE_REQUEST",
      "SELLER_DECLINE_REQUEST",
      "SELLER_ISSUE_REFUND",
      "SELLER_OFFER_PARTIAL_REFUND",
      "SELLER_PROVIDE_LABEL",
      "SELLER_PRINT_SHIPPING_LABEL",
      "SELLER_MARK_AS_RECEIVED",
      "SELLER_PROVIDE_RMA",
    ].includes(a),
  );
  if (actionable) return true;
  if (args.sellerResponseDueAt) return true;
  return false;
}

// ─── Amount helpers ──────────────────────────────────────────────────────────

export function parseAmount(amount: EbayAmount | null | undefined): number | null {
  if (!amount) return null;
  const raw = amount.value;
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
  return Number.isFinite(n) ? n : null;
}

export interface NormalizedRefund {
  value: number | null;
  currency: string | null;
  /** true if eBay reports an actual (issued) amount, false if only an estimate. */
  isActual: boolean;
}

export function normalizeTotalRefund(
  refund: EbayTotalRefund | null | undefined,
): NormalizedRefund {
  if (!refund) return { value: null, currency: null, isActual: false };
  const actual = parseAmount(refund.actualRefundAmount);
  if (actual != null) {
    return {
      value: actual,
      currency: refund.actualRefundAmount?.currency ?? null,
      isActual: true,
    };
  }
  const estimated = parseAmount(refund.estimatedRefundAmount);
  return {
    value: estimated,
    currency: refund.estimatedRefundAmount?.currency ?? null,
    isActual: false,
  };
}

// ─── Refund / deduction validation ───────────────────────────────────────────

export const MAX_DEDUCTION_PERCENT = 50;

export type DeductionType = "none" | "percent" | "amount";

export interface DeductionInput {
  /** The full/original refund amount eBay would issue with no deduction. */
  originalAmount: number;
  deductionType: DeductionType;
  /** Percent (0-50) when type=percent, or dollar amount when type=amount. */
  deductionValue: number;
  reason?: string | null;
  comment?: string | null;
}

export interface DeductionResult {
  ok: boolean;
  /** Final amount the buyer receives after deduction. */
  finalRefund: number;
  /** The dollar value being withheld. */
  deductionAmount: number;
  error?: string;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Validate a free-return deduction. Enforces: max 50%, no negative, no
 * over-refund, required reason + comment when a deduction is applied.
 */
export function validateDeduction(input: DeductionInput): DeductionResult {
  const original = round2(input.originalAmount);
  if (!Number.isFinite(original) || original <= 0) {
    return { ok: false, finalRefund: 0, deductionAmount: 0, error: "Original refund amount is invalid." };
  }

  if (input.deductionType === "none" || !input.deductionValue) {
    return { ok: true, finalRefund: original, deductionAmount: 0 };
  }

  let deductionAmount: number;
  if (input.deductionType === "percent") {
    if (input.deductionValue < 0) {
      return { ok: false, finalRefund: original, deductionAmount: 0, error: "Deduction percent cannot be negative." };
    }
    if (input.deductionValue > MAX_DEDUCTION_PERCENT) {
      return {
        ok: false,
        finalRefund: original,
        deductionAmount: 0,
        error: `Deduction cannot exceed ${MAX_DEDUCTION_PERCENT}%.`,
      };
    }
    deductionAmount = round2((original * input.deductionValue) / 100);
  } else {
    if (input.deductionValue < 0) {
      return { ok: false, finalRefund: original, deductionAmount: 0, error: "Deduction amount cannot be negative." };
    }
    deductionAmount = round2(input.deductionValue);
    const maxDeduction = round2((original * MAX_DEDUCTION_PERCENT) / 100);
    if (deductionAmount > maxDeduction) {
      return {
        ok: false,
        finalRefund: original,
        deductionAmount: 0,
        error: `Deduction cannot exceed ${MAX_DEDUCTION_PERCENT}% ($${maxDeduction.toFixed(2)}).`,
      };
    }
  }

  if (deductionAmount > 0) {
    if (!input.reason || !input.reason.trim()) {
      return { ok: false, finalRefund: original, deductionAmount, error: "A deduction reason is required." };
    }
    if (!input.comment || !input.comment.trim()) {
      return { ok: false, finalRefund: original, deductionAmount, error: "A deduction comment is required." };
    }
  }

  const finalRefund = round2(original - deductionAmount);
  if (finalRefund < 0) {
    return { ok: false, finalRefund: 0, deductionAmount, error: "Deduction exceeds the refund amount." };
  }
  return { ok: true, finalRefund, deductionAmount };
}

/** Validate an absolute refund amount against the eBay-estimated maximum. */
export function validateRefundAmount(args: {
  amount: number;
  maxAmount: number;
}): { ok: boolean; error?: string } {
  if (!Number.isFinite(args.amount) || args.amount <= 0) {
    return { ok: false, error: "Refund amount must be greater than zero." };
  }
  if (Number.isFinite(args.maxAmount) && args.maxAmount > 0 && round2(args.amount) > round2(args.maxAmount)) {
    return { ok: false, error: `Refund cannot exceed the order total ($${args.maxAmount.toFixed(2)}).` };
  }
  return { ok: true };
}

// ─── eBay carrier enum (subset supported in our upload-label UI) ─────────────

export interface CarrierOption {
  /** ShippingCarrierEnum value sent to eBay. */
  value: string;
  label: string;
}

export const RETURN_CARRIERS: CarrierOption[] = [
  { value: "USPS", label: "USPS" },
  { value: "UPS", label: "UPS" },
  { value: "FEDEX", label: "FedEx" },
  { value: "DHL", label: "DHL" },
  { value: "OTHER", label: "Other" },
];

export function isSupportedCarrier(value: string): boolean {
  return RETURN_CARRIERS.some((c) => c.value === value.trim().toUpperCase());
}

// ─── Date helper ─────────────────────────────────────────────────────────────

export function parseEbayDate(d: EbayDateTime | null | undefined): Date | null {
  const v = d?.value;
  if (!v) return null;
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ─── Summary → persisted shape ───────────────────────────────────────────────

/**
 * Flat projection of an eBay return that maps 1:1 onto the HelpdeskReturnCase
 * columns. Produced from either a Search Returns summary or a Get Return detail
 * (they share the same field names for the parts we read).
 */
export interface NormalizedReturnFields {
  returnId: string | null;
  ebayOrderNumber: string | null;
  ebayItemId: string | null;
  transactionId: string | null;
  returnQuantity: number | null;
  itemTitle: string | null;
  imageUrl: string | null;
  sku: string | null;
  buyerUserId: string | null;
  sellerUserId: string | null;
  returnState: string | null;
  returnStatus: string | null;
  currentType: string | null;
  sellerActionDue: boolean;
  escalated: boolean;
  caseId: string | null;
  reason: string | null;
  reasonType: string | null;
  buyerComments: string | null;
  sellerRefundValue: number | null;
  sellerRefundCurrency: string | null;
  buyerRefundValue: number | null;
  buyerRefundCurrency: string | null;
  refundIsActual: boolean;
  sellerResponseDueAt: Date | null;
  buyerResponseDueAt: Date | null;
  timeoutDate: Date | null;
  openedAt: Date | null;
  closedAt: Date | null;
  sellerAvailableOptions: EbayAvailableOption[];
  buyerAvailableOptions: EbayAvailableOption[];
}

function toIntOrNull(n: number | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Normalize a raw eBay return (summary or detail) into the flat persisted
 * shape. Pure + defensive: any missing field becomes null/false rather than
 * throwing, so a partial eBay payload never breaks a sync tick.
 */
export function normalizeReturnSummary(
  raw: EbayReturnSummary | null | undefined,
): NormalizedReturnFields {
  // Get Return wraps the return under either `summary` (fieldgroups=SUMMARY —
  // the ONLY place sellerAvailableOptions / state / response-due live) or
  // `detail` (fieldgroups=FULL). Search Returns returns the fields at the top
  // level. Prefer summary, then detail, then the flat search payload so a
  // detail refresh reads real values instead of wiping the seller's options.
  const root = (raw ?? {}) as EbayReturnSummary;
  const r = root.summary ?? root.detail ?? root;
  const sellerOptions = Array.isArray(r.sellerAvailableOptions) ? r.sellerAvailableOptions : [];
  const buyerOptions = Array.isArray(r.buyerAvailableOptions) ? r.buyerAvailableOptions : [];
  const sellerResponseDueAt = parseEbayDate(r.sellerResponseDue?.respondByDate);
  const sellerRefund = normalizeTotalRefund(r.sellerTotalRefund);
  const buyerRefund = normalizeTotalRefund(r.buyerTotalRefund);
  const state = r.state ? String(r.state) : null;

  const item = r.creationInfo?.item;
  const itemDetail = r.itemDetail ?? root.detail?.itemDetail;
  const presentation = extractItemPresentation(root);

  return {
    returnId: r.returnId ? String(r.returnId) : null,
    ebayOrderNumber: r.orderId ? String(r.orderId) : null,
    ebayItemId: item?.itemId
      ? String(item.itemId)
      : itemDetail?.itemId
        ? String(itemDetail.itemId)
        : null,
    transactionId: item?.transactionId
      ? String(item.transactionId)
      : itemDetail?.transactionId
        ? String(itemDetail.transactionId)
        : null,
    returnQuantity: toIntOrNull(item?.returnQuantity ?? itemDetail?.returnQuantity),
    itemTitle: presentation.itemTitle,
    imageUrl: presentation.imageUrl,
    sku: presentation.sku,
    buyerUserId: r.buyerLoginName ? String(r.buyerLoginName) : null,
    sellerUserId: r.sellerLoginName ? String(r.sellerLoginName) : null,
    returnState: state,
    returnStatus: r.status ? String(r.status) : null,
    currentType: r.currentType ? String(r.currentType) : null,
    sellerActionDue: deriveSellerActionDue({
      sellerAvailableOptions: sellerOptions,
      sellerResponseDueAt,
      state,
    }),
    escalated: !!r.escalationInfo?.caseId,
    caseId: r.escalationInfo?.caseId ? String(r.escalationInfo.caseId) : null,
    reason: r.creationInfo?.reason ? String(r.creationInfo.reason) : null,
    reasonType: r.creationInfo?.reasonType ? String(r.creationInfo.reasonType) : null,
    buyerComments: r.creationInfo?.comments?.content
      ? String(r.creationInfo.comments.content)
      : null,
    sellerRefundValue: sellerRefund.value,
    sellerRefundCurrency: sellerRefund.currency,
    buyerRefundValue: buyerRefund.value,
    buyerRefundCurrency: buyerRefund.currency,
    refundIsActual: sellerRefund.isActual || buyerRefund.isActual,
    sellerResponseDueAt,
    buyerResponseDueAt: parseEbayDate(r.buyerResponseDue?.respondByDate),
    timeoutDate: parseEbayDate(r.timeoutDate),
    openedAt: parseEbayDate(r.creationInfo?.creationDate),
    closedAt:
      parseEbayDate(r.closedDate) ??
      parseEbayDate(r.closeInfo?.returnCloseDate) ??
      parseEbayDate(root.detail?.closeInfo?.returnCloseDate),
    sellerAvailableOptions: sellerOptions,
    buyerAvailableOptions: buyerOptions,
  };
}
