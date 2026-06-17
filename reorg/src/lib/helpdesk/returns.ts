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

/**
 * eBay ReturnCountFilterEnum buckets we sync, one search call each. Seller
 * Hub's "Manage returns" status dropdown is driven by these exact buckets, so
 * tagging each return with the buckets it appeared in (and filtering on that)
 * is what makes our list counts match eBay's. CLOSED is included but capped at
 * sync time because it can be very large.
 */
export const RETURN_SYNC_BUCKETS = [
  "ALL_OPEN",
  "ALL_OPEN_RETURN",
  "ALL_OPEN_REPLACEMENT",
  "RETURN_STARTED",
  "ITEM_SHIPPED",
  "ITEM_DELIVERED",
  "SELLER_ACTION_DUE",
  "CLOSED",
] as const;

export type ReturnSyncBucket = (typeof RETURN_SYNC_BUCKETS)[number];

/** Which eBay bucket(s) back each list status filter. */
const FILTER_BUCKET_MAP: Record<ReturnStatusFilterKey, string[]> = {
  needs_attention: ["SELLER_ACTION_DUE"],
  open_all: ["ALL_OPEN"],
  open_replacements: ["ALL_OPEN_REPLACEMENT"],
  open_returns: ["ALL_OPEN_RETURN"],
  in_progress: ["RETURN_STARTED"],
  shipped: ["ITEM_SHIPPED"],
  delivered: ["ITEM_DELIVERED"],
  closed: ["CLOSED"],
};

/**
 * Does a return belong to the given list filter, using the eBay buckets it was
 * tagged with on the last sync? This is the authoritative path (matches Seller
 * Hub exactly). Returns null when the row has no bucket data yet so the caller
 * can fall back to {@link matchesStatusFilter} (state-based).
 */
export function matchesBucketFilter(
  filter: ReturnStatusFilterKey,
  buckets: string[] | null | undefined,
): boolean | null {
  if (!Array.isArray(buckets) || buckets.length === 0) return null;
  const wanted = FILTER_BUCKET_MAP[filter] ?? [];
  if (wanted.length === 0) return true;
  const set = new Set(buckets.map((b) => String(b).trim().toUpperCase()));
  return wanted.some((b) => set.has(b));
}

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

/**
 * A refund (full or partial) has ALREADY been issued. eBay keeps the case open
 * for a buyer-response window — it can still auto-close or be escalated — so
 * these are neither "pending" (money already moved) nor "closed" yet. No seller
 * action is required even though eBay still returns a `respondByDate` for the
 * escalation window. `LESS_THAN_A_FULL_REFUND_ISSUED` is the partial-refund case.
 */
const REFUND_ISSUED_STATES = new Set([
  "LESS_THAN_A_FULL_REFUND_ISSUED",
  "FULL_REFUND_ISSUED",
]);

/** True when a refund was already issued (set membership or `*_REFUND_ISSUED`). */
export function isRefundIssued(state: string | null | undefined): boolean {
  const s = normalizeState(state);
  if (!s) return false;
  return REFUND_ISSUED_STATES.has(s) || /REFUND_ISSUED$/.test(s);
}

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
  if (REFUND_PENDING_STATES.has(s) || isRefundIssued(s)) return "refund_pending";
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

export type ReturnStatusTone = "attention" | "progress" | "shipped" | "delivered" | "closed";

export interface ReturnStatusDescriptor {
  /** Plain-English, action-oriented label shown on the badge + list. */
  label: string;
  tone: ReturnStatusTone;
}

/**
 * Map an eBay ReturnStateEnum to a clear, action-oriented status the way Seller
 * Hub phrases it (e.g. ITEM_READY_TO_SHIP → "Label provided - awaiting return").
 * `sellerActionDue` upgrades the label to make the seller's to-do obvious.
 */
