"use client";

/**
 * Help Desk thread view (v2).
 *
 * Layout grammar:
 *   - BUYER (INBOUND) messages float to the LEFT.
 *       avatar = first letter of buyer name on a neutral circle
 *       bubble = neutral surface, hairline border
 *   - AGENT (OUTBOUND, source != AUTO_RESPONDER) messages float to the RIGHT.
 *       avatar = author's <Avatar/> with initials, brand-tinted ring
 *       bubble = brand-tinted (purple) surface, brand border
 *   - AUTO RESPONDER messages float to the RIGHT, distinguished by:
 *       avatar = Bot icon on a brand-muted circle
 *       label  = "Auto Responder" instead of agent name
 *       bubble = same brand tint but with a dashed border to signal automation
 *   - INTERNAL NOTES are full-width amber/post-it cards (always inline).
 *   - SYSTEM EVENTS render as centered horizontal pills between bubbles.
 *
 * Behavioural notes vs. v1:
 *   - The thread is ALWAYS expanded — no "show earlier items" toggle. We
 *     pay the SafeHtml cost up front because the user reported the toggle
 *     felt jarring on long support exchanges.
 *   - Virtualised with @tanstack/react-virtual so a 200-message thread
 *     stays smooth even on a Chromebook. Item heights are dynamic;
 *     `measureElement` lets the virtualiser learn each row's actual size.
 *   - Timestamps render as relative ("3 minutes ago", "2 days ago") with
 *     the full localised datetime in a tooltip on hover.
 *   - Embedded images: any image attachment renders inline in the bubble
 *     as a thumbnail; clicking opens the full image in a new tab. Other
 *     attachments still go through the existing Attachments component.
 *   - System event pill set is expanded to cover the new eBay action
 *     timeline rows (case/feedback/cancel/refund) emitted by the
 *     /events route after the eBay action workers landed.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Loader2,
  MessageSquareText,
  StickyNote,
  CheckCircle2,
  AlertTriangle,
  Tag as TagIcon,
  UserCog,
  AtSign,
  Eye,
  Filter as FilterIcon,
  Inbox as InboxIcon,
  ShieldAlert,
  Archive as ArchiveIcon,
  ShoppingCart,
  Truck,
  Bot,
  Star,
  XCircle,
  DollarSign,
  RotateCcw,
  Clock,
  CircleDashed,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  showHeader?: boolean;
}

/** System events returned by /api/helpdesk/tickets/[id]/events. */
type SystemEventKind =
  | "open"
  | "status"
  | "type"
  | "assign"
  | "mention"
  | "tag"
  | "spam"
  | "archive"
  | "filter"
  | "snooze"
  | "case"
  | "feedback"
  | "cancel"
  | "refund"
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

// ─── Time formatters ────────────────────────────────────────────────────────

const REL_FORMAT = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * Human-friendly relative time ("3 minutes ago", "yesterday", "in 5 days").
 * We pick the largest unit that comes out >= 1 so the label stays
 * compact. Past dates show as "n unit ago", future dates as "in n unit".
 */
