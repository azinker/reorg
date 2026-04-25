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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ChevronLeft,
  ChevronRight,
  X as XIcon,
  Download,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { HelpdeskTicketDetail, HelpdeskSyncStatus } from "@/hooks/use-helpdesk";
import { Composer } from "@/components/helpdesk/Composer";
import { Attachments } from "@/components/helpdesk/Attachments";
import { Avatar } from "@/components/ui/avatar";
import { SafeHtml } from "@/components/helpdesk/SafeHtml";
import {
  useHelpdeskPrefs,
  agentBubbleClasses,
} from "@/components/helpdesk/HelpdeskSettingsDialog";

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
  | "folder"
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
  folder: FilterIcon,
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
 * eBay's `i.ebayimg.com` URLs encode an image size in the path. The
 * `previewImageContN` blocks in a digest envelope embed the SMALL
 * thumbnail variant (`s-l64` / `$_0.JPG` / `$_1.JPG`), which is what
 * makes our lightbox look like a postage stamp instead of the
 * eBay-native full-size view.
 *
 * We can't ask eBay for a size token; instead we rewrite the URL to
 * the largest variant we know they serve. Two encoding families exist:
 *
 *   1. Modern: `…/s-l{N}.jpg`  where N ∈ {64, 96, 140, 300, 500, 800, 1600}
 *   2. Legacy: `…/$_{N}.JPG`   where N ∈ {0, 1, 3, 10, 27, 35, 57}
 *      (Higher N == bigger image; 57 is the typical full-frame variant
 *       eBay uses for its own Messages lightbox.)
 *
 * Anything else (non-eBay CDN, no size token) returns the input
 * unchanged so we don't break other media providers.
 */
/**
 * Classify an eBay-sent system notification from its subject + body into
 * a one-line human label, and pull out the return case ID when present
 * so the thread pill can deep-link to eBay's Return Details page. Kept
 * purely string-based so it's cheap to run inside the render loop; the
 * canonical classification lives in `lib/helpdesk/from-ebay-detect.ts`
 * but we don't ship that to the client.
 */
function summarizeEbaySystemMessage(
  subject: string | null,
  bodyText: string,
): { label: string; returnId: string | null } {
  const subjectText = subject ?? "";
  const bodyHead = (bodyText ?? "").replace(/<[^>]+>/g, " ").slice(0, 600);
  const haystack = `${subjectText}\n${bodyHead}`;

  // Return case IDs appear as "Return 5318077560:" in the subject. The
  // same value also shows up in the body as "case ID 5318077560" or
  // embedded in eBay return URLs. Subject is most reliable.
  const returnIdMatch =
    /Return\s+(\d{6,})/i.exec(subjectText) ??
    /\/mesh\/returns\/(\d{6,})/i.exec(bodyText ?? "") ??
    /return\s+case[^\d]*?(\d{6,})/i.exec(bodyHead);
  const returnId = returnIdMatch ? returnIdMatch[1] : null;

  let label: string;
  if (/buyer\s+opened\s+a\s+return|new\s+return\s+request|return\s+request/i.test(haystack)) {
    label = "Buyer opened a return case";
  } else if (/return\s+approved|you\s+accepted\s+(a|the)\s+return/i.test(haystack)) {
    label = "Return approved";
  } else if (/return\s+closed/i.test(haystack)) {
    label = "Return closed";
  } else if (/item\s+not\s+received|inr\s+claim/i.test(haystack)) {
    label = "Buyer opened an Item Not Received claim";
  } else if (/refund\s+issued/i.test(haystack)) {
    label = "Refund issued";
  } else if (/buyer\s+wants?\s+to\s+cancel|cancellation\s+request/i.test(haystack)) {
    label = "Buyer requested cancellation";
  } else if (/order\s+(was|has\s+been)\s+cancel(l?)ed|you\s+successfully\s+cancel/i.test(haystack)) {
    label = "Order canceled";
  } else if (/case\s+(is\s+now\s+)?closed|is\s+now\s+closed/i.test(haystack)) {
    label = "Case closed";
  } else if (/case\s+is\s+on\s+hold/i.test(haystack)) {
    label = "Case on hold";
  } else if (/item\s+delivered/i.test(haystack)) {
    label = "Item delivered";
  } else if (/feedback\s+removal/i.test(haystack)) {
    label = "Feedback removal update";
  } else if (subjectText.trim()) {
    label = subjectText.trim().slice(0, 80);
  } else {
    label = "System notification";
  }
  return { label, returnId };
}

