/**
 * Hardcoded detection for messages that originate from eBay itself
 * (NOT from a buyer). These are bookkeeping notifications such as
 * "Return approved", "Item delivered", "Buyer shipped item",
 * "We sent your payout", "A buyer wants to cancel an order", etc.
 *
 * Detection has TWO outputs:
 *
 *   1. {@link detectFromEbay} — is this message a "From eBay" notification,
 *      and if so what *kind* of notification (so the From eBay sub-folder
 *      can render type-filter chips like "Return Approved",
 *      "Item not received claim", etc.)?
 *
 *   2. {@link detectCancellationRequest} — is this message specifically the
 *      "buyer wants to cancel an order" notification? Cancellation requests
 *      route to the dedicated Cancel Requests folder (NOT the From eBay
 *      sub-folder) so agents can action them quickly. They also get
 *      `type = CANCELLATION` so future filters / reports can distinguish
 *      them from generic eBay system mail.
 *
 * IMPORTANT: this module is the single source of truth for "is this a
 * system message from eBay". The eBay sync calls it once per inserted
 * message; the retro reorg script calls it again to backfill historical
 * tickets. Keep both call-sites in sync if you change the detection
 * surface.
 *
 * Detection robustness — we deliberately avoid relying on a single
 * exact-subject match because eBay rephrases their templates without
 * notice. Instead each detector combines several signals:
 *   - sender == "eBay"  (strongest)
 *   - subject keywords  (medium — eBay's wording shifts slightly across years)
 *   - body keywords     (last-resort confirming signal)
 *   - structural cues   (presence of "Reason for cancellation:", "Order #",
 *                        eBay case numbers, etc.)
 */

export interface FromEbayDetectInput {
  sender?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  /** eBay's MyMessagesQuestionType, when present. */
  ebayQuestionType?: string | null;
}

/**
 * Stable tokens used as `helpdeskTicket.systemMessageType`. The frontend
 * From-eBay folder reads these to render filter chips ("Return Approved",
 * etc.) and to colour-code rows. Adding a new category? Append it here AND
 * to {@link SYSTEM_MESSAGE_TYPE_LABELS} in the same commit.
 */
export const SYSTEM_MESSAGE_TYPES = {
  CANCELLATION_REQUEST: "CANCELLATION_REQUEST",
  CANCELLATION_CONFIRMED: "CANCELLATION_CONFIRMED",
  RETURN_REQUEST: "RETURN_REQUEST",
  RETURN_APPROVED: "RETURN_APPROVED",
  RETURN_CLOSED: "RETURN_CLOSED",
  ITEM_NOT_RECEIVED: "ITEM_NOT_RECEIVED",
  ITEM_DELIVERED: "ITEM_DELIVERED",
  BUYER_SHIPPED: "BUYER_SHIPPED",
  REFUND_ISSUED: "REFUND_ISSUED",
  REFUND_REQUESTED: "REFUND_REQUESTED",
  CASE_OPENED: "CASE_OPENED",
  CASE_ON_HOLD: "CASE_ON_HOLD",
  CASE_CLOSED: "CASE_CLOSED",
  PAYOUT_SENT: "PAYOUT_SENT",
  FUNDS_ON_HOLD: "FUNDS_ON_HOLD",
  REMINDER_TO_SHIP: "REMINDER_TO_SHIP",
  FEEDBACK_REMOVAL_APPROVED: "FEEDBACK_REMOVAL_APPROVED",
  FEEDBACK_REPORTED: "FEEDBACK_REPORTED",
  OTHER_EBAY_NOTIFICATION: "OTHER_EBAY_NOTIFICATION",
} as const;

export type SystemMessageType =
  (typeof SYSTEM_MESSAGE_TYPES)[keyof typeof SYSTEM_MESSAGE_TYPES];