export function describeReturnStatus(args: {
  state: string | null | undefined;
  status?: string | null;
  sellerActionDue?: boolean;
}): ReturnStatusDescriptor {
  const s = normalizeState(args.state);

  if (isReturnClosed(s)) {
    if (/PARTIAL/.test(s)) return { label: "Closed - partially refunded", tone: "closed" };
    if (/REFUND/.test(s)) return { label: "Closed - refunded", tone: "closed" };
    if (/TIMEOUT/.test(s)) return { label: "Closed - no action needed", tone: "closed" };
    if (/ITEM_KEPT/.test(s)) return { label: "Closed - item kept", tone: "closed" };
    return { label: "Closed", tone: "closed" };
  }

  // A refund has already been issued (the case is open only for the buyer's
  // accept/escalate window). Surface it as done, not as "action needed".
  if (isRefundIssued(s)) {
    return s === "LESS_THAN_A_FULL_REFUND_ISSUED"
      ? { label: "Partial refund issued", tone: "closed" }
      : { label: "Refund issued", tone: "closed" };
  }

  switch (s) {
    case "RETURN_REQUESTED":
    case "REPLACEMENT_REQUESTED":
      return { label: "Return requested - respond to buyer", tone: "attention" };
    case "RETURN_LABEL_PENDING":
    case "WAITING_FOR_RETURN_LABEL":
      return { label: "Provide a return label", tone: "attention" };
    case "ITEM_READY_TO_SHIP":
    case "RETURN_LABEL_PROVIDED":
      return { label: "Label provided - awaiting returned item", tone: "progress" };
    case "ITEM_SHIPPED":
    case "REPLACEMENT_SHIPPED":
      return { label: "Return shipped - in transit to you", tone: "shipped" };
    case "ITEM_DELIVERED":
    case "REPLACEMENT_DELIVERED":
      return { label: "Return delivered - inspect & refund", tone: "delivered" };
    case "REFUND_INITIATED":
    case "REFUND_SENT_PENDING_CONFIRMATION":
    case "AUTO_REFUND_INITIATED":
    case "PAYOUT_INITIATED":
    case "REFUND_AS_PAYOUT_INITIATED":
      return { label: "Refund in progress", tone: "progress" };
    case "PARTIAL_REFUND_INITIATED":
    case "PARTIAL_REFUND_REQUESTED":
      return { label: "Partial refund offered", tone: "progress" };
    case "ESCALATED":
    case "RETURN_ESCALATED":
      return { label: "Escalated to eBay", tone: "attention" };
    default:
      break;
  }

  const fallback = humanizeReturnState(s);
  return {
    label: args.sellerActionDue ? `${fallback} - action needed` : fallback,
    tone: args.sellerActionDue ? "attention" : "progress",
  };
}

// ─── Refund itemization (issue_refund payload) ───────────────────────────────
//
// eBay's issue_refund call validates EACH itemized line against a per-fee-type
// cap from refundInfo.estimatedRefundDetail (e.g. PURCHASE_PRICE $12.85 +
// ORIGINAL_SHIPPING $1.99). Sending the whole amount as one PURCHASE_PRICE line
// fails with "Refund amount cannot exceed estimated amount" whenever the order
// had original shipping. We must mirror eBay's line items.

/** One fee-type line from eBay's estimatedRefundDetail. */
export interface EstimatedRefundLine {
  refundFeeType: string;
  /** eBay's estimated (max) refundable amount for this fee type, in dollars. */
  estimated: number;
  /** Whether eBay lets the seller reduce this line (deductions only here). */
  editable: boolean;
}

/** A single line we send to eBay's issue_refund call. */
export interface ItemizedRefundLine {
  refundFeeType: string;
  amount: number;
}

export type BuildItemizedRefundResult =
  | { ok: true; lines: ItemizedRefundLine[]; total: number }
  | { ok: false; error: string };

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Pull eBay's per-fee-type estimated refund lines out of a Get Return detail
 * body. Accepts the whole body or the `refundInfo` object. Returns [] when eBay
 * didn't provide an itemized estimate (caller should fall back to a single line).
 */
export function parseEstimatedRefundLines(body: unknown): EstimatedRefundLine[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  const detail = (b.detail ?? b.summary ?? b) as Record<string, unknown>;
  const refundInfo =
    (detail.refundInfo as Record<string, unknown> | undefined) ??
    (b.refundInfo as Record<string, unknown> | undefined);
  const est = refundInfo?.estimatedRefundDetail as Record<string, unknown> | undefined;
  const raw = est?.itemizedRefundDetails;
  if (!Array.isArray(raw)) return [];
  const lines: EstimatedRefundLine[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const feeType = typeof r.refundFeeType === "string" ? r.refundFeeType : null;
    if (!feeType) continue;
    const amt = r.estimatedAmount as Record<string, unknown> | undefined;
    const estimated = toNumber(amt?.value);
    const editable = r.amountEditable === true || r.overwritableBySeller === true;
    lines.push({ refundFeeType: feeType, estimated, editable });
  }
  return lines;
}

/**
 * Build the itemized issue_refund payload from eBay's estimated lines and the
 * seller's requested refund total. Uses integer cents to avoid float drift.
 *
 * - A full refund sends every line at its estimated cap.
 * - A deduction (requested < total estimated) is applied ONLY to editable lines
 *   (largest first). If eBay marks every line non-editable, a deduction is
 *   rejected with a clear message (e.g. SNAD returns must refund in full).
 * - The requested total is clamped so it can never exceed eBay's estimate.
 */