function upgradeEbayImageUrl(url: string): string {
  if (!url || !url.includes("ebayimg.com")) return url;
  // Modern s-l{N} → s-l1600
  const modern = url.replace(/\/s-l\d{2,4}(\.[a-z]+)/i, "/s-l1600$1");
  if (modern !== url) return modern;
  // Legacy $_{N}.JPG → $_57.JPG
  const legacy = url.replace(/\/\$_\d+\.([a-z]+)/i, "/$_57.$1");
  return legacy;
}

/**
 * eBay's media payloads are heterogeneous (REST attachments, Trading-API
 * inline base64, and our own outbound envelope). Walk the structure and
 * pull anything that looks like an image. Fail silently on weird shapes —
 * an unmatched payload just falls through to the regular Attachments
 * component below the bubble.
 */
function extractInlineImages(
  rawMedia: unknown,
  bodyHtml?: string | null,
): InlineImage[] {
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
  if (rawMedia) visit(rawMedia);

  // Belt-and-suspenders: also scrape `<img>` tags from the body HTML.
  // Agent replies sent directly on eBay arrive with the image inline in
  // the body (rawMedia stays empty), so without this pass the nice
  // clickable strip wouldn't render and we'd be stuck with the small
  // body-embedded `<img>`. We restrict to `i.ebayimg.com` so we don't
  // also pick up tracking pixels or eBay-chrome sprites.
  if (bodyHtml) {
    const imgRe = /<img[^>]*\bsrc=["'](https:\/\/i\.ebayimg\.com\/[^"']+)["'][^>]*>/gi;
    let mt: RegExpExecArray | null;
    while ((mt = imgRe.exec(bodyHtml)) !== null) {
      collected.push({ url: mt[1], thumb: null });
    }
  }

  // Dedupe by URL so deeply-nested payloads + body scrapes don't render
  // the same image multiple times.
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

  // Agent message bubble accent — saved per-agent on this browser.
  // Defaults to reorG purple after agents asked for the brand-red
  // outbound bubble to be replaced with something less alarming.
  const prefs = useHelpdeskPrefs();
  const agentAccent = useMemo(
    () => agentBubbleClasses(prefs.agentBubbleAccent),
    [prefs.agentBubbleAccent],
  );

  const ticketId = ticket?.id ?? null;
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  // ── Image lightbox ─────────────────────────────────────────────
  // A single Lightbox instance lives at the ThreadView root. Clicking
  // any inline image opens it with the image set for THAT message
  // (so prev/next stays scoped to "the 3 images this buyer sent on
  // this turn" — not the entire thread, which would conflate images
  // from different conversations on a long order). ESC + arrow keys
  // are wired below so agents can pop through quickly.
  const [lightbox, setLightbox] = useState<{
    images: InlineImage[];
    index: number;
  } | null>(null);

  const openLightbox = useCallback(
    (images: InlineImage[], index: number) => {
      if (images.length === 0) return;
      setLightbox({ images, index: Math.max(0, Math.min(index, images.length - 1)) });
    },
    [],
  );
  const closeLightbox = useCallback(() => setLightbox(null), []);
  const lightboxNext = useCallback(() => {
    setLightbox((cur) =>
      cur ? { ...cur, index: (cur.index + 1) % cur.images.length } : cur,
    );
  }, []);
  const lightboxPrev = useCallback(() => {
    setLightbox((cur) =>
      cur
        ? { ...cur, index: (cur.index - 1 + cur.images.length) % cur.images.length }
        : cur,
    );
  }, []);
  const lightboxSelect = useCallback((next: number) => {
    setLightbox((cur) =>
      cur
        ? {
            ...cur,
            index: Math.max(0, Math.min(next, cur.images.length - 1)),
          }
        : cur,
    );
  }, []);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowRight") lightboxNext();
      else if (e.key === "ArrowLeft") lightboxPrev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, closeLightbox, lightboxNext, lightboxPrev]);

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
                    agentAccent={agentAccent}
                    onImageClick={openLightbox}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Composer ticket={ticket} syncStatus={syncStatus} onSent={onSent} />

      {lightbox && (
        <Lightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={closeLightbox}
          onNext={lightboxNext}
          onPrev={lightboxPrev}
          onSelect={lightboxSelect}
        />
      )}
    </div>
  );
}

// ─── Lightbox ───────────────────────────────────────────────────────────────

interface LightboxProps {
  images: InlineImage[];
  index: number;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSelect: (next: number) => void;
}