/** Human-readable labels for the type-filter chips. */
export const SYSTEM_MESSAGE_TYPE_LABELS: Record<SystemMessageType, string> = {
  CANCELLATION_REQUEST: "Cancellation Request",
  CANCELLATION_CONFIRMED: "Cancellation Confirmed",
  RETURN_REQUEST: "Return Request",
  RETURN_APPROVED: "Return Approved",
  RETURN_CLOSED: "Return Closed",
  ITEM_NOT_RECEIVED: "Item Not Received",
  ITEM_DELIVERED: "Item Delivered",
  BUYER_SHIPPED: "Buyer Shipped Item",
  REFUND_ISSUED: "Refund Issued",
  REFUND_REQUESTED: "Refund Requested",
  CASE_OPENED: "Case Opened",
  CASE_ON_HOLD: "Case On Hold",
  CASE_CLOSED: "Case Closed",
  PAYOUT_SENT: "Payout Sent",
  FUNDS_ON_HOLD: "Funds On Hold",
  REMINDER_TO_SHIP: "Reminder To Ship",
  FEEDBACK_REMOVAL_APPROVED: "Feedback Removal Approved",
  FEEDBACK_REPORTED: "Feedback Reported",
  OTHER_EBAY_NOTIFICATION: "Other eBay Notification",
};

export interface FromEbayDetectResult {
  /** True when the heuristic is confident this message originates from eBay. */
  isFromEbay: boolean;
  /** Sub-classification for the From eBay folder type filter. */
  systemMessageType: SystemMessageType;
}

const NULL_RESULT: FromEbayDetectResult = {
  isFromEbay: false,
  systemMessageType: SYSTEM_MESSAGE_TYPES.OTHER_EBAY_NOTIFICATION,
};

/**
 * Subject patterns mapped to a `SystemMessageType`. Order matters — the
 * first pattern to match wins. Patterns are tested case-insensitively.
 *
 * To add a new category: append to {@link SYSTEM_MESSAGE_TYPES} first,
 * then add a new pattern here, then add the human label to
 * {@link SYSTEM_MESSAGE_TYPE_LABELS}.
 */