function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.round((then - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return REL_FORMAT.format(diffSec, "second");
  if (abs < 60 * 45) return REL_FORMAT.format(Math.round(diffSec / 60), "minute");
  if (abs < 3600 * 22) return REL_FORMAT.format(Math.round(diffSec / 3600), "hour");
  if (abs < 86400 * 6) return REL_FORMAT.format(Math.round(diffSec / 86400), "day");
  if (abs < 86400 * 27) return REL_FORMAT.format(Math.round(diffSec / 86400 / 7), "week");
  if (abs < 86400 * 320)
    return REL_FORMAT.format(Math.round(diffSec / 86400 / 30), "month");
  return REL_FORMAT.format(Math.round(diffSec / 86400 / 365), "year");
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

function formatDayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = (startOfDay(now) - startOfDay(d)) / (24 * 60 * 60 * 1000);
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

// ─── System event styling ───────────────────────────────────────────────────

const SYSTEM_ICON: Record<SystemEventKind, typeof Eye> = {
  open: Eye,
  status: CheckCircle2,
  type: TagIcon,
  assign: UserCog,
  mention: AtSign,
  tag: TagIcon,
  spam: ShieldAlert,
  archive: ArchiveIcon,
  filter: FilterIcon,
  snooze: Clock,
  case: AlertTriangle,
  feedback: Star,
  cancel: XCircle,
  refund: DollarSign,
  read: InboxIcon,
  order_received: ShoppingCart,
  order_shipped: Truck,
};

/**
 * Tone classes per event kind. Three buckets:
 *   - urgent (red-ish)  for negative buyer escalations
 *   - brand   (purple)  for marketplace-positive events (orders, feedback+)
 *   - neutral (gray)    for everything else
 *
 * Returning the className inline (instead of via a separate stylesheet)
 * keeps the per-event customisation co-located with the event vocabulary.
 */
function classForEventKind(kind: SystemEventKind): string {
  switch (kind) {
    case "case":
    case "cancel":
    case "spam":
      return "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    case "feedback":
      return "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200";
    case "refund":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "order_received":
    case "order_shipped":
      return "border-brand/40 bg-brand-muted text-foreground";
    case "type":
    case "status":
    case "assign":
    case "mention":
      return "border-brand/30 bg-brand-muted/60 text-foreground";
    default:
      return "border-hairline bg-surface text-muted-foreground";
  }
}

// ─── Image extraction from message media ────────────────────────────────────

interface InlineImage {
  url: string;
  thumb: string | null;
}

/**
 * eBay's media payloads are heterogeneous (REST attachments, Trading-API
 * inline base64, and our own outbound envelope). Walk the structure and
 * pull anything that looks like an image. Fail silently on weird shapes —
 * an unmatched payload just falls through to the regular Attachments
 * component below the bubble.
 */
function extractInlineImages(rawMedia: unknown): InlineImage[] {
  if (!rawMedia) return [];
  const collected: InlineImage[] = [];
  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const mime =
      (typeof obj.mimeType === "string" && obj.mimeType) ||
      (typeof obj.contentType === "string" && obj.contentType) ||
      "";
    const isImage = mime.toLowerCase().startsWith("image/");
    const url =
      (typeof obj.url === "string" && obj.url) ||
      (typeof obj.href === "string" && obj.href) ||
      (typeof obj.downloadUrl === "string" && obj.downloadUrl) ||
      "";
    if (isImage && url) {
      const thumb =
        (typeof obj.thumbnailUrl === "string" && obj.thumbnailUrl) || null;
      collected.push({ url, thumb });
    }
    // Recurse into nested arrays/objects (eBay sometimes wraps attachments
    // under .attachments or .images).
    for (const value of Object.values(obj)) visit(value);
  };
  visit(rawMedia);
  // Dedupe by URL so deeply-nested payloads don't render the same image
  // multiple times.
  const seen = new Set<string>();
  return collected.filter((img) => {
    if (seen.has(img.url)) return false;
    seen.add(img.url);
    return true;
  });
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ThreadView({
  ticket,
  loading,
  safeMode,
  syncStatus,
  onSent,
  showHeader = true,
}: ThreadViewProps) {
  void safeMode;

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
        if (Array.isArray(payload?.data)) setEvents(payload.data);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // eslint-disable-next-line no-console
        console.warn("Failed to load helpdesk events", err);
      })
      .finally(() => setEventsLoading(false));
    return () => ac.abort();
  }, [ticketId]);

  // Build a single, day-bucketed timeline. Day separators get injected as
  // their own item type so the virtualiser treats them like any other row.
  type TimelineRow =
    | { kind: "day"; key: string; label: string; at: string }
    | {
        kind: "message";
        key: string;
        data: NonNullable<HelpdeskTicketDetail["messages"][number]>;
        at: string;
      }
    | {
        kind: "note";
        key: string;
        data: NonNullable<HelpdeskTicketDetail["notes"][number]>;
        at: string;
      }
    | {
        kind: "pending";
        key: string;
        data: NonNullable<
          HelpdeskTicketDetail["pendingOutboundJobs"]
        >[number];
        at: string;
      }
    | { kind: "system"; key: string; data: SystemEvent; at: string };

  const rows = useMemo<TimelineRow[]>(() => {
    if (!ticket) return [];
    type Item =
      | {
          kind: "message";
          data: NonNullable<HelpdeskTicketDetail["messages"][number]>;
          at: string;
        }
      | {
          kind: "note";
          data: NonNullable<HelpdeskTicketDetail["notes"][number]>;
          at: string;
        }
      | {
          kind: "pending";
          data: NonNullable<
            HelpdeskTicketDetail["pendingOutboundJobs"]
          >[number];
          at: string;
        }
      | { kind: "system"; data: SystemEvent; at: string };
    // Pending outbound jobs are slotted in as if they had already been
    // sent (using `scheduledAt` so they sit at the bottom of the thread
    // even if the agent hit Send a moment after a buyer reply landed).
    // Once the cron worker actually delivers them, the next sync turns
    // them into real HelpdeskMessage rows and the API stops returning
    // them in `pendingOutboundJobs` — at which point this transient
    // bubble is replaced by the permanent one. NOTE bubbles (composer
    // mode = NOTE) never go through the outbound queue, so we don't
    // need to worry about double-rendering them here.
    const pending = ticket.pendingOutboundJobs ?? [];
    const merged: Item[] = [
      ...ticket.messages.map((m) => ({ kind: "message" as const, data: m, at: m.sentAt })),
      ...ticket.notes.map((n) => ({ kind: "note" as const, data: n, at: n.createdAt })),
      ...pending.map((p) => ({ kind: "pending" as const, data: p, at: p.scheduledAt })),
      ...events.map((e) => ({ kind: "system" as const, data: e, at: e.at })),
    ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    const out: TimelineRow[] = [];
    let lastDayKey: string | null = null;
    for (const item of merged) {
      const dayKey = new Date(item.at).toDateString();
      if (dayKey !== lastDayKey) {
        lastDayKey = dayKey;
        out.push({
          kind: "day",
          key: `day-${dayKey}`,
          label: formatDayLabel(item.at),
          at: item.at,
        });
      }
      const baseKey =
        item.kind === "message"
          ? `msg-${item.data.id}`
          : item.kind === "note"
            ? `note-${item.data.id}`
            : item.kind === "pending"
              ? `pending-${item.data.id}`
              : `sys-${item.data.id}`;
      out.push({ ...item, key: baseKey } as TimelineRow);
    }
    return out;
  }, [ticket, events]);

  // ── Virtualiser setup ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Conservative default — most messages are short. measureElement below
    // refines this on real layout, so the only consequence of a wrong
    // estimate is a slightly less accurate scroll thumb on first render.
    estimateSize: () => 120,
    overscan: 6,
    getItemKey: (i) => rows[i]!.key,
  });

  // Auto-scroll to the bottom (latest message) when the ticket changes,
  // mirroring how chat clients behave. We do this *after* the virtualiser
  // has measured at least the first batch of rows so the scroll position
  // lands accurately.
  useEffect(() => {
    if (!ticketId || rows.length === 0) return;
    const id = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId, rows.length]);

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

  const virtualRows = virtualizer.getVirtualItems();

  return (
    // `min-h-0` on the outer flex column is mandatory — without it the
    // implicit `min-height: auto` lets the column grow to fit content and
    // the inner scroller never has a bounded height.
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

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto bg-background px-4 py-4 sm:px-6"
      >
        {rows.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            {eventsLoading ? "Loading conversation…" : "No messages yet."}
          </p>
        ) : (
          <div
            className="relative mx-auto w-full max-w-3xl"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualRows.map((vr) => {
              const row = rows[vr.index]!;
              return (
                <div
                  key={vr.key}
                  data-index={vr.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full pb-3"
                  style={{ transform: `translateY(${vr.start}px)` }}
                >
                  <TimelineItem
                    row={row}
                    buyerInitial={
                      (
                        ticket.buyerName?.trim() ||
                        ticket.buyerUserId?.trim() ||
                        "?"
                      )
                        .charAt(0)
                        .toUpperCase()
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Composer ticket={ticket} syncStatus={syncStatus} onSent={onSent} />
    </div>
  );
}

// ─── Row renderer ───────────────────────────────────────────────────────────

interface TimelineItemProps {
  row:
    | { kind: "day"; key: string; label: string; at: string }
    | {
        kind: "message";
        key: string;
        data: NonNullable<HelpdeskTicketDetail["messages"][number]>;
        at: string;
      }
    | {
        kind: "note";
        key: string;
        data: NonNullable<HelpdeskTicketDetail["notes"][number]>;
        at: string;
      }
    | {
        kind: "pending";
        key: string;
        data: NonNullable<HelpdeskTicketDetail["pendingOutboundJobs"]>[number];
        at: string;
      }
    | { kind: "system"; key: string; data: SystemEvent; at: string };
  buyerInitial: string;
}

function TimelineItem({ row, buyerInitial }: TimelineItemProps) {
  if (row.kind === "day") {
    return (
      <div className="my-2 flex items-center justify-center gap-3">
        <span className="h-px flex-1 max-w-[28%] bg-hairline" />
        <span className="rounded-full bg-surface px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {row.label}
        </span>
        <span className="h-px flex-1 max-w-[28%] bg-hairline" />
      </div>
    );
  }

  if (row.kind === "system") {
    const ev = row.data;
    const Icon = SYSTEM_ICON[ev.kind] ?? CircleDashed;
    return (
      <div className="my-1 flex items-center justify-center gap-3">
        <span className="h-px flex-1 max-w-[18%] bg-hairline" />
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px]",
            classForEventKind(ev.kind),
          )}
          title={formatDateTime(ev.at)}
        >
          <Icon className="h-3 w-3" />
          <span className="font-medium">{ev.text}</span>
          <span className="opacity-60">·</span>
          <span className="tabular-nums opacity-80">
            {formatRelativeTime(ev.at)}
          </span>
        </span>
        <span className="h-px flex-1 max-w-[18%] bg-hairline" />
      </div>
    );
  }

  if (row.kind === "pending") {
    const j = row.data;
    const scheduled = new Date(j.scheduledAt).getTime();
    const now = Date.now();
    const secondsLeft = Math.max(0, Math.round((scheduled - now) / 1000));
    const blocked = !!j.willBlockReason;
    // We render a right-aligned bubble that mimics the agent reply look
    // (purple, dashed border to signal "not yet committed"). When the
    // cron actually delivers the reply, the API stops returning this job
    // in `pendingOutboundJobs` and the next ticket-detail refetch
    // replaces this transient bubble with the permanent HelpdeskMessage.
    const statusLabel = blocked
      ? `Send blocked: ${j.willBlockReason}`
      : j.status === "SENDING"
        ? "Sending to eBay…"
        : secondsLeft > 0
          ? `Sending in ${secondsLeft}s`
          : "Sending…";
    return (
      <div className="group/msg flex flex-row-reverse gap-3">
        <div className="shrink-0 pt-0.5">
          {j.author ? (
            <Avatar user={j.author} size="sm" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-muted text-sm font-semibold text-brand">
              ?
            </div>
          )}
        </div>
        <div className="min-w-0 max-w-[80%] flex-1">
          <div className="mb-1 flex flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5">
            <span
              className={cn(
                "shrink-0 rounded border px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider",
                blocked
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : "border-brand/40 bg-brand-muted text-brand",
              )}
            >
              {statusLabel}
            </span>
            <span className="truncate text-[13px] font-semibold text-brand">
              {j.author?.name ?? j.author?.email ?? "Agent"}
            </span>
          </div>
          <div
            className={cn(
              "rounded-md border border-dashed px-3 py-2 text-[13px] leading-[1.5] opacity-90",
              blocked
                ? "border-amber-500/50 bg-amber-50 text-foreground dark:bg-amber-950/20"
                : "border-brand/50 bg-brand-muted/60 text-foreground",
            )}
          >
            <p className="whitespace-pre-wrap">{j.bodyText}</p>
          </div>
        </div>
      </div>
    );
  }

  if (row.kind === "note") {
    const n = row.data;
    return (
      <div
        className="rounded-md border border-amber-400/40 bg-amber-100 px-3 py-2 shadow-[1px_2px_0_rgba(0,0,0,0.04)] dark:bg-amber-950/30"
        // Slight tilt + paper-edge shadow give the note that "post-it"
        // affordance the user asked for. Kept very subtle so it doesn't
        // feel cartoonish in the rest of a clean dashboard.
      >
        <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-amber-800 dark:text-amber-200">
          <Avatar user={n.author} size="xs" />
          <StickyNote className="h-3 w-3" />
          <span>
            Internal note · {n.author.name ?? n.author.email ?? "Agent"}
          </span>
          <span className="opacity-70" title={formatDateTime(n.createdAt)}>
            · {formatRelativeTime(n.createdAt)}
          </span>
          {n.editedAt && <span className="opacity-60">(edited)</span>}
        </div>
        <p className="whitespace-pre-wrap text-[13px] text-amber-950 dark:text-amber-50">
          {n.bodyText}
        </p>
      </div>
    );
  }

  // ── Message bubble ──
  const m = row.data;
  const isInbound = m.direction === "INBOUND";
  const isAR = m.source === "AUTO_RESPONDER";
  const isEbayUi = m.source === "EBAY_UI";

  const displayName = isAR
    ? "Auto Responder"
    : m.fromName ?? m.fromIdentifier ?? (isInbound ? "Buyer" : "Agent");

  // Buyer bubbles use a generated avatar from the first letter of the
  // buyer's name. Agent bubbles use the real <Avatar/> with initials. AR
  // bubbles use a Bot icon on a brand-muted disc.
  const renderAvatar = () => {
    if (isAR) {
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-muted text-brand">
          <Bot className="h-4 w-4" />
        </div>
      );
    }
    if (isInbound) {
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-100">
          {buyerInitial}
        </div>
      );
    }
    if (m.author) {
      return <Avatar user={m.author} size="sm" />;
    }
    return (
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-muted text-sm font-semibold text-brand">
        {(displayName.charAt(0) || "?").toUpperCase()}
      </div>
    );
  };

  const inlineImages = extractInlineImages(m.rawMedia);

  // Right-aligned (agent / AR) vs left-aligned (buyer). We swap the row
  // direction with `flex-row-reverse` so the avatar always sits on the
  // outside edge and the bubble's "tail" (the colored left-border accent)
  // visually anchors to the speaker side.
  const sideClass = isInbound ? "" : "flex-row-reverse";
  const bubbleClass = isInbound
    ? "border-hairline bg-card text-foreground"
    : isAR
      ? "border-brand/40 border-dashed bg-brand-muted/60 text-foreground"
      : "border-brand/50 bg-brand-muted text-foreground";

  return (
    <div className={cn("group/msg flex gap-3", sideClass)}>
      <div className="shrink-0 pt-0.5">{renderAvatar()}</div>
      <div className="min-w-0 max-w-[80%] flex-1">
        <div
          className={cn(
            "mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5",
            !isInbound && "justify-end",
          )}
        >
          {!isInbound && (
            <span
              className="text-[11px] tabular-nums text-muted-foreground"
              title={formatDateTime(m.sentAt)}
            >
              {formatRelativeTime(m.sentAt)}
            </span>
          )}
          <span
            className={cn(
              "truncate text-[13px] font-semibold",
              isInbound
                ? "text-foreground"
                : isAR
                  ? "text-brand/80 italic"
                  : "text-brand",
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
          {isInbound && (
            <span
              className="text-[11px] tabular-nums text-muted-foreground"
              title={formatDateTime(m.sentAt)}
            >
              {formatRelativeTime(m.sentAt)}
            </span>
          )}
        </div>
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-[13px] leading-[1.5]",
            bubbleClass,
          )}
        >
          {/* SafeHtml sniffs the body itself and falls back to <pre> when
              eBay's `isHtml` flag is wrong (which it often is). */}
          <SafeHtml html={m.bodyText} forceHtml={m.isHtml} />

          {inlineImages.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {inlineImages.map((img) => (
                <a
                  key={img.url}
                  href={img.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block overflow-hidden rounded border border-hairline bg-surface transition-opacity hover:opacity-90"
                  title="Open image in a new tab"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.thumb ?? img.url}
                    alt=""
                    loading="lazy"
                    className="h-32 w-32 object-cover"
                  />
                </a>
              ))}
            </div>
          )}

          {/* Non-image attachments still surface through the existing
              Attachments component — keeps the file/PDF/zip handling
              centralized. */}
          <Attachments rawMedia={m.rawMedia} />
        </div>
      </div>
    </div>
  );
}

// Suppress unused import warning for the rotation icon — we may use it
// later for a "reopened" event variant; keep the import so that change is
// a one-line addition.
void RotateCcw;
