/**
 * Buyer identity resolver for Help Desk messages.
 *
 * Why this exists
 * ───────────────
 * eBay's GetMyMessages API does not give us a clean "buyer userId" field on
 * every message. Specifically:
 *
 *   - For a real buyer→seller message, `sender` IS the buyer's eBay user id
 *     and `recipientUserID` is the seller's user id (e.g. "theperfectpart").
 *   - For an eBay system message that lands in the seller's Inbox folder
 *     (shipping notifications, refund confirmations, case updates, etc.)
 *     the `sender` is literally the string "eBay" and the `recipientUserID`
 *     is again the seller's user id. The actual buyer is referenced only in
 *     the body text ("Dear <buyer>", "Hi <buyer>", "<buyer> has opened a
 *     case…").
 *
 * Our previous implementation naively treated every Inbox message as INBOUND
 * and stored `sender` as `buyerUserId`. The result:
 *
 *   - Tickets generated from system messages had `buyerUserId="eBay"` or
 *     `buyerUserId="<seller>"` (because some system flows show the seller
 *     as the sender, depending on folder).
 *   - "Other tickets from this buyer" then collapsed every system-noise
 *     ticket into one bucket per *seller account*, listing 1000+ unrelated
 *     tickets every time the agent opened any ticket.
 *   - The Customer column showed our own seller name instead of the real
 *     buyer.
 *
 * The fix is to centralise buyer identification in this single resolver and
 * use it everywhere we need a buyer id (sync-time threading, list rendering,
 * "other tickets" lookups, repair scripts).
 */

import type { EbayMessageBody } from "@/lib/services/helpdesk-ebay";
import type { Integration, Platform } from "@prisma/client";
import { db } from "@/lib/db";

// ─── Seller / system identity ─────────────────────────────────────────────

/**
 * Pull the seller's eBay user id out of `Integration.config`.
 *
 * Stored when the OAuth handshake completes — always present for
 * TPP_EBAY / TT_EBAY in production. We treat it case-insensitively when
 * comparing against message fields because eBay returns mixed casing.
 */