/**
 * Full-screen image viewer with prev/next navigation and a download
 * button. Rendered as a fixed-position overlay so it sits above the
 * thread, the composer, and the right-hand context panel. Clicking the
 * dark backdrop or the X button closes; ←/→ + Esc are bound on the
 * parent ThreadView's keydown listener.
 *
 * We deliberately render the original full-size URL (not the thumb),
 * since the buyer-uploaded eBay images are reasonably small (<1MB) and
 * agents need to actually read part numbers / damage detail off them.
 */
function Lightbox({
  images,
  index,
  onClose,
  onNext,
  onPrev,
  onSelect,
}: LightboxProps) {
  const current = images[index];
  // Resolved at the top so the entire component can lean on the same
  // URL — main render, download button, ARIA labels — without each call
  // site having to remember to upgrade. `current.url` from extraction
  // is the small `s-l64` / `$_0` thumbnail; we want eBay's largest
  // variant for the main view (matches eBay's own Messages lightbox).
  const fullUrl = current ? upgradeEbayImageUrl(current.url) : "";
  // Hold off on declaring `multi` until we know `current` exists so the
  // early-return below stays the only null guard.
  if (!current) return null;
  const multi = images.length > 1;

  // Force a download via a synthetic anchor so the browser saves the
  // file rather than navigating to it (the eBayimg URLs serve with
  // Content-Disposition: inline). We download the full-size variant —
  // the thumbnail URL is only useful for the inline preview / strip.
  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = fullUrl;
    const last = fullUrl.split("/").pop()?.split("?")[0] ?? "";
    a.download = last && /\.[a-z0-9]{2,5}$/i.test(last) ? last : `image-${index + 1}.jpg`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute right-4 top-4 inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        title="Close (Esc)"
        aria-label="Close"
      >
        <XIcon className="h-5 w-5" />
      </button>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handleDownload();
        }}
        className="absolute right-16 top-4 inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-full bg-black/40 px-3 text-sm text-white transition-colors hover:bg-black/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        title="Download"
      >
        <Download className="h-4 w-4" />
        <span>Download</span>
      </button>

      {multi && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          className="absolute left-4 inline-flex h-12 w-12 cursor-pointer items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          title="Previous (←)"
          aria-label="Previous image"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}

      {multi && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          className="absolute right-4 bottom-1/2 inline-flex h-12 w-12 translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          title="Next (→)"
          aria-label="Next image"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      )}

      {/* Image — clicking the image itself does NOT close (so agents can
          interact with it). Click the backdrop to close. We render the
          upgraded full-size variant; the inline strip uses the small
          thumbnail. Reserve room at the bottom (pb-32 in the wrapper)
          so the filmstrip never overlaps the photo. */}
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-4 px-4 pb-32 pt-16"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={fullUrl}
          alt={`Attachment ${index + 1} of ${images.length}`}
          className="max-h-full max-w-full cursor-default rounded object-contain shadow-2xl"
        />
      </div>

      {multi && (
        <>
          {/* Filmstrip — matches eBay's own message viewer. Shows up to
              all thumbs in a horizontally-scrollable row; the active
              one gets a bright ring so the agent can orient quickly. */}
          <div
            className="absolute bottom-12 left-1/2 max-w-[90vw] -translate-x-1/2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex max-w-full gap-2 overflow-x-auto rounded-lg bg-black/40 p-2 backdrop-blur-sm">
              {images.map((img, i) => (
                <button
                  key={`${img.url}-${i}`}
                  type="button"
                  onClick={() => onSelect(i)}
                  className={cn(
                    "h-14 w-14 flex-shrink-0 cursor-pointer overflow-hidden rounded transition-all",
                    i === index
                      ? "ring-2 ring-white ring-offset-2 ring-offset-black/40"
                      : "opacity-60 hover:opacity-100",
                  )}
                  title={`Image ${i + 1}`}
                  aria-label={`View image ${i + 1}`}
                  aria-current={i === index ? "true" : undefined}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.thumb ?? img.url}
                    alt={`Thumbnail ${i + 1}`}
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          </div>
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1 text-xs font-medium text-white tabular-nums">
            {index + 1} / {images.length}
          </div>
        </>
      )}
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
  /**
   * Class triplet for the agent's bubble — pre-computed by
   * `agentBubbleClasses(prefs.agentBubbleAccent)` in the parent so we
   * don't re-derive it on every row render. Pending outbound bubbles use
   * the same accent so the queued reply visually matches the future
   * delivered message.
   */
  agentAccent: ReturnType<typeof agentBubbleClasses>;
  /**
   * Opens the lightbox at the ThreadView root with the supplied image
   * set + starting index. Optional because system/day rows never call
   * it, but message rows always pass it through.
   */
  onImageClick?: (images: InlineImage[], index: number) => void;
}

function TimelineItem({
  row,
  buyerInitial,
  agentAccent,
  onImageClick,
}: TimelineItemProps) {
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
          title={formatRelativeTime(ev.at)}
        >
          <Icon className="h-3 w-3" />
          <span className="font-medium">{ev.text}</span>
          <span className="opacity-60">·</span>
          <span className="tabular-nums opacity-80">
            {formatDateTime(ev.at)}
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
            <div
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold",
                agentAccent.dotBg,
              )}
            >
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
                  : agentAccent.dotBg,
              )}
            >
              {statusLabel}
            </span>
            <span
              className={cn(
                "truncate text-[13px] font-semibold",
                agentAccent.name,
              )}
            >
              {j.author?.name ?? j.author?.email ?? "Agent"}
            </span>
          </div>
          <div
            className={cn(
              "rounded-md border border-dashed px-3 py-2 text-[13px] leading-[1.5] opacity-90",
              blocked
                ? "border-amber-500/50 bg-amber-50 text-foreground dark:bg-amber-950/20"
                : agentAccent.bubble,
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
          <span className="opacity-70" title={formatRelativeTime(n.createdAt)}>
            · {formatDateTime(n.createdAt)}
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

  // eBay system notifications (Return approved, Case closed, Refund
  // issued, etc.) arrive as INBOUND rows whose sender is literally
  // "eBay" (stamped by the Trading API). Agents do not need to read
  // the full marketing-styled email body we stored — they just need a
  // compact timeline marker with a deep-link. Render those rows as a
  // centered "internal note"-style pill instead of a giant bubble.
  const isEbaySystem =
    isInbound &&
    m.source === "EBAY" &&
    (/^ebay$/i.test(m.fromName ?? "") ||
      /^ebay$/i.test(m.fromIdentifier ?? ""));

  if (isEbaySystem) {
    const info = summarizeEbaySystemMessage(m.subject, m.bodyText);
    return (
      <div className="flex justify-center py-1">
        <div className="inline-flex max-w-[80%] items-center gap-2 rounded-full border border-hairline bg-surface px-3 py-1.5 text-[12px] text-muted-foreground">
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
            fill="currentColor"
          >
            <path d="M12 2 1 6v6c0 5.5 3.8 10.7 11 12 7.2-1.3 11-6.5 11-12V6l-11-4z" />
          </svg>
          <span className="font-medium text-foreground/80">
            From eBay:
          </span>
          <span>{info.label}</span>
          {info.returnId && (
            <>
              <span className="opacity-50">·</span>
              <a
                href={`https://www.ebay.com/mesh/returns/${info.returnId}/details`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-brand underline-offset-2 hover:underline"
              >
                Return #{info.returnId}
              </a>
            </>
          )}
          <span
            className="tabular-nums opacity-70"
            title={formatRelativeTime(m.sentAt)}
          >
            · {formatDateTime(m.sentAt)}
          </span>
        </div>
      </div>
    );
  }
  // `m.author` is populated iff a known Help Desk user composed the
  // message through our composer (outbound worker stamps authorUserId
  // from the job). If it's present, this was sent through reorG — so
  // the "Sent directly on eBay" pill must NOT show, and we prefer the
  // author's real name over the persisted `fromName` (which might still
  // be a generic label for historical rows).
  const hasHelpdeskAuthor = !!m.author && !isInbound;

  const displayName = isAR
    ? "Auto Responder"
    : (hasHelpdeskAuthor ? m.author?.name ?? m.author?.email : null) ??
      m.fromName ??
      m.fromIdentifier ??
      (isInbound ? "Buyer" : "Agent");

  // Buyer bubbles use a generated avatar from the first letter of the
  // buyer's name. Agent bubbles use the real <Avatar/> with initials. AR
  // bubbles use a Bot icon on a brand-muted disc.
  const renderAvatar = () => {
    if (isAR) {
      return (
        <div
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full",
            agentAccent.dotBg,
          )}
        >
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
      <div
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold",
          agentAccent.dotBg,
        )}
      >
        {(displayName.charAt(0) || "?").toUpperCase()}
      </div>
    );
  };

  // Pass the body so EBAY_UI / agent replies (which embed the photo
  // inline in HTML rather than via rawMedia) still get surfaced through
  // the clickable lightbox strip below.
  const inlineImages = extractInlineImages(m.rawMedia, m.bodyText);

  // Right-aligned (agent / AR) vs left-aligned (buyer). We swap the row
  // direction with `flex-row-reverse` so the avatar always sits on the
  // outside edge and the bubble's "tail" (the colored left-border accent)
  // visually anchors to the speaker side.
  const sideClass = isInbound ? "" : "flex-row-reverse";
  // Agent bubble color follows the agent's accent pref. Buyer bubble is
  // a neutral card (intentionally not themed — buyer "voice" should not
  // change with agent settings). AR bubble shares the agent accent but
  // dashed to convey "not a human reply".
  const bubbleClass = isInbound
    ? "border-hairline bg-card text-foreground"
    : isAR
      ? cn(agentAccent.bubble, "border-dashed opacity-90")
      : agentAccent.bubble;

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
              title={formatRelativeTime(m.sentAt)}
            >
              {formatDateTime(m.sentAt)}
            </span>
          )}
          <span
            className={cn(
              "truncate text-[13px] font-semibold",
              isInbound
                ? "text-foreground"
                : isAR
                  ? cn(agentAccent.name, "italic opacity-80")
                  : agentAccent.name,
            )}
          >
            {displayName}
          </span>
          {/* The "Sent directly on eBay" pill is an *agent-side* audit marker:
              it exists to distinguish "agent replied from the eBay web inbox"
              from "agent replied through reorG". Buyer messages always arrive
              via eBay regardless of which interface the buyer used, so the
              pill is meaningless on INBOUND rows — and historically confused
              users who thought it implied the buyer had some other channel.
              Also suppress when a known Help Desk user authored the reply:
              our outbound worker stamps authorUserId from the composer, and
              those sends ARE the "through reorG" case even though they
              travel over the CM API (source=EBAY_UI) under the hood. */}
          {!isInbound && isEbayUi && !hasHelpdeskAuthor && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/50 bg-amber-400/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800 shadow-sm dark:border-amber-400/60 dark:bg-amber-400/15 dark:text-amber-200"
              title="This reply was sent directly through eBay's web inbox, not from reorG. The audit trail shows the agent who composed it (when known) but the send did not pass through the reorG composer."
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="h-3 w-3"
                fill="currentColor"
              >
                <path d="M12 2 1 6v6c0 5.5 3.8 10.7 11 12 7.2-1.3 11-6.5 11-12V6l-11-4z" />
              </svg>
              Sent directly on eBay
            </span>
          )}
          {isInbound && (
            <span
              className="text-[11px] tabular-nums text-muted-foreground"
              title={formatRelativeTime(m.sentAt)}
            >
              {formatDateTime(m.sentAt)}
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
              eBay's `isHtml` flag is wrong (which it often is). When we
              have a curated inline-image strip below, strip the body's
              own <img> tags so we don't render a tiny duplicate beside
              every nice clickable thumbnail. */}
          <SafeHtml
            html={m.bodyText}
            forceHtml={m.isHtml}
            stripImages={inlineImages.length > 0}
          />

          {inlineImages.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {inlineImages.map((img, idx) => (
                <button
                  key={img.url}
                  type="button"
                  onClick={() => onImageClick?.(inlineImages, idx)}
                  className="block cursor-pointer overflow-hidden rounded border border-hairline bg-surface transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  title="Click to view full size"
                  aria-label={`Open image ${idx + 1} of ${inlineImages.length}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.thumb ?? img.url}
                    alt=""
                    loading="lazy"
                    className="h-32 w-32 object-cover"
                  />
                </button>
              ))}
            </div>
          )}

          {/* Non-image attachments (PDFs, zips, etc.) still surface
              through the existing Attachments component — keeps the
              file handling centralized. We pass excludeImages so it
              doesn't double-render the buyer photos that the gallery
              strip above already shows at h-32. Without that prop,
              every image rendered twice (big in the strip, small here)
              — Adam called these out as the "duplicate small thumbnails
              under big previews". */}
          <Attachments rawMedia={m.rawMedia} excludeImages />
        </div>
      </div>
    </div>
  );
}

// Suppress unused import warning for the rotation icon — we may use it
// later for a "reopened" event variant; keep the import so that change is
// a one-line addition.
void RotateCcw;
