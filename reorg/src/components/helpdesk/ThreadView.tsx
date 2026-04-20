"use client";

/**
 * eDesk-style threaded conversation view.
 *
 * Layout grammar (mirrors eDesk):
 *   - Buyer (INBOUND) messages float to the LEFT, agent (OUTBOUND) messages
 *     float to the RIGHT, each in their own colored bubble.
 *   - System rows ("System changed status to Waiting", "Adam Zinker opened
 *     the ticket", "Buyer opened a return on eBay") render as centered
 *     horizontal pills between bubbles.
 *   - Internal notes render as full-width amber cards (notes are an internal
 *     primitive — they have no analogue in eDesk, so we keep them obvious).
 *
 * Bubble structure:
 *   [avatar]  ┌──────────────────────────────────┐  [timestamp]
 *             │  Sender name · marketplace badge │
 *             │  …message body…                  │
 *             │  (translate links)               │
 *             └──────────────────────────────────┘
 *   …reversed for outbound.
 *
 * System events come from a separate /events endpoint that interprets
 * AuditLog rows tagged to this ticket — see the route docstring for the
 * supported action vocabulary.
 */

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Loader2,
  MessageSquareText,
  StickyNote,
  Languages,
  CheckCircle2,
  AlertTriangle,
  Tag as TagIcon,
  UserCog,
  Eye,
  Filter as FilterIcon,
  Inbox as InboxIcon,
  ShieldAlert,
  Archive as ArchiveIcon,
  ShoppingCart,
  Truck,
} from "lucide-react";
import type { HelpdeskTicketDetail, HelpdeskSyncStatus } from "@/hooks/use-helpdesk";
import { Composer } from "@/components/helpdesk/Composer";
import { Attachments } from "@/components/helpdesk/Attachments";
import { Avatar } from "@/components/ui/avatar";
import { SafeHtml } from "@/components/helpdesk/SafeHtml";

interface ThreadViewProps {
  ticket: HelpdeskTicketDetail | null;
  loading: boolean;
  safeMode: boolean;
  syncStatus: HelpdeskSyncStatus | null;
  onSent: () => void;
  /**
   * When false (the default), the ThreadView renders its own header strip
   * with subject + buyer + item link. When the new in-place Reader is hosting
   * the thread it provides its own header chrome and we hide ours to avoid
   * duplication.
   */
  showHeader?: boolean;
}

/** System events returned by /api/helpdesk/tickets/[id]/events. */
type SystemEventKind =
  | "open"
  | "status"
  | "assign"
  | "tag"
  | "spam"
  | "archive"
  | "filter"
  | "case"
  | "read"
  | "order_received"
  | "order_shipped";

