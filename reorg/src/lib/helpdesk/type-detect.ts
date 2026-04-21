/**
 * Pure heuristic that classifies an inbound buyer message into a
 * `HelpdeskTicketType`. This runs during eBay sync (and any future
 * inbound channels) so untriaged tickets land in the inbox already
 * pre-tagged — agents only have to override the few cases the
 * heuristic can't disambiguate.
 *
 * Important contract: callers MUST skip detection when
 * `helpdesk_tickets.typeOverridden = true`. Once an agent has manually
 * picked a type, we never silently revert their choice — even if a
 * later message in the same thread looks like a different category.
 *
 * Detection priority (highest first):
 *   1. eBay `questionType` field (authoritative when present)
 *   2. Subject keywords (used to spot "Return Request", "INR claim", etc.
 *      that eBay doesn't always tag explicitly)
 *   3. Body keywords (last-resort signal — easier to false-positive on)
 *
 * Returns `null` when no rule fires; callers should leave the existing
 * type alone in that case (default is QUERY for fresh tickets).
 */

import { HelpdeskTicketType } from "@prisma/client";

export interface TypeDetectInput {
  /** eBay's MyMessagesQuestionType, if any. */
  ebayQuestionType?: string | null;
  /** Trimmed subject line. */
  subject?: string | null;
  /** Plain-text body — first ~500 chars are usually enough. */
  bodyText?: string | null;
}

/**
 * Map eBay's MyMessagesQuestionType enum to our internal types. Values
 * sourced from eBay Trading API docs (GetMyMessagesResponse). Anything
 * not in this map falls through to keyword detection.
 */
const EBAY_QUESTION_TYPE_MAP: Record<string, HelpdeskTicketType> = {
  General: HelpdeskTicketType.QUERY,
  CustomizedSubject: HelpdeskTicketType.QUERY,
  Shipping: HelpdeskTicketType.SHIPPING_QUERY,
  Payment: HelpdeskTicketType.QUERY,
  MultipleItemShipping: HelpdeskTicketType.SHIPPING_QUERY,
  Return: HelpdeskTicketType.RETURN_REQUEST,
  ReturnItem: HelpdeskTicketType.RETURN_REQUEST,
  ItemNotReceived: HelpdeskTicketType.ITEM_NOT_RECEIVED,
  ClassifiedsBestOffer: HelpdeskTicketType.PRE_SALES,
};

/** Cheap case-insensitive subject heuristics. */
const SUBJECT_RULES: Array<{
  pattern: RegExp;
  type: HelpdeskTicketType;
}> = [
  { pattern: /\breturn\s*(request|item|order)?\b/i, type: HelpdeskTicketType.RETURN_REQUEST },
  { pattern: /\b(item\s+not\s+received|never\s+arrived|inr\b)/i, type: HelpdeskTicketType.ITEM_NOT_RECEIVED },
  { pattern: /\b(refund|money\s+back)\b/i, type: HelpdeskTicketType.REFUND },
  { pattern: /\b(cancel(lation)?|cancel\s+order)\b/i, type: HelpdeskTicketType.CANCELLATION },
  { pattern: /\b(negative\s+feedback|leave\s+feedback)\b/i, type: HelpdeskTicketType.NEGATIVE_FEEDBACK },
  { pattern: /\b(ship(ping)?|tracking|delivery|arriv)\w*\b/i, type: HelpdeskTicketType.SHIPPING_QUERY },
];

/** Body-only heuristics. Only fired if subject was inconclusive. */
const BODY_RULES: Array<{
  pattern: RegExp;
  type: HelpdeskTicketType;
}> = [
  { pattern: /\bopen(ed|ing)?\s+a?\s*return\b/i, type: HelpdeskTicketType.RETURN_REQUEST },
  { pattern: /\b(haven'?t|never|still\s+not)\s+receiv\w+/i, type: HelpdeskTicketType.ITEM_NOT_RECEIVED },
  { pattern: /\bplease\s+cancel\b/i, type: HelpdeskTicketType.CANCELLATION },
  { pattern: /\bissue\s+a?\s*refund\b/i, type: HelpdeskTicketType.REFUND },
];

export function detectTicketType(input: TypeDetectInput): HelpdeskTicketType | null {
  const { ebayQuestionType, subject, bodyText } = input;

  if (ebayQuestionType) {
    const fromQt = EBAY_QUESTION_TYPE_MAP[ebayQuestionType];
    if (fromQt) return fromQt;
  }

  if (subject) {
    for (const rule of SUBJECT_RULES) {
      if (rule.pattern.test(subject)) return rule.type;
    }
  }

  if (bodyText) {
    // Trim body to first 500 chars — buyers tend to lead with the actual
    // question and we don't want a stray word in a quoted email signature
    // re-classifying a thread.
    const head = bodyText.slice(0, 500);
    for (const rule of BODY_RULES) {
      if (rule.pattern.test(head)) return rule.type;
    }
  }

  return null;
}