export function buildItemizedRefund(
  estLines: EstimatedRefundLine[],
  requestedRefund: number,
): BuildItemizedRefundResult {
  if (estLines.length === 0) return { ok: false, error: "No estimated refund detail from eBay." };

  const lines = estLines.map((l) => ({
    refundFeeType: l.refundFeeType,
    cents: Math.max(0, Math.round(l.estimated * 100)),
    editable: l.editable,
  }));
  const totalEstCents = lines.reduce((s, l) => s + l.cents, 0);
  if (totalEstCents <= 0) return { ok: false, error: "eBay reported a $0.00 estimated refund." };

  let reqCents = Math.round((Number.isFinite(requestedRefund) ? requestedRefund : 0) * 100);
  if (reqCents <= 0) return { ok: false, error: "The refund amount must be greater than $0.00." };
  // Never exceed eBay's estimate (that's the exact error we're guarding against).
  if (reqCents > totalEstCents) reqCents = totalEstCents;

  let reductionCents = totalEstCents - reqCents;
  if (reductionCents > 0) {
    const editableCapacity = lines
      .filter((l) => l.editable)
      .reduce((s, l) => s + l.cents, 0);
    if (editableCapacity <= 0) {
      return {
        ok: false,
        error:
          "eBay doesn't allow a deduction on this return — the full amount must be refunded. Clear the deduction and try again.",
      };
    }
    if (reductionCents > editableCapacity) {
      return {
        ok: false,
        error: `eBay only allows deducting up to $${(editableCapacity / 100).toFixed(2)} on this return.`,
      };
    }
    // Subtract from editable lines, largest first.
    const editableIdx = lines
      .map((l, i) => ({ i, cents: l.cents, editable: l.editable }))
      .filter((x) => x.editable)
      .sort((a, b) => b.cents - a.cents);
    for (const { i } of editableIdx) {
      if (reductionCents <= 0) break;
      const take = Math.min(lines[i].cents, reductionCents);
      lines[i].cents -= take;
      reductionCents -= take;
    }
  }

  const outLines = lines
    .filter((l) => l.cents > 0)
    .map((l) => ({ refundFeeType: l.refundFeeType, amount: l.cents / 100 }));
  const totalCents = lines.reduce((s, l) => s + l.cents, 0);
  return { ok: true, lines: outLines, total: totalCents / 100 };
}

// ─── Return shipment tracking (from Get Return detail) ───────────────────────

export interface ReturnShipmentTracking {
  carrier: string | null;
  /** Carrier code accepted by the GET /return/{id}/tracking endpoint. */
  carrierUsed: string | null;
  trackingNumber: string | null;
  deliveryStatus: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
}

interface RawShipmentTracking {
  carrierEnum?: string;
  carrierName?: string;
  carrierUsed?: string;
  trackingNumber?: string;
  deliveryStatus?: string;
  shippedBy?: string;
  actualShipDate?: EbayDateTime;
  shipDate?: EbayDateTime;
  actualDeliveryDate?: EbayDateTime;
  deliveryDate?: EbayDateTime;
}

/**
 * Pull the buyer's return-shipment tracking out of a Get Return detail payload.
 * eBay puts it under detail.returnShipmentInfo.shipmentTracking (and an
 * allShipmentTrackings[] history). The trackingNumber + carrierUsed feed the
 * GET /return/{id}/tracking call (both are REQUIRED query params there).
 */
export function extractReturnShipmentTracking(
  raw: EbayReturnSummary | null | undefined,
): ReturnShipmentTracking {
  const root = (raw ?? {}) as Record<string, unknown>;
  const detail = (root.detail ?? root.summary ?? root) as Record<string, unknown>;
  const info = detail.returnShipmentInfo as
    | { shipmentTracking?: RawShipmentTracking; allShipmentTrackings?: RawShipmentTracking[] }
    | undefined;
  const t =
    info?.shipmentTracking ??
    info?.allShipmentTrackings?.[info.allShipmentTrackings.length - 1] ??
    info?.allShipmentTrackings?.[0];
  if (!t) {
    return {
      carrier: null,
      carrierUsed: null,
      trackingNumber: null,
      deliveryStatus: null,
      shippedAt: null,
      deliveredAt: null,
    };
  }
  const carrierUsed = t.carrierUsed ?? t.carrierEnum ?? null;
  return {
    carrier: t.carrierName ?? t.carrierEnum ?? t.carrierUsed ?? null,
    carrierUsed: carrierUsed ? String(carrierUsed) : null,
    trackingNumber: t.trackingNumber ? String(t.trackingNumber) : null,
    deliveryStatus: t.deliveryStatus ? String(t.deliveryStatus) : null,
    shippedAt: parseEbayDate(t.actualShipDate ?? t.shipDate)?.toISOString() ?? null,
    deliveredAt: parseEbayDate(t.actualDeliveryDate ?? t.deliveryDate)?.toISOString() ?? null,
  };
}

