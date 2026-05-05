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
import { createPortal } from "react-dom";
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
  FileText,
  Languages,
  RefreshCw,
  Mail,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  HelpdeskPendingOutboundJob,
  HelpdeskTicketDetail,
  HelpdeskSyncStatus,
} from "@/hooks/use-helpdesk";
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
  | "cross_listing"
  | "folder"
  | "order_received"
  | "order_shipped"
  | "order_tracking_added";

interface SystemEvent {
  id: string;
  type: "system";
  action: string;
  kind: SystemEventKind;
  text: string;
  shortText?: string | null;
  href?: string | null;
  externalId?: string | null;
  trackingNumber?: string | null;
  estimatedDeliveryText?: string | null;
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

function formatTimelineEventDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
}

function timelineRowDomId(rowKey: string): string {
  return `helpdesk-timeline-row-${rowKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function timelineRowKeyForEvent(event: SystemEvent): string {
  return `sys-${event.id}`;
}

function isTimelineStoryEvent(event: SystemEvent): boolean {
  if (
    event.kind === "order_received" ||
    event.kind === "order_shipped" ||
    event.kind === "order_tracking_added" ||
    event.kind === "feedback" ||
    event.kind === "refund" ||
    event.kind === "cancel"
  ) {
    return true;
  }
  if (event.kind !== "case") return false;
  return (
    event.action === "EBAY_CASE_OPENED" ||
    event.action === "EBAY_ITEM_NOT_RECEIVED_CASE" ||
    event.action === "EBAY_RETURN_OPENED" ||
    event.action === "EBAY_CASE_CLOSED" ||
    /buyer opened|opened .*case|opened .*claim|opened .*return|buyer closed|closed .*case|closed .*claim|closed .*return/i.test(
      `${event.shortText ?? ""} ${event.text}`,
    )
  );
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
  cross_listing: ShoppingCart,
  folder: FilterIcon,
  order_received: ShoppingCart,
  order_shipped: Truck,
  order_tracking_added: Truck,
};

function classForEvent(event: Pick<SystemEvent, "action" | "kind" | "shortText" | "text">): string {
  const label = `${event.shortText ?? ""} ${event.text} ${event.action}`.toLowerCase();

  switch (event.kind) {
    case "case":
      return "border-amber-500/45 bg-amber-500/10 text-amber-900 dark:text-amber-200";
    case "feedback":
      if (label.includes("negative")) {
        return "border-red-500/45 bg-red-500/10 text-red-800 dark:text-red-200";
      }
      if (label.includes("positive")) {
        return "border-emerald-500/45 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200";
      }
      return "border-amber-500/45 bg-amber-500/10 text-amber-900 dark:text-amber-200";
    case "cancel":
    case "spam":
      return "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    case "refund":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "order_received":
      return "border-sky-500/45 bg-sky-500/10 text-sky-800 dark:text-sky-200";
    case "order_shipped":
    case "order_tracking_added":
      return "border-cyan-500/45 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200";
    case "cross_listing":
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

// ─── System event presentation ──────────────────────────────────────────────

function trackingDisplayForEvent(event: SystemEvent): {
  label: string;
  trackingNumber: string;
  estimatedDeliveryText: string | null;
} | null {
  if (event.kind !== "order_shipped" && event.kind !== "order_tracking_added") {
    return null;
  }

  const trackingNumber =
    event.trackingNumber?.trim() || event.externalId?.trim() || null;
  if (!trackingNumber) return null;

  return {
    label: event.shortText ?? event.text.replace(/\s+-\s+.+$/, ""),
    trackingNumber,
    estimatedDeliveryText:
      event.kind === "order_shipped"
        ? (event.estimatedDeliveryText?.trim() ?? null)
        : null,
  };
}

function SystemEventPillContent({
  event,
  Icon,
}: {
  event: SystemEvent;
  Icon: typeof Eye;
}) {
  const tracking = trackingDisplayForEvent(event);
  return (
    <>
      <Icon className="h-3 w-3 shrink-0" />
      {tracking ? (
        <>
          <span className="font-medium">{tracking.label}</span>
          <span className="opacity-60">-</span>
          <span className="font-mono text-[11px] font-semibold leading-tight text-sky-600 dark:text-sky-300">
            {tracking.trackingNumber}
          </span>
          {tracking.estimatedDeliveryText ? (
            <>
              <span className="opacity-60">-</span>
              <span className="tabular-nums font-semibold text-sky-700 dark:text-sky-200">
                {tracking.estimatedDeliveryText}
              </span>
            </>
          ) : null}
        </>
      ) : (
        <span className="font-medium">{event.text}</span>
      )}
      <span className="opacity-60">-</span>
      <span className="tabular-nums opacity-80">{formatDateTime(event.at)}</span>
    </>
  );
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
    label = "Buyer Opened a Return Case";
  } else if (/return\s+approved|you\s+accepted\s+(a|the)\s+return/i.test(haystack)) {
    label = "Return Approved";
  } else if (/return\s+closed/i.test(haystack)) {
    label = "Return Closed";
  } else if (/item\s+not\s+received|inr\s+claim/i.test(haystack)) {
    label = "Buyer Opened an Item Not Received Claim";
  } else if (/refund\s+issued/i.test(haystack)) {
    label = "Refund Issued";
  } else if (/buyer\s+wants?\s+to\s+cancel|cancellation\s+request/i.test(haystack)) {
    label = "Buyer Requested Cancellation";
  } else if (/order\s+(was|has\s+been)\s+cancel(l?)ed|you\s+successfully\s+cancel/i.test(haystack)) {
    label = "Order Canceled";
  } else if (/case\s+(is\s+now\s+)?closed|is\s+now\s+closed/i.test(haystack)) {
    label = "Case Closed";
  } else if (/case\s+is\s+on\s+hold/i.test(haystack)) {
    label = "Case On Hold";
  } else if (/item\s+delivered/i.test(haystack)) {
    label = "Item Delivered";
  } else if (/feedback\s+removal/i.test(haystack)) {
    label = "Feedback Removal Update";
  } else if (subjectText.trim()) {
    label = subjectText.trim().slice(0, 80);
  } else {
    label = "System Notification";
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

/** Stable key so s-l500 / s-l1600 / thumb URLs dedupe to one tile. */
function ebayImageDedupeKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes("ebayimg.com")) {
      let path = u.pathname;
      path = path.replace(/\/s-l\d+(?=\.[a-z0-9]+$)/i, "/s-l__");
      path = path.replace(/\/\$_\d+(?=\.[a-z0-9]+$)/i, "/$___");
      return `${host}${path}`;
    }
    return `${host}${u.pathname}`.toLowerCase();
  } catch {
    return url.split("?")[0]!.toLowerCase();
  }
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
    const mediaType =
      (typeof obj.mediaType === "string" && obj.mediaType) ||
      (typeof obj.MediaType === "string" && obj.MediaType) ||
      "";
    const url =
      (typeof obj.url === "string" && obj.url) ||
      (typeof obj.mediaUrl === "string" && obj.mediaUrl) ||
      (typeof obj.mediaURL === "string" && obj.mediaURL) ||
      (typeof obj.MediaURL === "string" && obj.MediaURL) ||
      (typeof obj.imageUrl === "string" && obj.imageUrl) ||
      (typeof obj.imageURL === "string" && obj.imageURL) ||
      (typeof obj.href === "string" && obj.href) ||
      (typeof obj.downloadUrl === "string" && obj.downloadUrl) ||
      "";
    const isImage =
      mime.toLowerCase().startsWith("image/") ||
      mediaType.toUpperCase() === "IMAGE" ||
      /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|avif|heic|heif)(?:\?|$)/i.test(url);
    if (isImage && url) {
      const thumb =
        (typeof obj.thumbnailUrl === "string" && obj.thumbnailUrl) ||
        (typeof obj.thumbnailURL === "string" && obj.thumbnailURL) ||
        null;
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

  // Dedupe by canonical identity so nested payloads + `<img>` scrapes don't
  // repeat the same photo when eBay uses different CDN size tokens (s-l500 vs
  // s-l1600) for one attachment.
  const seen = new Set<string>();
  return collected.filter((img) => {
    const key = ebayImageDedupeKey(img.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Component ──────────────────────────────────────────────────────────────

interface TranslationResult {
  translatedText: string;
  detectedLanguage: string | null;
}

const translationCache = new Map<string, TranslationResult | null>();

function plainTextForTranslation(body: string, isHtml: boolean): string {
  let text = body ?? "";
  if (isHtml || /<[^>]+>/.test(text)) {
    const normalized = text
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n");
    if (typeof document !== "undefined") {
      const el = document.createElement("div");
      el.innerHTML = normalized;
      text = el.textContent ?? "";
    } else {
      text = normalized.replace(/<[^>]+>/g, " ");
    }
  }
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function shouldAutoTranslate(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length < 3) return false;
  if (/[\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u3040-\u30ff\u3400-\u9fff]/.test(compact)) {
    return true;
  }
  if (/[¿¡áéíóúñüàèìòùâêîôûãõç]/i.test(compact)) return true;
  return /\b(gracias|hola|buenos|buenas|por favor|favor|necesito|quiero|cuando|cu[aá]ndo|donde|d[oó]nde|env[ií]o|paquete|producto|compr[eé]|tengo|puede|usted|porque|por que|c[oó]mo|merci|bonjour|s'il vous plait|obrigado|obrigada|ol[aá]|quando|produto|pacote|envio|danke|bitte|hallo|versand|produkt)\b/i.test(compact);
}

function normalizedTranslationCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^0-9a-z]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function MessageTranslationPanel({
  messageId,
  sourceText,
}: {
  messageId: string;
  sourceText: string;
}) {
  const shouldTranslate = shouldAutoTranslate(sourceText);
  const [state, setState] = useState<{
    loading: boolean;
    result: TranslationResult | null;
    error: boolean;
  }>({ loading: false, result: null, error: false });

  useEffect(() => {
    if (!shouldTranslate) return;
    const cacheKey = `${messageId}:${sourceText}`;
    if (translationCache.has(cacheKey)) {
      setState({
        loading: false,
        result: translationCache.get(cacheKey) ?? null,
        error: false,
      });
      return;
    }
    const ac = new AbortController();
    setState({ loading: true, result: null, error: false });
    void (async () => {
      try {
        const res = await fetch("/api/helpdesk/translate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          signal: ac.signal,
          body: JSON.stringify({ text: sourceText, target: "en" }),
        });
        if (!res.ok) throw new Error(`translate ${res.status}`);
        const json = (await res.json()) as { data?: TranslationResult };
        if (ac.signal.aborted) return;
        const translatedText = json.data?.translatedText?.trim() ?? "";
        const detectedLanguage = json.data?.detectedLanguage ?? null;
        const meaningful =
          translatedText.length > 0 &&
          detectedLanguage?.toLowerCase() !== "en" &&
          normalizedTranslationCompare(translatedText) !==
            normalizedTranslationCompare(sourceText);
        const result = meaningful
          ? { translatedText, detectedLanguage }
          : null;
        translationCache.set(cacheKey, result);
        setState({ loading: false, result, error: false });
      } catch {
        if (ac.signal.aborted) return;
        setState({ loading: false, result: null, error: true });
      }
    })();
    return () => ac.abort();
  }, [messageId, shouldTranslate, sourceText]);

  if (!shouldTranslate) return null;

  if (state.loading) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-md border border-sky-500/25 bg-sky-500/10 px-2.5 py-2 text-[12px] text-sky-700 dark:text-sky-300">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Translating to English...
      </div>
    );
  }

  if (state.error) {
    const href = `https://translate.google.com/?sl=auto&tl=en&text=${encodeURIComponent(sourceText)}&op=translate`;
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-sky-500/25 bg-sky-500/10 px-2.5 py-1.5 text-[12px] font-medium text-sky-700 transition-colors hover:bg-sky-500/15 dark:text-sky-300 cursor-pointer"
      >
        <Languages className="h-3.5 w-3.5" />
        Translate with Google
      </a>
    );
  }

  if (!state.result) return null;

  return (
    <div className="mt-2 rounded-md border border-sky-500/25 bg-sky-500/10 p-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-300">
        <Languages className="h-3.5 w-3.5" />
        Translated to English
        {state.result.detectedLanguage ? (
          <span className="font-medium normal-case tracking-normal opacity-70">
            from {state.result.detectedLanguage.toUpperCase()}
          </span>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap text-[13px] leading-[1.5] text-foreground">
        {state.result.translatedText}
      </p>
    </div>
  );
}

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
  const [highlightedTimelineKey, setHighlightedTimelineKey] = useState<string | null>(null);
  const highlightTimeoutRef = useRef<number | null>(null);

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

  const ticketImageGallery = useMemo(() => {
    if (!ticket) return [];
    const seen = new Set<string>();
    const images: InlineImage[] = [];
    for (const message of ticket.messages) {
      for (const img of extractInlineImages(message.rawMedia, message.bodyText)) {
        const key = ebayImageDedupeKey(img.url);
        if (seen.has(key)) continue;
        seen.add(key);
        images.push(img);
      }
    }
    return images;
  }, [ticket]);

  const openLightbox = useCallback(
    (images: InlineImage[], index: number) => {
      if (images.length === 0) return;
      const clicked = images[index];
      const gallery = ticketImageGallery.length > 0 ? ticketImageGallery : images;
      const clickedKey = clicked ? ebayImageDedupeKey(clicked.url) : null;
      const galleryIndex = clickedKey
        ? gallery.findIndex((img) => ebayImageDedupeKey(img.url) === clickedKey)
        : -1;
      const nextIndex = galleryIndex >= 0 ? galleryIndex : index;
      setLightbox({
        images: gallery,
        index: Math.max(0, Math.min(nextIndex, gallery.length - 1)),
      });
    },
    [ticketImageGallery],
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
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowRight") lightboxNext();
      else if (e.key === "ArrowLeft") lightboxPrev();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = originalOverflow;
    };
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

  const notableEvents = useMemo(
    () => events.filter(isTimelineStoryEvent),
    [events],
  );

  useEffect(() => {
    setHighlightedTimelineKey(null);
  }, [ticketId]);

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current != null) {
        window.clearTimeout(highlightTimeoutRef.current);
      }
    };
  }, []);

  const [optimisticOutboundJobs, setOptimisticOutboundJobs] = useState<
    HelpdeskPendingOutboundJob[]
  >([]);
  const [retryingJobIds, setRetryingJobIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    setOptimisticOutboundJobs([]);
    setRetryingJobIds(new Set());
  }, [ticketId]);

  const retryOutboundJob = useCallback(
    async (jobId: string) => {
      setRetryingJobIds((prev) => {
        const next = new Set(prev);
        next.add(jobId);
        return next;
      });
      try {
        const res = await fetch(`/api/helpdesk/outbound/${jobId}`, {
          method: "POST",
          credentials: "same-origin",
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as {
            error?: unknown;
          };
          throw new Error(
            typeof payload.error === "string"
              ? payload.error
              : `Retry failed (${res.status})`,
          );
        }
        setOptimisticOutboundJobs((prev) =>
          prev.filter((job) => job.id !== jobId),
        );
        onSent();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("Failed to retry outbound job", err);
      } finally {
        setRetryingJobIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    },
    [onSent],
  );

  const pendingOutboundJobs = useMemo(() => {
    if (!ticket) return [];
    const serverJobs = ticket.pendingOutboundJobs ?? [];
    const serverIds = new Set(serverJobs.map((job) => job.id));
    const now = Date.now();
    const optimistic = optimisticOutboundJobs.filter((job) => {
      if (serverIds.has(job.id)) return false;
      if (now - new Date(job.createdAt).getTime() > 60_000) return false;
      const createdMs = new Date(job.createdAt).getTime();
      return !ticket.messages.some((m) => {
        if (m.direction !== "OUTBOUND") return false;
        if (m.bodyText.trim() !== job.bodyText.trim()) return false;
        return Math.abs(new Date(m.sentAt).getTime() - createdMs) < 5 * 60_000;
      });
    });
    return [...serverJobs, ...optimistic];
  }, [ticket, optimisticOutboundJobs]);

  const activeOutboundRefreshSignature = useMemo(() => {
    const soon = Date.now() + 2 * 60_000;
    return pendingOutboundJobs
      .filter((job) => {
        if (job.status !== "PENDING" && job.status !== "SENDING") return false;
        return new Date(job.scheduledAt).getTime() <= soon;
      })
      .map((job) => `${job.id}:${job.status}:${job.scheduledAt}`)
      .join("|");
  }, [pendingOutboundJobs]);

  useEffect(() => {
    if (!ticketId || !activeOutboundRefreshSignature) return;
    const interval = window.setInterval(() => {
      onSent();
    }, 5_000);
    const timeout = window.setTimeout(() => {
      window.clearInterval(interval);
    }, 2 * 60_000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [ticketId, activeOutboundRefreshSignature, onSent]);

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
    const merged: Item[] = [
      ...ticket.messages.map((m) => ({ kind: "message" as const, data: m, at: m.sentAt })),
      ...ticket.notes.map((n) => ({ kind: "note" as const, data: n, at: n.createdAt })),
      ...pendingOutboundJobs.map((p) => ({ kind: "pending" as const, data: p, at: p.createdAt })),
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
  }, [ticket, events, pendingOutboundJobs]);

  // ── Virtualiser setup ──
  const useVirtualTimeline = rows.length > 80;
  const rowsSignature = useMemo(
    () => rows.map((row) => `${row.key}:${row.at}`).join("|"),
    [rows],
  );

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
      if (useVirtualTimeline) {
        virtualizer.measure();
        virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
      } else if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId, rows.length, rowsSignature, useVirtualTimeline]);

  const jumpToTimelineEvent = useCallback(
    (event: SystemEvent) => {
      const rowKey = timelineRowKeyForEvent(event);
      const rowIndex = rows.findIndex((row) => row.key === rowKey);
      if (rowIndex < 0) return;

      setHighlightedTimelineKey(rowKey);
      if (highlightTimeoutRef.current != null) {
        window.clearTimeout(highlightTimeoutRef.current);
      }
      highlightTimeoutRef.current = window.setTimeout(() => {
        setHighlightedTimelineKey((current) =>
          current === rowKey ? null : current,
        );
      }, 1800);

      if (useVirtualTimeline) {
        virtualizer.scrollToIndex(rowIndex, { align: "center" });
        return;
      }

      document
        .getElementById(timelineRowDomId(rowKey))
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    [rows, useVirtualTimeline, virtualizer],
  );

  if (loading && !ticket) {
    return <ThreadSkeleton />;
  }
  if (!ticket) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-muted-foreground">
        <div className="flex h-14 w-14 items-center justify-center rounded-md border border-hairline bg-surface">
          <MessageSquareText className="h-6 w-6 opacity-60" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">Select a ticket</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The buyer conversation and reply composer will open here.
          </p>
        </div>
      </div>
    );
  }

  const virtualRows = useVirtualTimeline ? virtualizer.getVirtualItems() : [];
  const buyerInitial = (
    ticket.buyerName?.trim() ||
    ticket.buyerUserId?.trim() ||
    "?"
  )
    .charAt(0)
    .toUpperCase();

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
                  <a
                    href={`https://www.ebay.com/mesh/ord/details?orderid=${ticket.ebayOrderNumber}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-6 max-w-[18rem] shrink-0 truncate items-center rounded-md border border-emerald-500/45 bg-emerald-500/10 px-2 text-[12px] font-bold text-emerald-700 shadow-sm transition-colors hover:border-emerald-400 hover:bg-emerald-500/15 hover:text-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30 dark:text-emerald-300 dark:hover:text-emerald-200 cursor-pointer"
                    title="Open this order on eBay in a new tab"
                  >
                    Order #{ticket.ebayOrderNumber}
                  </a>
                </>
              )}
            </p>
          </div>
        </div>
      )}

      {notableEvents.length > 0 ? (
        <TimelineStoryStrip
          events={notableEvents}
          onSelect={jumpToTimelineEvent}
        />
      ) : null}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 scroll-smooth overflow-y-auto bg-background px-4 py-5 sm:px-6"
      >
        {rows.length === 0 ? (
          <ThreadEmptyState eventsLoading={eventsLoading} />
        ) : useVirtualTimeline ? (
          <div
            className="relative mx-auto w-full max-w-3xl"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualRows.map((vr) => {
              const row = rows[vr.index]!;
              return (
                <div
                  key={vr.key}
                  id={timelineRowDomId(row.key)}
                  data-index={vr.index}
                  ref={virtualizer.measureElement}
                  className={cn(
                    "absolute left-0 top-0 w-full rounded-lg pb-4 transition-shadow duration-300 scroll-mt-20",
                    highlightedTimelineKey === row.key &&
                      "ring-2 ring-brand/60 ring-offset-2 ring-offset-background",
                  )}
                  style={{ transform: `translateY(${vr.start}px)` }}
                >
                  <TimelineItem
                    row={row}
                    buyerInitial={buyerInitial}
                    agentAccent={agentAccent}
                    messageFontSizePx={prefs.messageFontSizePx}
                    onImageClick={openLightbox}
                    onRetryOutbound={retryOutboundJob}
                    retryingJobIds={retryingJobIds}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            {rows.map((row) => (
              <div
                key={row.key}
                id={timelineRowDomId(row.key)}
                className={cn(
                  "rounded-lg transition-shadow duration-300 scroll-mt-20",
                  highlightedTimelineKey === row.key &&
                    "ring-2 ring-brand/60 ring-offset-2 ring-offset-background",
                )}
              >
                <TimelineItem
                  row={row}
                  buyerInitial={buyerInitial}
                  agentAccent={agentAccent}
                  messageFontSizePx={prefs.messageFontSizePx}
                  onImageClick={openLightbox}
                  onRetryOutbound={retryOutboundJob}
                  retryingJobIds={retryingJobIds}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <Composer
        ticket={ticket}
        syncStatus={syncStatus}
        onQueuedOutbound={(job) =>
          setOptimisticOutboundJobs((prev) =>
            prev.some((p) => p.id === job.id) ? prev : [...prev, job],
          )
        }
        onSent={onSent}
      />

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

function ThreadSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex-1 space-y-5 px-6 py-6">
        {Array.from({ length: 5 }).map((_, i) => {
          const outbound = i % 2 === 1;
          return (
            <div
              key={i}
              className={cn("flex gap-3", outbound && "flex-row-reverse")}
            >
              <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-foreground/10" />
              <div
                className={cn(
                  "space-y-2 rounded-md border border-hairline bg-card p-3",
                  outbound ? "w-3/5" : "w-2/3",
                )}
              >
                <div className="h-3 w-28 animate-pulse rounded bg-foreground/10" />
                <div className="h-3 w-full animate-pulse rounded bg-foreground/10" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-foreground/10" />
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-hairline bg-card p-3">
        <div className="h-10 animate-pulse rounded-md bg-foreground/10" />
      </div>
    </div>
  );
}

function ThreadEmptyState({ eventsLoading }: { eventsLoading: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-md border border-hairline bg-surface">
        {eventsLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <MessageSquareText className="h-5 w-5 text-muted-foreground" />
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {eventsLoading ? "Loading conversation..." : "No messages yet."}
      </p>
    </div>
  );
}

function TimelineStoryStrip({
  events,
  onSelect,
}: {
  events: SystemEvent[];
  onSelect: (event: SystemEvent) => void;
}) {
  const ordered = events
    .slice()
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const latest = ordered
    .slice()
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0];
  if (!latest) return null;

  return (
    <div className="shrink-0 border-b border-hairline bg-card/70 px-4 py-1.5 text-[11px] text-muted-foreground">
      <div className="flex w-full flex-wrap items-center gap-2">
        <span className="inline-flex shrink-0 items-center gap-1.5 font-semibold text-foreground">
          <Star className="h-3.5 w-3.5 text-brand" />
          Timeline
        </span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-sky-500 dark:text-sky-300" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-0.5">
          {ordered.map((event, index) => {
            const EventIcon = SYSTEM_ICON[event.kind] ?? CircleDashed;
            const label = event.shortText ?? event.text;
            return (
              <span key={event.id} className="contents">
                {index > 0 ? (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-sky-500 dark:text-sky-300" />
                ) : null}
                <button
                  type="button"
                  onClick={() => onSelect(event)}
                  className={cn(
                    "inline-flex max-w-[18rem] shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 transition-colors hover:border-brand/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 cursor-pointer",
                    classForEvent(event),
                  )}
                  title={`${event.text} - ${formatDateTime(event.at)}. Jump to this event in the thread.`}
                  aria-label={`Jump to ${label} in the thread`}
                >
                  <EventIcon className="h-3 w-3 shrink-0" />
                  <span className="truncate">{label}</span>
                  <span className="opacity-55">-</span>
                  <span className="shrink-0 tabular-nums opacity-80">
                    {formatTimelineEventDate(event.at)}
                  </span>
                </button>
              </span>
            );
          })}
        </div>
        <span className="hidden shrink-0 tabular-nums sm:inline">
          Latest {formatRelativeTime(latest.at)}
        </span>
      </div>
    </div>
  );
}

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

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 backdrop-blur-sm"
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
    </div>,
    document.body,
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
  messageFontSizePx: number;
  /**
   * Opens the lightbox at the ThreadView root with the supplied image
   * set + starting index. Optional because system/day rows never call
   * it, but message rows always pass it through.
   */
  onImageClick?: (images: InlineImage[], index: number) => void;
  onRetryOutbound?: (jobId: string) => void;
  retryingJobIds?: Set<string>;
}

function pendingJobMeta(job: HelpdeskPendingOutboundJob) {
  const channelLabel = job.composerMode === "EXTERNAL" ? "external email" : "reply";
  const providerLabel = job.composerMode === "EXTERNAL" ? "Resend" : "eBay";

  if (job.status === "FAILED") {
    return {
      label: "Failed",
      detail: job.willBlockReason ?? `The ${channelLabel} did not send.`,
      tone: "red" as const,
    };
  }
  if (/temporary_eBay_connection_issue|fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(job.willBlockReason ?? "")) {
    return {
      label: "Retrying",
      detail:
        "Temporary eBay connection issue. The outbound worker will retry automatically.",
      tone: "amber" as const,
    };
  }
  if (job.status === "CANCELED") {
    return {
      label: "Canceled",
      detail: "Canceled before send.",
      tone: "amber" as const,
    };
  }
  if (job.willBlockReason) {
    return {
      label: "Blocked",
      detail: job.willBlockReason,
      tone: "amber" as const,
    };
  }
  if (job.status === "SENDING") {
    return {
      label: "Sending",
      detail: `The outbound worker is sending this ${channelLabel}.`,
      tone: "blue" as const,
    };
  }
  return {
    label: "Sending",
    detail: `Waiting for ${providerLabel} confirmation from the outbound worker.`,
    tone: "blue" as const,
  };
}

function TimelineItem({
  row,
  buyerInitial,
  agentAccent,
  messageFontSizePx,
  onImageClick,
  onRetryOutbound,
  retryingJobIds,
}: TimelineItemProps) {
  if (row.kind === "day") {
    return (
      <div className="my-3 flex items-center justify-center gap-3">
        <span className="h-px flex-1 max-w-[28%] bg-hairline" />
        <span className="rounded-full border border-hairline bg-surface px-3 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground shadow-sm">
          {row.label}
        </span>
        <span className="h-px flex-1 max-w-[28%] bg-hairline" />
      </div>
    );
  }

  if (row.kind === "system") {
    const ev = row.data;
    const Icon = SYSTEM_ICON[ev.kind] ?? CircleDashed;
    const hrefTitle =
      ev.kind === "order_shipped" || ev.kind === "order_tracking_added"
        ? "open tracking"
        : "open on eBay";
    if (ev.href) {
      return (
        <div className="my-1 flex items-center justify-center gap-3">
          <span className="h-px flex-1 max-w-[18%] bg-hairline" />
          <a
            href={ev.href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "inline-flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-full border px-3 py-1 text-[11px] shadow-sm transition-colors hover:border-brand/60 hover:text-foreground cursor-pointer",
              classForEvent(ev),
            )}
            title={`${formatRelativeTime(ev.at)} - ${hrefTitle}`}
          >
            <SystemEventPillContent event={ev} Icon={Icon} />
          </a>
          <span className="h-px flex-1 max-w-[18%] bg-hairline" />
        </div>
      );
    }
    return (
      <div className="my-1 flex items-center justify-center gap-3">
        <span className="h-px flex-1 max-w-[18%] bg-hairline" />
        <span
          className={cn(
            "inline-flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-full border px-3 py-1 text-[11px] shadow-sm",
            classForEvent(ev),
          )}
          title={formatRelativeTime(ev.at)}
        >
          <SystemEventPillContent event={ev} Icon={Icon} />
        </span>
        <span className="h-px flex-1 max-w-[18%] bg-hairline" />
      </div>
    );
  }

  if (row.kind === "pending") {
    const j = row.data;
    const meta = pendingJobMeta(j);
    const blocked = meta.tone === "amber" || meta.tone === "red";
    const retrying = retryingJobIds?.has(j.id) ?? false;
    const canRetry = j.status === "FAILED" && Boolean(onRetryOutbound);
    // We render a right-aligned bubble that mimics the agent reply look
    // (purple, dashed border to signal "not yet committed"). When the
    // cron actually delivers the reply, the API stops returning this job
    // in `pendingOutboundJobs` and the next ticket-detail refetch
    // replaces this transient bubble with the permanent HelpdeskMessage.
    return (
      <div className="group/msg flex flex-row-reverse gap-3 py-0.5">
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
                meta.tone === "red"
                  ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
                  : meta.tone === "amber"
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : meta.tone === "blue"
                    ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
              )}
              title={meta.detail}
            >
              {meta.label}
            </span>
            {canRetry ? (
              <button
                type="button"
                onClick={() => onRetryOutbound?.(j.id)}
                disabled={retrying}
                className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-red-500/35 bg-red-500/10 px-1.5 text-[10px] font-semibold text-red-700 transition-colors hover:bg-red-500/15 disabled:cursor-wait disabled:opacity-60 dark:text-red-300 cursor-pointer"
                title="Retry this failed reply through the normal outbound worker"
              >
                <RefreshCw
                  className={cn("h-3 w-3", retrying && "animate-spin")}
                />
                Retry
              </button>
            ) : null}
            {j.composerMode === "EXTERNAL" ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-sky-500/45 bg-sky-400/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-sky-800 shadow-sm dark:text-sky-200"
                title="This queued message will send as an external email through Resend."
              >
                <Mail className="h-3 w-3" />
                External email
              </span>
            ) : null}
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
              "rounded-md border border-dashed px-3 py-2 leading-[1.5] opacity-90 shadow-sm",
              meta.tone === "red"
                ? "border-red-500/50 bg-red-50 text-foreground dark:bg-red-950/20"
                : blocked
                ? "border-amber-500/50 bg-amber-50 text-foreground dark:bg-amber-950/20"
                : agentAccent.bubble,
            )}
            style={{ fontSize: `${messageFontSizePx}px` }}
          >
            <p className="whitespace-pre-wrap">{j.bodyText}</p>
            {blocked ? (
              <p className="mt-2 rounded border border-current/20 bg-background/30 px-2 py-1 text-[11px] opacity-90">
                {meta.detail}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (row.kind === "note") {
    const n = row.data;
    return (
      <div
        className="rounded-md border border-amber-300 bg-amber-100 px-3 py-2 text-amber-950 shadow-sm shadow-amber-950/10 dark:border-amber-300 dark:bg-amber-100 dark:text-amber-950"
        // Slight tilt + paper-edge shadow give the note that "post-it"
        // affordance the user asked for. Kept very subtle so it doesn't
        // feel cartoonish in the rest of a clean dashboard.
      >
        <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-amber-800 dark:text-amber-800">
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
        <p
          className="whitespace-pre-wrap text-amber-950 dark:text-amber-950"
          style={{ fontSize: `${messageFontSizePx}px` }}
        >
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
  const isExternalEmail = m.source === "EXTERNAL_EMAIL";
  const externalEmailLine =
    isExternalEmail && m.externalEmail
      ? isInbound
        ? formatExternalEmailLine("From", [m.externalEmail.from].filter(isString))
        : formatExternalEmailLine("To", m.externalEmail.to)
      : null;
  const externalEmailTitle =
    isExternalEmail && m.externalEmail
      ? externalEmailTitleFor(m.externalEmail, isInbound)
      : undefined;

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
              <span className="opacity-50">-</span>
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
            - {formatDateTime(m.sentAt)}
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
  const translationText = isInbound
    ? plainTextForTranslation(m.bodyText, m.isHtml)
    : "";

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
    ? "border-hairline bg-card/95 text-foreground"
    : isAR
      ? cn(agentAccent.bubble, "border-dashed opacity-90")
      : agentAccent.bubble;

  return (
    <div className={cn("group/msg flex gap-3 py-0.5", sideClass)}>
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
          {isExternalEmail && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-orange-500/45 bg-orange-400/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-orange-800 shadow-sm dark:text-orange-200"
              title={
                isInbound
                  ? "This buyer reply arrived through the Help Desk external email inbox."
                  : "This reply was sent through the Help Desk external email channel."
              }
            >
              <Mail className="h-3 w-3" />
              {isInbound ? "Replied external email" : "Sent external email"}
            </span>
          )}
          {externalEmailLine ? (
            <span
              className="min-w-0 max-w-full truncate text-[11px] font-medium text-orange-700 dark:text-orange-200"
              title={externalEmailTitle}
            >
              {externalEmailLine}
            </span>
          ) : null}
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
            "rounded-md border px-3 py-2 text-[13px] leading-[1.5] shadow-sm",
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
            style={{ fontSize: `${messageFontSizePx}px` }}
          />

          {isInbound && translationText ? (
            <MessageTranslationPanel
              messageId={m.id}
              sourceText={translationText}
            />
          ) : null}

          {inlineImages.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {inlineImages.map((img, idx) => (
                <button
                  key={`${idx}-${ebayImageDedupeKey(img.url)}`}
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

          {!isInbound &&
            isExternalEmail &&
            m.externalAttachments &&
            m.externalAttachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {m.externalAttachments.map((att) => {
                  const isPdf =
                    att.mimeType.toLowerCase().includes("pdf") ||
                    /\.pdf$/i.test(att.fileName);
                  const isImage = att.mimeType.toLowerCase().startsWith("image/");
                  return (
                    <a
                      key={`${att.downloadHref}:${att.fileName}`}
                      href={att.downloadHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(
                        "inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md border border-hairline bg-surface px-3 py-2 text-xs font-medium text-foreground shadow-sm transition-colors hover:border-brand/40 hover:bg-surface-2",
                      )}
                      title={`Download ${att.fileName}`}
                    >
                      {isPdf ? (
                        <FileText
                          className="h-9 w-9 shrink-0 text-red-600 dark:text-red-400"
                          aria-hidden
                        />
                      ) : isImage ? (
                        // Same-origin cookie auth — browser sends session on img GET.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={att.downloadHref}
                          alt=""
                          className="h-12 w-12 shrink-0 rounded border border-hairline object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <Download
                          className="h-8 w-8 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{att.fileName}</span>
                    </a>
                  );
                })}
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

function isString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function formatExternalEmailLine(label: "To" | "From", values: string[]): string | null {
  const clean = values.map((value) => value.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  const first = clean[0];
  return clean.length === 1
    ? `${label} ${first}`
    : `${label} ${first} +${clean.length - 1}`;
}

function externalEmailTitleFor(
  email: NonNullable<HelpdeskTicketDetail["messages"][number]["externalEmail"]>,
  isInbound: boolean,
): string {
  const rows: string[] = [];
  if (email.from) rows.push(`From: ${email.from}`);
  if (email.to.length > 0) rows.push(`To: ${email.to.join(", ")}`);
  if (email.cc.length > 0) rows.push(`Cc: ${email.cc.join(", ")}`);
  if (!isInbound && email.bcc.length > 0) rows.push(`Bcc: ${email.bcc.join(", ")}`);
  if (email.replyTo) rows.push(`Reply-To: ${email.replyTo}`);
  return rows.join("\n");
}

// Suppress unused import warning for the rotation icon — we may use it
// later for a "reopened" event variant; keep the import so that change is
// a one-line addition.
void RotateCcw;
