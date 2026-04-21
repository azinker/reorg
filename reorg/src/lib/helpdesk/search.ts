/**
 * Help Desk inbox search resolver.
 *
 * Pure logic — no Prisma, no DB. Returns the Prisma `WhereInput` clause that
 * the inbox route should AND with the active folder filter.
 *
 * Two acceptable input shapes:
 *
 *   - eBay Order ID:  `NN-NNNNN-NNNNN` (12 digits + 2 hyphens). We do an
 *     EXACT case-insensitive match against `ebayOrderNumber`. This is the
 *     only field eBay uses for the order id; substring matching here would
 *     accidentally collide with sales record numbers (e.g. "5141775" being
 *     a substring of "19-14450-91775"), which is a known operator footgun.
 *
 *   - Buyer username: anything else. Substring-match on `buyerUserId` and
 *     `buyerName` (the public display name shown on the message header —
 *     agents type either when hunting for a known buyer).
 *
 * Inputs that don't match either shape (e.g. a 7-digit sales record number)
 * fall through to the username branch and return zero results — which is
 * the correct behavior. Sales records are intentionally NOT searchable.
 */

import type { Prisma } from "@prisma/client";

const ORDER_ID_RE = /^\d{2}-\d{5}-\d{5}$/;

export type HelpdeskSearchKind = "order_id" | "username";

export interface HelpdeskSearchResolution {
  kind: HelpdeskSearchKind;
  /** The normalized query string we'll match against. */
  query: string;
  /** Prisma `WhereInput` clause to AND with the folder filter. */
  where: Prisma.HelpdeskTicketWhereInput;
}

/**
 * Resolve the search input into a Prisma where clause.
 * Returns `null` when the input is empty (caller should skip search filtering).
 */
export function resolveHelpdeskSearch(
  raw: string | null | undefined,
): HelpdeskSearchResolution | null {
  if (!raw) return null;
  const query = raw.trim();
  if (!query) return null;

  if (ORDER_ID_RE.test(query)) {
    return {
      kind: "order_id",
      query,
      where: { ebayOrderNumber: { equals: query, mode: "insensitive" } },
    };
  }

  return {
    kind: "username",
    query,
    where: {
      OR: [
        { buyerUserId: { contains: query, mode: "insensitive" } },
        { buyerName: { contains: query, mode: "insensitive" } },
      ],
    },
  };
}

/** Exposed for tests so we can pin the order-id shape exactly. */
export const HELPDESK_ORDER_ID_PATTERN = ORDER_ID_RE;