// ─── Seller action availability ──────────────────────────────────────────────

/** Our internal live-write action keys. */
export type ReturnActionKey =
  | "APPROVE_RETURN"
  | "DECLINE_RETURN"
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
  DECLINE_RETURN: ["SELLER_DECLINE_REQUEST"],
  OFFER_PARTIAL_REFUND: ["SELLER_OFFER_PARTIAL_REFUND"],
  // eBay exposes a single SELLER_PROVIDE_LABEL option that fans out into the
  // label choices seen in Seller Hub (provide an eBay label / upload a label).
  // The distinction is the labelAction we send to add_shipping_label.
  PROVIDE_EBAY_LABEL: ["SELLER_PROVIDE_LABEL", "SELLER_PRINT_SHIPPING_LABEL"],
  UPLOAD_LABEL: ["SELLER_PROVIDE_LABEL"],
  CONFIRM_LABEL_SENT: ["SELLER_PROVIDE_LABEL", "SELLER_PROVIDE_TRACKING_INFO", "SELLER_UPDATE_TRACKING"],
  MARK_AS_RECEIVED: ["SELLER_MARK_AS_RECEIVED"],
  ISSUE_REFUND: ["SELLER_ISSUE_REFUND"],
};

/**
 * Actions we deliberately DO NOT execute as a live API write even when eBay
 * offers them. Empty in v1: PROVIDE_EBAY_LABEL (purchase a paid eBay return
 * label) is now wired through the full safety gate + typed confirmation just
 * like every other live write — it is NOT silently blocked. Keep this array as
 * the single place to re-block an action if policy ever requires it.
 */
export const POLICY_BLOCKED_ACTIONS: ReturnActionKey[] = [];

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

// ─── eBay-parity action model ────────────────────────────────────────────────

/**
 * A single executable action inside a group (the leaf the user clicks). `kind`
 * tells the client which modal to open.
 */
export interface ReturnActionChoice {
  actionKey: ReturnActionKey;
  label: string;
  description?: string;
  /** Modal flavor: confirm | refund-amount | label-upload | label-ebay. */
  kind: "confirm" | "refund_full" | "refund_partial" | "label_upload" | "label_ebay";
  /** Paid / irreversible → red styling + extra warning in the UI. */
  destructive?: boolean;
}

/** A top-level option block in the "Action needed" panel (mirrors Seller Hub). */
export interface ReturnActionGroup {
  /** Stable id for React keys. */
  id: string;
  label: string;
  description?: string;
  /** "action" = clickable choices; "track" = read-only Track Package modal. */
  kind: "action" | "track";
  choices: ReturnActionChoice[];
}

/**
 * Build the seller action panel EXACTLY the way eBay Seller Hub presents it for
 * the return's current lifecycle, driven by the live sellerAvailableOptions.
 *
 * Parity rules (verified against live eBay payloads + the Seller Hub UI):
 *   - RETURN_REQUESTED  → Accept the return / Decline the return / Offer a full
 *     or partial refund.
 *   - waiting on seller label (RETURN_LABEL_PENDING) → Provide an eBay label /
 *     Upload a label.
 *   - label provided, awaiting buyer ship (ITEM_READY_TO_SHIP) → Offer refund
 *     (full / partial). NOT mark-as-received (eBay hides it here even though the
 *     API still lists it).
 *   - in transit / delivered (ITEM_SHIPPED / ITEM_DELIVERED) → Mark as received
 *     / Track package / Start refund (full / partial).
 *   - closed → no actions.
 */
