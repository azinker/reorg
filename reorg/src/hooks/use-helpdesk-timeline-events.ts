"use client";

import { useEffect, useState } from "react";
import type { HelpdeskTimelineEvent } from "@/lib/helpdesk/conversation-summary";

interface EventsResponse {
  data?: HelpdeskTimelineEvent[];
}

interface UseHelpdeskTimelineEventsResult {
  data: HelpdeskTimelineEvent[];
  loading: boolean;
  error: string | null;
}

const EMPTY_EVENTS: HelpdeskTimelineEvent[] = [];

/**
 * One module-level cache shared by every consumer (ThreadView,
 * ContextPanel, Composer). The /events endpoint is the single most
 * expensive helpdesk read, and three components mount it on every
 * ticket open — so concurrent requests are deduped into one in-flight
 * fetch, and a short TTL stops a re-open from refetching data that was
 * loaded moments ago.
 */
const timelineEventsCache = new Map<
  string,
  { data: HelpdeskTimelineEvent[]; fetchedAt: number }
>();
const inflightEvents = new Map<string, Promise<HelpdeskTimelineEvent[]>>();
const EVENTS_TTL_MS = 15_000;

function loadTimelineEvents(ticketId: string): Promise<HelpdeskTimelineEvent[]> {
  const existing = inflightEvents.get(ticketId);
  if (existing) return existing;
  const promise = (async () => {
    const res = await fetch(`/api/helpdesk/tickets/${ticketId}/events`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as EventsResponse;
    const next = Array.isArray(json.data) ? json.data : [];
    timelineEventsCache.set(ticketId, { data: next, fetchedAt: Date.now() });
    return next;
  })().finally(() => {
    inflightEvents.delete(ticketId);
  });
  inflightEvents.set(ticketId, promise);
  return promise;
}

export function useHelpdeskTimelineEvents(
  ticketId: string | null | undefined,
): UseHelpdeskTimelineEventsResult {
  const cached = ticketId ? timelineEventsCache.get(ticketId) : undefined;
  const [state, setState] = useState<{
    ticketId: string | null;
    data: HelpdeskTimelineEvent[];
  }>({ ticketId: ticketId ?? null, data: cached?.data ?? EMPTY_EVENTS });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data =
    state.ticketId === (ticketId ?? null)
      ? state.data
      : cached?.data ?? EMPTY_EVENTS;

  useEffect(() => {
    if (!ticketId) {
      setState({ ticketId: null, data: EMPTY_EVENTS });
      setLoading(false);
      setError(null);
      return;
    }

    const cachedForTicket = timelineEventsCache.get(ticketId);
    setState({ ticketId, data: cachedForTicket?.data ?? EMPTY_EVENTS });
    setError(null);

    // Fresh enough — paint from cache and skip the network round-trip
    // entirely. Stale (or missing) cache still paints immediately, then
    // revalidates in the background.
    if (cachedForTicket && Date.now() - cachedForTicket.fetchedAt < EVENTS_TTL_MS) {
      setLoading(false);
      return;
    }

    setLoading(!cachedForTicket);
    let cancelled = false;
    void loadTimelineEvents(ticketId)
      .then((next) => {
        if (cancelled) return;
        setState({ ticketId, data: next });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  return { data, loading, error };
}
