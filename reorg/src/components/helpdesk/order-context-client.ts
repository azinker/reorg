"use client";

/**
 * Shared client-side fetch for /api/helpdesk/tickets/[id]/order-context.
 *
 * Both the Context Panel (full order card) and the Composer (tracking
 * number for {{trackingNumber}} template tokens) need this payload on
 * ticket open. Each used to fire its own request; this module dedupes
 * concurrent calls into one in-flight fetch and serves a short-TTL
 * cache so a re-open moments later doesn't refetch identical data.
 *
 * The server keeps its own 5-minute order-context cache, so the TTL
 * here only exists to avoid redundant HTTP round-trips — staleness is
 * bounded by the server cache either way.
 */

const TTL_MS = 15_000;

const inflight = new Map<string, Promise<unknown>>();
const recent = new Map<string, { json: unknown; fetchedAt: number }>();

export async function fetchOrderContextShared(ticketId: string): Promise<unknown> {
  const cached = recent.get(ticketId);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.json;

  const pending = inflight.get(ticketId);
  if (pending) return pending;

  const promise = (async () => {
    const res = await fetch(`/api/helpdesk/tickets/${ticketId}/order-context`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: unknown = await res.json();
    recent.set(ticketId, { json, fetchedAt: Date.now() });
    return json;
  })().finally(() => {
    inflight.delete(ticketId);
  });
  inflight.set(ticketId, promise);
  return promise;
}