export function getSellerUserId(integration: Integration): string | null {
  const cfg = (integration.config ?? {}) as Record<string, unknown>;
  const raw = cfg.accountUserId;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/**
 * eBay system "senders" we must never store as a buyer. The list is
 * intentionally short — only literal "eBay" plus the seller's own id, both
 * matched case-insensitively.
 */
export function isSystemOrSellerSender(
  candidate: string | null | undefined,
  sellerUserId: string | null,
): boolean {
  if (!candidate) return true;
  const lower = candidate.trim().toLowerCase();
  if (!lower) return true;
  if (lower === "ebay") return true;
  if (sellerUserId && lower === sellerUserId.toLowerCase()) return true;
  return false;
}

// ─── Body-text buyer extraction ───────────────────────────────────────────

/**
 * Strip a single line of leading whitespace/punctuation so a name we pulled
 * out of body text doesn't end up looking like ", john" or ":\nJohn".
 */
function cleanName(s: string): string {
  return s.replace(/^[\s,;:!\.\-]+|[\s,;:!\.\-]+$/g, "").trim();
}

/**
 * Best-effort: extract the buyer's eBay username from the body text of a
 * system or auto-responder message. We try a few common shapes:
 *
 *   - "Hi <buyer>,"
 *   - "Hello <buyer>,"
 *   - "Dear <buyer>,"
 *   - "<buyer> has opened a case..."
 *   - "<buyer> has requested..."
 *   - "<buyer> bought from you"
 *
 * Returns null if no confident match (we'd rather show "Unknown buyer" than
 * a wrong name).
 */
export function extractBuyerFromBody(text: string | null | undefined): string | null {
  if (!text) return null;
  // Strip HTML tags so we can match plain phrases reliably.
  const plain = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ");

  const patterns: RegExp[] = [
    /\b(?:Hi|Hello|Dear)\s+([A-Za-z0-9._-]{2,40})\s*[,:]/,
    /\b([A-Za-z0-9._-]{2,40})\s+has\s+(?:opened|requested|left|sent|cancelled|asked|bought)\b/i,
    /\bfrom\s+buyer\s+([A-Za-z0-9._-]{2,40})\b/i,
    /\bbuyer[:\s]+([A-Za-z0-9._-]{2,40})\b/i,
  ];

  for (const re of patterns) {
    const m = re.exec(plain);
    if (m && m[1]) {
      const cand = cleanName(m[1]);
      // Filter obvious noise.
      if (!cand) continue;
      const lower = cand.toLowerCase();
      if (
        lower === "ebay" ||
        lower === "buyer" ||
        lower === "seller" ||
        lower === "customer" ||
        lower === "support" ||
        lower === "team" ||
        lower === "valued"
      ) {
        continue;
      }
      return cand;
    }
  }
  return null;
}

// ─── Sale-order fallback ──────────────────────────────────────────────────

/**
 * Look up the buyer on the matching MarketplaceSaleOrder for this
 * (platform, externalOrderId). Returns the buyer identifier (typically the
 * eBay username) and a display label suitable for the Customer column.
 */
export async function resolveBuyerFromSaleOrder(
  platform: Platform,
  orderNumber: string | null,
): Promise<{ userId: string | null; label: string | null; email: string | null } | null> {
  if (!orderNumber) return null;
  const order = await db.marketplaceSaleOrder.findFirst({
    where: { platform, externalOrderId: orderNumber },
    select: {
      buyerIdentifier: true,
      buyerDisplayLabel: true,
      buyerEmail: true,
    },
  });
  if (!order) return null;
  return {
    userId: order.buyerIdentifier ?? null,
    label: order.buyerDisplayLabel ?? order.buyerIdentifier ?? null,
    email: order.buyerEmail ?? null,
  };
}

/**
 * Pull the buyer's eBay handle out of an eBay HTML digest body.
 *
 * eBay's `MessageHistory[N]` blocks (and the live `PrimaryMessage`
 * block) embed the buyer username inside an anchor of the form:
 *
 *     <a href="https://www.ebay.com/.../usr/<buyer>?...">buyer</a>
 *
 * The same handle can appear many times in one body (one per history
 * heading + the live envelope). We just need ONE non-system match. We
 * scan every `/usr/<x>` link and return the first one that isn't the
 * literal "eBay" or the seller's own user id.
 *
 * Returns `null` when the body is plain text (no HTML link), when no
 * `/usr/...` anchors exist, or when every candidate is filtered out as
 * a system/seller handle.
 */
export function extractBuyerFromDigestHtml(
  html: string | null | undefined,
  sellerUserId: string | null,
): string | null {
  if (!html) return null;
  // Cheap pre-check: skip the regex pass entirely when the body has no
  // /usr/ link at all.
  if (!/\/usr\//i.test(html)) return null;
  const re = /https?:\/\/[^"'\s]*\/usr\/([A-Za-z0-9._-]+)/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const cand = m[1]?.trim();
    if (!cand) continue;
    const lower = cand.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (isSystemOrSellerSender(cand, sellerUserId)) continue;
    return cand;
  }
  return null;
}

// ─── Top-level resolver ───────────────────────────────────────────────────

export interface ResolvedBuyer {
  /**
   * The string we should store as `HelpdeskTicket.buyerUserId`. Never the
   * literal "eBay" and never the seller's own user id.
   */
  buyerUserId: string | null;
  /**
   * A more human-friendly label. Usually identical to `buyerUserId` for
   * eBay (which uses usernames as both id and display) but sourced from
   * `MarketplaceSaleOrder.buyerDisplayLabel` when we can.
   */
  buyerName: string | null;
  /** Buyer email when we have it. */
  buyerEmail: string | null;
  /**
   * Where the answer came from — useful for diagnostics and tests.
   *   - "header"    : taken from EbayMessageBody.sender / recipientUserID
   *   - "body"      : extracted from the message text ("Dear <name>,")
   *   - "saleOrder" : looked up on MarketplaceSaleOrder by order number
   *   - "none"      : no confident match
   */
  source: "header" | "body" | "saleOrder" | "none";
}

/**
 * Resolve the buyer for a single eBay message, using everything we know.
 *
 * Order of preference:
 *
 *   1. Header-side lookup. If `sender` is a real buyer (not "eBay" and not
 *      the seller), use it. Else if `recipientUserID` is a real buyer (this
 *      happens on outbound messages where the seller is sender), use that.
 *   2. Body-text extraction ("Dear John,", "John has opened a case...").
 *   3. MarketplaceSaleOrder lookup by extracted order number.
 *   4. Give up — return all-nulls so the caller can decide what to do.
 *
 * The function is async only because (3) hits the DB. (1) and (2) are sync
 * and run first, so the common case stays cheap.
 */
export async function resolveBuyer(args: {
  body: EbayMessageBody;
  integration: Integration;
  orderNumber: string | null;
}): Promise<ResolvedBuyer> {
  const { body, integration, orderNumber } = args;
  const sellerUserId = getSellerUserId(integration);

  // 1) Header lookup.
  const senderClean = body.sender?.trim() || null;
  const recipientClean = body.recipientUserID?.trim() || null;

  if (senderClean && !isSystemOrSellerSender(senderClean, sellerUserId)) {
    return {
      buyerUserId: senderClean,
      buyerName: senderClean,
      buyerEmail: null,
      source: "header",
    };
  }
  if (recipientClean && !isSystemOrSellerSender(recipientClean, sellerUserId)) {
    return {
      buyerUserId: recipientClean,
      buyerName: recipientClean,
      buyerEmail: null,
      source: "header",
    };
  }

  // 2) Body-text extraction.
  const fromBody = extractBuyerFromBody(body.text);
  if (fromBody && !isSystemOrSellerSender(fromBody, sellerUserId)) {
    return {
      buyerUserId: fromBody,
      buyerName: fromBody,
      buyerEmail: null,
      source: "body",
    };
  }

  // 3) Sale-order fallback.
  const fromOrder = await resolveBuyerFromSaleOrder(integration.platform, orderNumber);
  if (fromOrder?.userId) {
    return {
      buyerUserId: fromOrder.userId,
      buyerName: fromOrder.label,
      buyerEmail: fromOrder.email,
      source: "saleOrder",
    };
  }

  // 4) No confident match.
  return {
    buyerUserId: null,
    buyerName: null,
    buyerEmail: null,
    source: "none",
  };
}

/**
 * Resolve a buyer for a single sub-message extracted from an eBay digest
 * (see `ebay-digest-parser.ts`). The parser gives us per-message direction
 * but the underlying `EbayMessageBody` headers describe only the *envelope*
 * (the email itself), not the individual history entries inside it.
 *
 * Resolution order:
 *
 *   1. If the digest HTML contains a `/usr/<x>` link that isn't the seller
 *      or "eBay", trust it — that's the buyer's handle.
 *   2. Otherwise, fall back to the standard envelope-level `resolveBuyer`
 *      (which also tries body-text salutations and MarketplaceSaleOrder).
 *
 * The whole point is that the same buyer should be attributed to *every*
 * historical sub-message in the digest, regardless of which side sent
 * which row. We just need one good attribution and we use it for the lot.
 */
export async function resolveBuyerForDigest(args: {
  body: EbayMessageBody;
  integration: Integration;
  orderNumber: string | null;
  digestHtml: string | null | undefined;
}): Promise<ResolvedBuyer> {
  const sellerUserId = getSellerUserId(args.integration);
  const fromDigest = extractBuyerFromDigestHtml(args.digestHtml, sellerUserId);
  if (fromDigest) {
    return {
      buyerUserId: fromDigest,
      buyerName: fromDigest,
      buyerEmail: null,
      source: "header",
    };
  }
  return resolveBuyer({
    body: args.body,
    integration: args.integration,
    orderNumber: args.orderNumber,
  });
}