export function getReturnActionModel(args: {
  state: string | null | undefined;
  sellerOptions: EbayAvailableOption[] | null | undefined;
}): ReturnActionGroup[] {
  if (isReturnClosed(args.state)) return [];

  const present = new Set(extractActionTypes(args.sellerOptions));
  const has = (opt: string) => present.has(opt);
  const lifecycle = getReturnLifecycle(args.state);
  const shippedOrDelivered = lifecycle === "in_transit" || lifecycle === "delivered";

  const groups: ReturnActionGroup[] = [];

  // 1) Accept / decline — only while the buyer's request awaits a seller verdict.
  if (has("SELLER_APPROVE_REQUEST")) {
    groups.push({
      id: "accept",
      label: "Accept the return",
      description: "Approve the return, then provide a return label.",
      kind: "action",
      choices: [
        {
          actionKey: "APPROVE_RETURN",
          label: "Accept the return",
          kind: "confirm",
        },
      ],
    });
  }
  if (has("SELLER_DECLINE_REQUEST")) {
    groups.push({
      id: "decline",
      label: "Decline the return",
      description: "Close this return request; the buyer keeps the item.",
      kind: "action",
      choices: [
        {
          actionKey: "DECLINE_RETURN",
          label: "Decline the return",
          kind: "confirm",
          destructive: true,
        },
      ],
    });
  }

  // 2) Provide a label — only while eBay is still waiting on the seller's label
  //    (before the buyer has shipped). Once an item is in transit we never show
  //    label actions.
  const needsLabel =
    (has("SELLER_PROVIDE_LABEL") || has("SELLER_PRINT_SHIPPING_LABEL")) &&
    !shippedOrDelivered &&
    !has("SELLER_VOID_LABEL"); // a void option means a label is already provided
  if (needsLabel) {
    groups.push({
      id: "label",
      label: "Provide a return label",
      description: "Give the buyer a return shipping label.",
      kind: "action",
      choices: [
        {
          actionKey: "PROVIDE_EBAY_LABEL",
          label: "Provide an eBay label",
          description: "eBay generates a prepaid label and charges you for it.",
          kind: "label_ebay",
          destructive: true,
        },
        {
          actionKey: "UPLOAD_LABEL",
          label: "Upload a label",
          description: "Attach your own prepaid label (PDF or image) + tracking.",
          kind: "label_upload",
        },
        {
          actionKey: "CONFIRM_LABEL_SENT",
          label: "Confirm you sent a label",
          description: "Confirm you already provided a return label to the buyer.",
          kind: "confirm",
        },
      ],
    });
  }

  // 3) Mark as received + Track package — only after the buyer has shipped.
  if (shippedOrDelivered) {
    if (has("SELLER_MARK_AS_RECEIVED")) {
      groups.push({
        id: "mark_received",
        label: "Mark as received",
        description: "Confirm you received the returned item.",
        kind: "action",
        choices: [
          { actionKey: "MARK_AS_RECEIVED", label: "Mark as received", kind: "confirm" },
        ],
      });
    }
    groups.push({
      id: "track",
      label: "Track package",
      description: "See the return shipment's tracking events.",
      kind: "track",
      choices: [],
    });
  }

  // 4) Refund — full and/or partial, whenever eBay offers a refund path.
  const refundChoices: ReturnActionChoice[] = [];
  if (has("SELLER_ISSUE_REFUND")) {
    refundChoices.push({
      actionKey: "ISSUE_REFUND",
      label: "Send a full refund",
      description: "Refund the buyer in full. The return closes.",
      kind: "refund_full",
      destructive: true,
    });
  }
  if (has("SELLER_OFFER_PARTIAL_REFUND")) {
    refundChoices.push({
      actionKey: "OFFER_PARTIAL_REFUND",
      label: "Offer a partial refund",
      description: "Offer a partial refund and let the buyer keep the item.",
      kind: "refund_partial",
    });
  }
  if (refundChoices.length > 0) {
    // eBay labels this block differently by stage.
    const label = has("SELLER_APPROVE_REQUEST")
      ? "Offer a full or partial refund"
      : shippedOrDelivered
        ? "Start refund"
        : "Offer refund";
    groups.push({
      id: "refund",
      label,
      description: "Send a full refund or offer the buyer a partial refund.",
      kind: "action",
      choices: refundChoices,
    });
  }

  return groups;
}

/** True when eBay currently has a seller action due (drives needs-attention badge). */
export function deriveSellerActionDue(args: {
  sellerAvailableOptions?: EbayAvailableOption[] | null;
  sellerResponseDueAt?: Date | null;
  state?: string | null;
}): boolean {
  if (isReturnClosed(args.state)) return false;
  // A refund (full or partial) has already been issued, or one is mid-flight —
  // the seller has nothing to do. eBay still returns a buyer-escalation
  // respondByDate here, so we must not treat that date as a seller to-do.
  const st = normalizeState(args.state);
  if (isRefundIssued(st) || REFUND_PENDING_STATES.has(st)) return false;
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
