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

const timelineEventsCache = new Map<string, HelpdeskTimelineEvent[]>();

export function useHelpdeskTimelineEvents(
  ticketId: string | null | undefined,
): UseHelpdeskTimelineEventsResult {
  const cached = ticketId ? timelineEventsCache.get(ticketId) : undefined;
  const [state, setState] = useState<{
    ticketId: string | null;
    data: HelpdeskTimelineEvent[];
  }>({ ticketId: ticketId ?? null, data: cached ?? [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = state.ticketId === (ticketId ?? null) ? state.data : cached ?? [];

  useEffect(() => {
    if (!ticketId) {
      setState({ ticketId: null, data: [] });
      setLoading(false);
      setError(null);
      return;
    }

    const cachedForTicket = timelineEventsCache.get(ticketId);
    setState({ ticketId, data: cachedForTicket ?? [] });
    setLoading(!cachedForTicket);
    setError(null);

    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/api/helpdesk/tickets/${ticketId}/events`, {
          cache: "no-store",
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as EventsResponse;
        const next = Array.isArray(json.data) ? json.data : [];
        if (ac.signal.aborted) return;
        timelineEventsCache.set(ticketId, next);
        setState({ ticketId, data: next });
      } catch (err) {
        if (ac.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();

    return () => ac.abort();
  }, [ticketId]);

  return { data, loading, error };
}
