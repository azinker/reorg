/**
 * Shared in-memory cache for eBay order context lookups used by the Help Desk.
 *
 * Two endpoints fetch the same order context for a given ticket:
 *   1. /api/helpdesk/tickets/[id]/order-context  (right-rail Context Panel)
 *   2. /api/helpdesk/tickets/[id]/events         (timeline order_received /
 *                                                 order_shipped synthesis)
 *
 * Without a shared cache, opening a single ticket fired two parallel calls
 * to eBay's Trading API — each ~1-3s — which made the reader feel like it
 * was loading on a 56k modem. This module centralises the cache so the
 * second call almost always hits memory.
 *
 * It also exposes a `getOrderContextCached` helper that:
 *   - Serves from cache if fresh
 *   - Returns `undefined` if not cached AND `awaitFresh` is false (so the
 *     events route can render quickly with whatever is already known and
 *     let the right-rail trigger the populating fetch)
 *   - Performs and caches a fresh fetch if `awaitFresh` is true
 *
 * Process-wide; multi-instance deploys each carry their own copy. A stale
 * read is a UX nit, not a correctness issue.
 */

import {
  fetchEbayOrderContext,
  type EbayConfig,
  type EbayOrderContext,
} from "./auto-responder-ebay";

interface CacheEntry {
  expiresAt: number;
  value: EbayOrderContext | null;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function key(integrationId: string, orderId: string): string {
  return `${integrationId}:${orderId}`;
}

function readFresh(k: string): EbayOrderContext | null | undefined {
  const hit = cache.get(k);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    cache.delete(k);
    return undefined;
  }
  return hit.value;
}

export function readOrderContextCache(
  integrationId: string,
  orderId: string,
): EbayOrderContext | null | undefined {
  return readFresh(key(integrationId, orderId));
}

export function writeOrderContextCache(
  integrationId: string,
  orderId: string,
  value: EbayOrderContext | null,
): void {
  cache.set(key(integrationId, orderId), {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Get order context, optionally awaiting a fresh fetch on cache miss.
 *
 * `awaitFresh = true`  → behaves like the old order-context route: cache
 *                        first, fall back to a live fetch (1-3s typical).
 * `awaitFresh = false` → returns `undefined` on cache miss so the caller
 *                        can render immediately. Use this from the events
 *                        route so opening a ticket doesn't double-hit eBay.
 */
export async function getOrderContextCached(
  integrationId: string,
  config: EbayConfig,
  orderId: string,
  options: { awaitFresh: boolean } = { awaitFresh: true },
): Promise<EbayOrderContext | null | undefined> {
  const cached = readOrderContextCache(integrationId, orderId);
  if (cached !== undefined) return cached;
  if (!options.awaitFresh) return undefined;

  try {
    const ctx = await fetchEbayOrderContext(integrationId, config, orderId);
    writeOrderContextCache(integrationId, orderId, ctx);
    return ctx;
  } catch (err) {
    console.warn(
      "[helpdesk-order-context-cache] live fetch failed",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