const SUBJECT_PATTERNS: Array<{ pattern: RegExp; type: SystemMessageType }> = [
  // Cancellation flows (most specific first so they win against the looser
  // "is now closed" / "case closed" patterns lower down).
  { pattern: /buyer\s+wants?\s+to\s+cancel/i, type: SYSTEM_MESSAGE_TYPES.CANCELLATION_REQUEST },
  { pattern: /cancellation\s+request/i, type: SYSTEM_MESSAGE_TYPES.CANCELLATION_REQUEST },
  { pattern: /you\s+successfully\s+cancel(l?)ed\s+an\s+order/i, type: SYSTEM_MESSAGE_TYPES.CANCELLATION_CONFIRMED },
  { pattern: /order\s+(was|has\s+been)\s+cancel(l?)ed/i, type: SYSTEM_MESSAGE_TYPES.CANCELLATION_CONFIRMED },

  // Returns
  { pattern: /return\s+approved/i, type: SYSTEM_MESSAGE_TYPES.RETURN_APPROVED },
  { pattern: /you\s+accepted\s+(a|the)\s+return/i, type: SYSTEM_MESSAGE_TYPES.RETURN_APPROVED },
  { pattern: /return\s+closed/i, type: SYSTEM_MESSAGE_TYPES.RETURN_CLOSED },
  { pattern: /(new\s+return\s+request|return\s+request|buyer\s+(opened|requested)\s+a\s+return)/i, type: SYSTEM_MESSAGE_TYPES.RETURN_REQUEST },

  // INR
  { pattern: /(item\s+not\s+received|opened\s+an?\s+item\s+not\s+received|inr\s+claim)/i, type: SYSTEM_MESSAGE_TYPES.ITEM_NOT_RECEIVED },
  { pattern: /(item\s+hasn'?t\s+arrived|item\s+has\s+not\s+arrived|not\s+received\s+request)/i, type: SYSTEM_MESSAGE_TYPES.ITEM_NOT_RECEIVED },

  // Shipping bookkeeping
  { pattern: /item\s+delivered/i, type: SYSTEM_MESSAGE_TYPES.ITEM_DELIVERED },
  { pattern: /buyer'?s\s+item\s+arrived/i, type: SYSTEM_MESSAGE_TYPES.ITEM_DELIVERED },
  { pattern: /shipping\s+status\s+shows.*delivered/i, type: SYSTEM_MESSAGE_TYPES.ITEM_DELIVERED },
  { pattern: /buyer\s+shipped\s+item/i, type: SYSTEM_MESSAGE_TYPES.BUYER_SHIPPED },
  { pattern: /remember\s+to\s+ship/i, type: SYSTEM_MESSAGE_TYPES.REMINDER_TO_SHIP },

  // Refunds
  { pattern: /refund\s+issued/i, type: SYSTEM_MESSAGE_TYPES.REFUND_ISSUED },
  { pattern: /(processing|hang\s+tight).*refund\s+request/i, type: SYSTEM_MESSAGE_TYPES.REFUND_REQUESTED },
  { pattern: /issue\s+refund/i, type: SYSTEM_MESSAGE_TYPES.REFUND_REQUESTED },

  // Cases
  { pattern: /case\s*#?\s*\d+\s*:\s*buyer\s+contacted\s+customer\s+service/i, type: SYSTEM_MESSAGE_TYPES.CASE_OPENED },
  { pattern: /buyer\s+contacted\s+customer\s+service/i, type: SYSTEM_MESSAGE_TYPES.CASE_OPENED },
  { pattern: /your\s+case\s+is\s+on\s+hold/i, type: SYSTEM_MESSAGE_TYPES.CASE_ON_HOLD },
  { pattern: /request\s+#?\d+\s+was\s+closed\s+by\s+the\s+buyer/i, type: SYSTEM_MESSAGE_TYPES.CASE_CLOSED },
  { pattern: /(this\s+)?case\s+(is\s+now\s+)?(has\s+been\s+)?closed/i, type: SYSTEM_MESSAGE_TYPES.CASE_CLOSED },
  { pattern: /\bis\s+now\s+closed\b/i, type: SYSTEM_MESSAGE_TYPES.CASE_CLOSED },
  { pattern: /thanks\s+for\s+reporting\s+an\s+issue\s+with\s+a\s+buyer/i, type: SYSTEM_MESSAGE_TYPES.CASE_OPENED },

  // Money movement
  { pattern: /we\s+sent\s+your\s+payout/i, type: SYSTEM_MESSAGE_TYPES.PAYOUT_SENT },
  { pattern: /your\s+funds\s+are\s+on\s+hold/i, type: SYSTEM_MESSAGE_TYPES.FUNDS_ON_HOLD },

  // Feedback
  { pattern: /feedback\s+removal\s+request\s+was\s+approv/i, type: SYSTEM_MESSAGE_TYPES.FEEDBACK_REMOVAL_APPROVED },
  { pattern: /feedback.*report/i, type: SYSTEM_MESSAGE_TYPES.FEEDBACK_REPORTED },
];

/**
 * Body cues that strongly suggest a message originated from eBay itself.
 * Used as a confirming signal when the sender field is missing or
 * ambiguous (eBay sometimes leaves Sender blank on system mail).
 */
const EBAY_BODY_CUES: RegExp[] = [
  /\beBay\s+Customer\s+Service\b/i,
  /\bThis\s+is\s+an\s+automated\s+(message|email)\s+from\s+eBay/i,
  /\bsent\s+from\s+eBay\b/i,
  /\bBuyer:\s*<a\s+href=".*\/usr\//i,
  /Reason\s+for\s+cancellation\s*:/i,
  /\bCase\s+#?\s*\d{4,}/i,
  /eBay\s+(Money|Buyer)\s+Back\s+Guarantee/i,
  /\bgo\s+to\s+(My\s+)?eBay\b/i,
];

/** Normalize whitespace + strip simple HTML so regex tests are reliable. */
function normalize(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Decide whether a message is a "From eBay" system notification.
 *
 * The function returns the BEST-effort sub-classification (one of
 * `SYSTEM_MESSAGE_TYPES`) when `isFromEbay` is true. The catch-all is
 * `OTHER_EBAY_NOTIFICATION` — used when we're confident eBay sent it but
 * we can't pin down the exact category. Those tickets still land in the
 * From eBay folder and an agent can re-classify manually.
 */
export function detectFromEbay(input: FromEbayDetectInput): FromEbayDetectResult {
  const sender = (input.sender ?? "").trim().toLowerCase();
  const subjectRaw = input.subject ?? "";
  const subject = normalize(subjectRaw);
  const bodyHead = normalize(input.bodyText ?? "").slice(0, 4000);

  // Signal 1: explicit sender match. eBay's MyMessages API stamps
  // "eBay" (sometimes "eBay Customer Service" or "eBay Buyer Protection")
  // on system mail. Anything that says "eBay" without a buyer username
  // tail is a system message, full stop.
  const senderIsEbay =
    sender === "ebay" ||
    sender === "ebay customer service" ||
    sender === "ebay buyer protection" ||
    sender === "ebay support" ||
    sender.startsWith("ebay ");

  // Signal 2: subject keyword classification. We try to pin the exact
  // category here even when the sender is missing — many of eBay's older
  // templates leave Sender blank and the subject is the only header we
  // can trust.
  let subjectMatch: SystemMessageType | null = null;
  for (const rule of SUBJECT_PATTERNS) {
    if (rule.pattern.test(subject)) {
      subjectMatch = rule.type;
      break;
    }
  }

  // Signal 3: body cues. Used to PROMOTE a borderline subject (no obvious
  // eBay keyword) into a confident "from eBay" classification when the
  // body still screams system mail (e.g. contains "Reason for
  // cancellation:" or an eBay case number).
  const bodyHasEbayCue = EBAY_BODY_CUES.some((re) => re.test(bodyHead));

  // Decision matrix:
  //   sender=eBay                  → from eBay (use subject if we can,
  //                                  else OTHER_EBAY_NOTIFICATION)
  //   subject matches a SYSTEM_PAT → from eBay (we know the category;
  //                                  body cue not required)
  //   bodyHasEbayCue + senderEbay  → already covered above
  //   bodyHasEbayCue + subjectMatch → also covered above
  //   bodyHasEbayCue ALONE         → not enough — buyers sometimes
  //                                  paste eBay quotations into their
  //                                  own replies. We require at least
  //                                  one of {sender, subject} to confirm.
  if (senderIsEbay) {
    return {
      isFromEbay: true,
      systemMessageType: subjectMatch ?? SYSTEM_MESSAGE_TYPES.OTHER_EBAY_NOTIFICATION,
    };
  }
  if (subjectMatch) {
    // Subject pattern alone is a strong enough signal — these phrases
    // ("Return approved", "Item delivered", etc.) are eBay-system
    // language that buyers don't naturally write.
    return { isFromEbay: true, systemMessageType: subjectMatch };
  }
  // Final tie-breaker: explicit ebay questionType + body cue.
  if (input.ebayQuestionType === "Return" && bodyHasEbayCue) {
    return { isFromEbay: true, systemMessageType: SYSTEM_MESSAGE_TYPES.RETURN_REQUEST };
  }

  return NULL_RESULT;
}

/**
 * Specialised wrapper: is this message a "buyer wants to cancel an
 * order" notification? Returns true when the message qualifies for the
 * dedicated Cancel Requests folder.
 *
 * This is intentionally MORE permissive than the subject-only filter the
 * user originally configured. Robustness signals (any one of the below
 * combined with a sender=eBay or "Reason for cancellation" body cue
 * confirms a cancellation):
 *   - subject contains "buyer wants to cancel" (current eBay phrasing)
 *   - subject contains "cancellation request"
 *   - body contains "Reason for cancellation:" + sender=eBay
 *   - eBay questionType implies a cancellation flow
 */
export function detectCancellationRequest(input: FromEbayDetectInput): boolean {
  const sender = (input.sender ?? "").trim().toLowerCase();
  const senderIsEbay =
    sender === "ebay" ||
    sender === "ebay customer service" ||
    sender === "ebay buyer protection" ||
    sender.startsWith("ebay ");
  const subject = normalize(input.subject ?? "");
  const body = normalize(input.bodyText ?? "").slice(0, 4000);

  if (/buyer\s+wants?\s+to\s+cancel/i.test(subject)) return true;
  if (/cancellation\s+request/i.test(subject) && (senderIsEbay || /Reason\s+for\s+cancellation/i.test(body))) {
    return true;
  }
  if (
    senderIsEbay &&
    /Reason\s+for\s+cancellation\s*:/i.test(body) &&
    !/cancellation\s+(confirmed|complete|completed|approved)/i.test(subject)
  ) {
    return true;
  }
  return false;
}