interface SystemEvent {
  id: string;
  type: "system";
  action: string;
  kind: SystemEventKind;
  text: string;
  actor: {
    id: string;
    name: string | null;
    email: string | null;
    handle: string | null;
    avatarUrl: string | null;
  } | null;
  at: string;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildTranslateUrl(text: string, target: "es" | "en"): string {
  const source = target === "es" ? "en" : "es";
  return `https://translate.google.com/?sl=${source}&tl=${target}&text=${encodeURIComponent(
    text,
  )}&op=translate`;
}

const SYSTEM_ICON: Record<SystemEventKind, typeof Eye> = {
  open: Eye,
  status: CheckCircle2,
  assign: UserCog,
  tag: TagIcon,
  spam: ShieldAlert,
  archive: ArchiveIcon,
  filter: FilterIcon,
  case: AlertTriangle,
  read: InboxIcon,
  // eDesk uses small marketplace logos for these. We use semantic icons —
  // ShoppingCart for "order received" and Truck for "order shipped" — and
  // tint them with the brand colour to make them stand out from agent
  // actions in the timeline.
  order_received: ShoppingCart,
  order_shipped: Truck,
};

/**
 * eDesk-style "natural language" date label. Today / Yesterday /
 * "Mon, Apr 7" / "Apr 7, 2024" depending on how far back the date sits.
 */
function formatDayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff =
    (startOfDay(now) - startOfDay(d)) / (24 * 60 * 60 * 1000);
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Just the time portion: "07:39 PM". Used inside chat bubbles. */
function formatTimeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ThreadView({
  ticket,
  loading,
  safeMode,
  syncStatus,
  onSent,
  showHeader = true,
}: ThreadViewProps) {
  // safeMode is shown by Composer; suppressed here to avoid duplication.
  void safeMode;

  // Fetch system events whenever the ticket changes. We deliberately run a
  // fresh fetch per ticket id (and re-run on `ticket.id` change) instead of
  // caching across tickets — system events are small and the agent expects
  // them to feel "live".
  const ticketId = ticket?.id ?? null;
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  useEffect(() => {
    if (!ticketId) {
      setEvents([]);
      return;
    }
    const ac = new AbortController();
    setEventsLoading(true);
    fetch(`/api/helpdesk/tickets/${ticketId}/events`, {
      signal: ac.signal,
      credentials: "same-origin",
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((payload: { data: SystemEvent[] }) => {
        // Defensive: ensure shape before committing to state.
        if (Array.isArray(payload?.data)) {
          setEvents(payload.data);
        }
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Soft-fail: timeline still works without system rows. Log so we
        // notice in dev tools, but don't break the reader pane.
        // eslint-disable-next-line no-console
        console.warn("Failed to load helpdesk events", err);
      })
      .finally(() => setEventsLoading(false));
    return () => ac.abort();
  }, [ticketId]);

  // Combine messages, notes and system events into a single sorted timeline.
  const items = useMemo(() => {
    if (!ticket) return [];
    type Item =
      | { type: "message"; data: (typeof ticket.messages)[number]; at: string }
      | { type: "note"; data: (typeof ticket.notes)[number]; at: string }
      | { type: "system"; data: SystemEvent; at: string };
    const merged: Item[] = [
      ...ticket.messages.map((m) => ({ type: "message" as const, data: m, at: m.sentAt })),
      ...ticket.notes.map((n) => ({ type: "note" as const, data: n, at: n.createdAt })),
      ...events.map((e) => ({ type: "system" as const, data: e, at: e.at })),
    ];
    return merged.sort(
      (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
    );
  }, [ticket, events]);

  // ─────────────────────────────────────────────────────────────────────────
  // Lazy thread expansion (eDesk parity).
  //
  // Long threads with 10+ eBay HTML messages spend 4–7 seconds running
  // DOMPurify + DOM walks on the body of every single message during the
  // initial mount. That work is unavoidable for messages the agent actually
  // sees, but it's wasteful for older messages they almost never scroll back
  // to. eDesk shows the latest few messages and offers a "show earlier
  // messages" affordance — replicating that here cuts the open click latency
  // dramatically on heavy threads while keeping the most recent context
  // visible immediately.
  //
  // Notes / system events are tiny to render and don't trigger SafeHtml at
  // all, so we count only `message` items toward the threshold. Older items
  // (messages, notes, system events alike) get hidden behind the toggle to
  // preserve chronological grouping — clicking expand reveals everything.
  // ─────────────────────────────────────────────────────────────────────────
  const INITIAL_MESSAGE_LIMIT = 5;
  const messageCount = items.reduce(
    (n, it) => n + (it.type === "message" ? 1 : 0),
    0,
  );
  const [expanded, setExpanded] = useState(false);
  // Reset to collapsed whenever we open a different ticket.
  useEffect(() => {
    setExpanded(false);
  }, [ticketId]);
  // Find the index of the (messageCount - INITIAL_MESSAGE_LIMIT)-th message
  // counting from the start. Everything before that index gets hidden.
  let firstShownIndex = 0;
  if (!expanded && messageCount > INITIAL_MESSAGE_LIMIT) {
    let messagesSeen = 0;
    const messagesToHide = messageCount - INITIAL_MESSAGE_LIMIT;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i]!.type === "message") {
        messagesSeen += 1;
        if (messagesSeen > messagesToHide) {
          firstShownIndex = i;
          break;
        }
      }
    }
  }
  const visibleItems = items.slice(firstShownIndex);
  const hiddenCount = items.length - visibleItems.length;

  if (loading && !ticket) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!ticket) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center text-muted-foreground">
        <MessageSquareText className="h-10 w-10 opacity-30" />
        <p className="text-sm">Select a ticket to view the conversation.</p>
      </div>
    );
  }

  return (
    // `min-h-0` is critical here. ThreadView is a `flex-1` flex column hosted
    // inside another flex column (TicketReader → HelpdeskSplit pane). Without
    // `min-h-0` the implicit `min-height: auto` lets the column grow to fit
    // its content, which means our inner `overflow-y-auto` block never has a
    // bounded height and the message list cannot scroll. This was the "list
    // view, can't scroll" bug.
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {showHeader && (
        <div className="shrink-0 border-b border-hairline bg-card px-5 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-foreground">
              {ticket.subject ?? ticket.ebayItemTitle ?? "(no subject)"}
            </h3>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {ticket.buyerName ?? ticket.buyerUserId ?? "Unknown buyer"}
              </span>
              <span className="px-1.5 text-muted-foreground/60">·</span>
              {ticket.integrationLabel}
              {ticket.ebayOrderNumber && (
                <>
                  <span className="px-1.5 text-muted-foreground/60">·</span>
                  Order #{ticket.ebayOrderNumber}
                </>
              )}
            </p>
          </div>
        </div>
      )}

      {/* Timeline. `min-h-0` lets this child actually shrink so its
       * `overflow-y-auto` engages (see the comment on the parent). */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-background px-4 py-4 sm:px-6">
        {items.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            {eventsLoading ? "Loading conversation…" : "No messages yet."}
          </p>
        ) : (
          <ol className="mx-auto flex max-w-3xl flex-col gap-3">
            {hiddenCount > 0 && (
              <li className="flex justify-center">
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="cursor-pointer rounded-full border border-hairline bg-surface px-3 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
                  title="Render the rest of this thread"
                >
                  Show {hiddenCount} earlier {hiddenCount === 1 ? "item" : "items"}
                </button>
              </li>
            )}
            {(() => {
              // Inject a centered "date" pill whenever the calendar day
              // changes between consecutive items. eDesk does this and it
              // makes a long thread far easier to scan.
              const rendered: React.ReactNode[] = [];
              let lastDayKey: string | null = null;
              for (const item of visibleItems) {
                const dayKey = new Date(item.at).toDateString();
                if (dayKey !== lastDayKey) {
                  lastDayKey = dayKey;
                  rendered.push(
                    <li
                      key={`day-${dayKey}`}
                      className="my-2 flex items-center justify-center gap-3"
                    >
                      <span className="h-px flex-1 max-w-[28%] bg-hairline" />
                      <span className="rounded-full bg-surface px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {formatDayLabel(item.at)}
                      </span>
                      <span className="h-px flex-1 max-w-[28%] bg-hairline" />
                    </li>,
                  );
                }
                rendered.push(renderItem(item));
              }
              return rendered;
            })()}
          </ol>
        )}
      </div>

      <Composer ticket={ticket} syncStatus={syncStatus} onSent={onSent} />
    </div>
  );

  /**
   * Per-item renderer extracted so we can interleave date separators above
   * without growing the JSX nesting unmanageably.
   */
  function renderItem(
    item:
      | {
          type: "message";
          data: NonNullable<HelpdeskTicketDetail["messages"][number]>;
          at: string;
        }
      | {
          type: "note";
          data: NonNullable<HelpdeskTicketDetail["notes"][number]>;
          at: string;
        }
      | { type: "system"; data: SystemEvent; at: string },
  ): React.ReactNode {
      if (item.type === "system") {
                const ev = item.data;
                const Icon = SYSTEM_ICON[ev.kind];
                const isOrderEvent =
                  ev.kind === "order_received" || ev.kind === "order_shipped";
                return (
                  <li
                    key={`sys-${ev.id}`}
                    className="my-1 flex items-center justify-center gap-3"
                  >
                    <span className="h-px flex-1 max-w-[20%] bg-hairline" />
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px]",
                        isOrderEvent
                          ? "border-brand/30 bg-brand-muted text-foreground"
                          : "border-hairline bg-surface text-muted-foreground",
                      )}
                    >
                      <Icon
                        className={cn(
                          "h-3 w-3",
                          isOrderEvent && "text-brand",
                        )}
                      />
                      <span
                        className={cn(
                          isOrderEvent
                            ? "font-semibold text-foreground"
                            : "text-foreground/80",
                        )}
                      >
                        {ev.text}
                      </span>
                      <span className="opacity-60">·</span>
                      <span className="tabular-nums">
                        {formatTimeOnly(ev.at)}
                      </span>
                    </span>
                    <span className="h-px flex-1 max-w-[20%] bg-hairline" />
                  </li>
                );
              }
              if (item.type === "note") {
                const n = item.data;
                return (
                  <li
                    key={`note-${n.id}`}
                    className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2"
                  >
                    <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-300">
                      <Avatar user={n.author} size="xs" />
                      <StickyNote className="h-3 w-3" />
                      Internal note · {n.author.name ?? n.author.email ?? "Agent"} ·{" "}
                      {formatDateTime(n.createdAt)}
                      {n.editedAt && <span className="opacity-60">(edited)</span>}
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-foreground">
                      {n.bodyText}
                    </p>
                  </li>
                );
              }

      const m = item.data;
      const isInbound = m.direction === "INBOUND";
      const isEbayUi = m.source === "EBAY_UI";
      const displayName =
        m.fromName ?? m.fromIdentifier ?? (isInbound ? "Buyer" : "Agent");
      const avatarUser = m.author ?? {
        id: m.fromIdentifier ?? `buyer:${displayName}`,
        name: displayName,
        email: null,
      };
      // eDesk-style layout: avatar on the side, header row with name +
      // timestamp, then a flat card with the body. We deliberately drop
      // the heavy shadow / large rounded "iMessage" look — eDesk uses thin
      // hairline cards and the agent reads the conversation like email,
      // not like a phone chat. Small bubble round + tighter padding keeps
      // the long buyer/agent threads compact.
      return (
        <li key={`msg-${m.id}`} className="group/msg flex gap-3">
          <div className="shrink-0 pt-0.5">
            <Avatar user={avatarUser} size="sm" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span
                className={cn(
                  "truncate text-[13px] font-semibold",
                  isInbound ? "text-foreground" : "text-brand",
                )}
              >
                {displayName}
              </span>
              {isEbayUi && (
                <span
                  className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300"
                  title="Sent directly on eBay (not from reorG)"
                >
                  via eBay
                </span>
              )}
              <span
                className="text-[11px] tabular-nums text-muted-foreground"
                title={formatDateTime(m.sentAt)}
              >
                {formatTimeOnly(m.sentAt)}
              </span>
              {/* Translate links live in the header row at very low
                * emphasis so they don't take up a full row at the bottom of
                * every message — only become visible on hover. */}
              <span className="ml-auto flex items-center gap-2 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
                <a
                  href={buildTranslateUrl(m.bodyText, "en")}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                  title="Open in Google Translate (to English)"
                >
                  <Languages className="h-3 w-3" /> EN
                </a>
                <a
                  href={buildTranslateUrl(m.bodyText, "es")}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                  title="Open in Google Translate (to Spanish)"
                >
                  <Languages className="h-3 w-3" /> ES
                </a>
              </span>
            </div>
            <div
              className={cn(
                // Flat card. Hairline border + small radius. No shadow,
                // no gradient, no oversized padding — matches eDesk's
                // density. A 4-px accent strip on the left edge of the
                // card (brand colour for outbound, neutral for inbound)
                // gives quick visual separation between sender roles
                // without dominating the layout.
                "rounded-md border border-hairline bg-card px-3 py-2 text-[13px] leading-[1.5]",
                isInbound
                  ? "border-l-[3px] border-l-slate-300 dark:border-l-slate-600"
                  : "border-l-[3px] border-l-brand/70 bg-brand-muted/40",
              )}
            >
              {/*
                Always go through SafeHtml. eBay's GetMyMessages payloads
                arrive with `isHtml=false` even when the body is a full
                `<!DOCTYPE html>` document (the API only sets the flag for
                bodies their UI composer marked as rich text). SafeHtml
                sniffs the body itself and falls back to a `<pre>` when it
                really is plain text.
              */}
              <SafeHtml html={m.bodyText} forceHtml={m.isHtml} />
              <Attachments rawMedia={m.rawMedia} />
            </div>
          </div>
        </li>
      );
  }
}
