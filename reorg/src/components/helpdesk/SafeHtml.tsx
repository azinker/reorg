"use client";

/**
 * Render eBay-supplied HTML message bodies safely.
 *
 * eBay returns inbound shipping/order notifications as HTML (full <html><body>
 * documents with inline CSS, tables, and tracking pixels). Showing the raw
 * markup as text is unreadable; passing it to dangerouslySetInnerHTML directly
 * is unsafe.
 *
 * eBay's GetMyMessages API is also unreliable about ContentType — even when
 * the body is plainly HTML, ContentType may be missing or "text/plain". We
 * therefore sniff the content ourselves and treat anything that contains
 * recognisable HTML markers as HTML.
 *
 * If the body is HTML-entity-encoded (e.g. `&lt;p&gt;hello&lt;/p&gt;` instead
 * of `<p>hello</p>`) we decode it before rendering. This happens occasionally
 * when eBay double-escapes the payload inside the SOAP envelope.
 *
 * Beyond plain DOMPurify, this component runs a *second* pass that strips the
 * eBay marketing chrome (giant logo banner, "Reply" / "Make an offer" call-to-
 * action tables, tracking pixels, and other quoted-email noise). The goal
 * mirrors eDesk: surface the buyer's actual message text first, keep any
 * supporting attachments small, and drop everything else.
 *
 * Anything that has no HTML markers at all is rendered as preserved-whitespace
 * plain text, so multi-line auto-responder messages keep their formatting.
 */

import DOMPurify from "isomorphic-dompurify";
import { useEffect, useMemo, useState } from "react";

interface SafeHtmlProps {
  html: string;
  /** When true, the body is treated as HTML even if it doesn't sniff as such. */
  forceHtml?: boolean;
  className?: string;
}

// Match either real tags (<p>, <br/>, <table>) OR entity-encoded tags
// (&lt;p&gt;) — eBay sometimes double-escapes the body. We deliberately keep
// the tag list broad: any presence of one of these reliable HTML markers
// means we should render through the sanitiser instead of as plain text.
const HTML_TAG_NAMES =
  "html|body|head|table|thead|tbody|tfoot|tr|td|th|div|p|br|hr|span|img|a|h[1-6]|ul|ol|li|strong|em|b|i|u|font|center|blockquote|pre|code";
const HTML_HINT = new RegExp(`<\\/?(?:${HTML_TAG_NAMES})\\b`, "i");
const HTML_ENTITY_HINT = new RegExp(`&lt;\\/?(?:${HTML_TAG_NAMES})\\b`, "i");
// HTML entity references (&amp; &nbsp; &#39; &#x27; etc.) — on their own
// these don't *prove* the content is HTML, but combined with one of the tag
// hints above they reinforce the decision and tell us we should decode them.
const ENTITY_REF = /&(?:amp|lt|gt|quot|apos|nbsp|copy|reg|trade|hellip|mdash|ndash|#\d+|#x[0-9a-fA-F]+);/;

// `isomorphic-dompurify` re-exports the runtime API but doesn't surface the
// `Config` type as a usable namespace, so derive it from the sanitize signature.
type PurifyConfig = NonNullable<Parameters<typeof DOMPurify.sanitize>[1]>;

const PURIFY_CONFIG: PurifyConfig = {
  // We always operate on a body fragment, never a full document. Anything in
  // <head> (link, meta, style, title) is dropped wholesale.
  WHOLE_DOCUMENT: false,
  ALLOWED_TAGS: [
    "a", "b", "i", "u", "em", "strong", "small", "sub", "sup",
    "p", "br", "hr", "blockquote", "pre", "code",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
    "div", "span", "section", "article", "header", "footer", "nav",
    "img", "figure", "figcaption",
    "details", "summary",
  ],
  ALLOWED_ATTR: [
    "href", "title", "alt", "src", "width", "height",
    "target", "rel",
    "colspan", "rowspan", "align", "valign",
  ],
  // Lock URLs to safe schemes only. eBay sometimes embeds tracking-pixel
  // images via cid: which would 404 anyway — we drop them.
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpe?g|webp|gif);)/i,
  // We deliberately drop <style>, <link>, <meta>, <font>, and <center> so the
  // sender's inline CSS can't leak background colors / oversized fonts into
  // our chat bubbles. We render with our own typography. <font> and inline
  // style/class attributes are stripped via FORBID_ATTR.
  FORBID_TAGS: [
    "script", "style", "iframe", "object", "embed",
    "form", "input", "button", "select", "textarea",
    "link", "meta", "title", "head",
    "font", "center",
  ],
  FORBID_ATTR: [
    "style", "class", "id", "color", "bgcolor",
    "cellpadding", "cellspacing", "border",
    "onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur",
    "onsubmit", "onchange", "onkeydown", "onkeyup", "onkeypress",
  ],
};

/**
 * Hosts that serve eBay's marketing assets. Images/links pointing at these
 * are aggressively pruned during the post-sanitize pass.
 */
const EBAY_CHROME_HOSTS = /\b(?:ebaystatic|ebayimg|ebay\.com\/img|i\.ebayimg|p\.ebaystatic)/i;

/**
 * Visible text from CTA buttons eBay attaches to every member-message email.
 * We keep the underlying link (so an agent can still click through if the
 * conversation ever needs it) but rip out the surrounding visual chrome.
 */
const EBAY_CTA_TEXT = /\b(?:reply|make an offer|view order|view item|leave feedback|track package|track shipment)\b/i;

/**
 * Phrases that mark "footer / quoted email chrome" sections. Any block
 * (table row, table cell, paragraph, div) whose visible text starts with one
 * of these is dropped wholesale. eBay appends this same boilerplate to every
 * outbound notification, and it dominates the bubble visually if we keep it.
 */
const EBAY_FOOTER_PHRASES = [
  /^email reference id\s*[:\-]/i,
  /^we don'?t check this mailbox/i,
  /^ebay sent this message to/i,
  /^learn more about (?:account protection|our privacy notice|user agreement)/i,
  /^ebay is committed to your privacy/i,
  /^©?\s*\d{4}\s*[-–]?\s*\d{0,4}\s*ebay\b/i,
  /^©?\s*\d{4}\s*ebay\b/i,
  /\d{4}-?\d{0,4}\s*ebay inc\.?,/i,
  /^to make sure (?:future )?messages from .* aren'?t marked/i,
  /^this message was sent to you by ebay/i,
  /^you are receiving this email because/i,
  /^view the conversation on ebay/i,
  /^do not reply to this email/i,
  /\b2145 hamilton avenue\b/i,
];

/**
 * Decode the most common HTML entities found in eBay payloads. We use a
 * regex/lookup-table rather than DOMParser so this is identical on the
 * server and the client — DOMPurify (called next) handles anything more
 * exotic that survives.
 */
function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(?:(amp|lt|gt|quot|apos|nbsp|copy|reg|trade|hellip|mdash|ndash)|#(\d+)|#x([0-9a-fA-F]+));/g,
    (_match, named: string | undefined, dec: string | undefined, hex: string | undefined) => {
      if (named) {
        const map: Record<string, string> = {
          amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
          copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
        };
        return map[named] ?? _match;
      }
      const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
      if (!Number.isFinite(code) || code <= 0) return _match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return _match;
      }
    },
  );
}

/** Decide whether a body should be treated as HTML, after entity-decoding. */
function detectHtml(body: string, forceHtml: boolean | undefined): { isHtml: boolean; decoded: string } {
  // 1. If caller is sure, trust them — but still entity-decode in case
  //    eBay double-escaped the payload.
  if (forceHtml) {
    const decoded = ENTITY_REF.test(body) ? decodeHtmlEntities(body) : body;
    return { isHtml: true, decoded };
  }
  // 2. Plain HTML — has real tags.
  if (HTML_HINT.test(body)) {
    return { isHtml: true, decoded: body };
  }
  // 3. Entity-encoded HTML — has &lt;tag patterns. Decode once.
  if (HTML_ENTITY_HINT.test(body)) {
    return { isHtml: true, decoded: decodeHtmlEntities(body) };
  }
  // 4. Plain text. Decode entity references so users see "you're" instead
  //    of "you&#39;re".
  if (ENTITY_REF.test(body)) {
    return { isHtml: false, decoded: decodeHtmlEntities(body) };
  }
  return { isHtml: false, decoded: body };
}

/**
 * Second-pass cleanup that runs in the browser after DOMPurify. We move
 * through the rendered DOM and remove eBay's marketing chrome so what's left
 * looks like a normal chat message — the actual buyer text. Server-side this
 * is a no-op because there's no DOMParser; the next render in the browser
 * picks up the cleanup automatically.
 */
function stripEbayChrome(html: string): string {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    return html;
  }
  const doc = new DOMParser().parseFromString(
    `<!doctype html><body>${html}</body>`,
    "text/html",
  );
  const body = doc.body;

  // 1. Drop eBay marketing images (logo banners, badge graphics, tracking
  //    pixels) and tiny 1x1 spacers.
  for (const img of Array.from(body.querySelectorAll("img"))) {
    const src = (img.getAttribute("src") ?? "").trim();
    const w = parseInt(img.getAttribute("width") ?? "0", 10);
    const h = parseInt(img.getAttribute("height") ?? "0", 10);
    const isTrackingPixel = w === 1 && h === 1;
    const isEbayChrome = EBAY_CHROME_HOSTS.test(src);
    if (isTrackingPixel || isEbayChrome) {
      img.remove();
    }
  }

  // 2. Drop CTA links eBay tacks on at the bottom ("Reply", "Make an offer").
  //    Also drop Google Translate "EN/ES/etc" links — eBay embeds a translate
  //    button whose href is the entire raw HTML body URL-encoded, which is
  //    enormous and leaks into accessibility snapshots.
  for (const link of Array.from(body.querySelectorAll("a"))) {
    const text = (link.textContent ?? "").trim();
    const href = link.getAttribute("href") ?? "";
    if (
      text.length > 0 &&
      text.length < 30 &&
      EBAY_CTA_TEXT.test(text) &&
      /ebay\.com/i.test(href)
    ) {
      link.remove();
      continue;
    }
    if (/^https?:\/\/(?:www\.)?translate\.google\./i.test(href)) {
      link.remove();
    }
  }

  // 2b. Drop entire footer blocks. We walk every potentially-block-level
  //     element and check its direct visible text against our phrase list.
  //     If it matches, we remove the smallest containing "block" (tr or
  //     standalone div/p) so we don't accidentally strip the buyer's text
  //     above it.
  for (const el of Array.from(
    body.querySelectorAll("td, p, div, span"),
  )) {
    const text = (el.textContent ?? "").trim();
    if (text.length === 0 || text.length > 600) continue;
    const matches = EBAY_FOOTER_PHRASES.some((re) => re.test(text));
    if (!matches) continue;
    // Walk up to the nearest <tr> if we're inside a layout table — eBay
    // wraps every footer line in its own table row. Falling back to the
    // element itself keeps non-table footers from leaking through.
    const row = el.closest("tr");
    if (row && body.contains(row)) {
      row.remove();
    } else {
      el.remove();
    }
  }

  // 2c. Drop tables/rows that are entirely made up of social/legal links
  //     (Facebook / Twitter / Instagram / privacy-policy footers).
  for (const tr of Array.from(body.querySelectorAll("tr"))) {
    const links = Array.from(tr.querySelectorAll("a"));
    const text = (tr.textContent ?? "").trim();
    if (links.length >= 2 && text.length < 200) {
      const social = links.every((l) => {
        const href = (l.getAttribute("href") ?? "").toLowerCase();
        return /facebook|twitter|instagram|youtube|pinterest|tiktok|linkedin|ebayinc\.com|policies\.ebay\.com|privacy/i.test(
          href,
        );
      });
      if (social) tr.remove();
    }
  }

  // 2d. Collapse quoted reply history into a <details> toggle. eBay emails
  //     embed the entire prior conversation underneath the new message text
  //     using sentinels like "Your previous message", "On Mon, Apr 1, 2026
  //     at 10:00 AM <name> wrote:", or a localized "Wrote:" label. Showing
  //     all of it inline makes one bubble look like a stack of duplicates,
  //     but stripping it loses information. The compromise: wrap everything
  //     from the first sentinel forward into a collapsed <details> block so
  //     the new content reads cleanly, and the agent can expand the prior
  //     thread when needed.
  //
  //     Strategy: locate the sentinel element, walk up the tree to the
  //     CHILD-OF-BODY ancestor that contains it, and collapse that ancestor
  //     plus all of its following siblings into the <details>. eBay nests
  //     the quoted message in deeply-wrapped layout tables, so working at
  //     the body-child level guarantees we capture the entire quoted block
  //     (including any subsequent quoted messages) rather than just the
  //     innermost <tr>.
  const QUOTE_SENTINELS = [
    /^your previous message\b/i,
    /^on .+ wrote\s*:?\s*$/i,
    /^-{2,}\s*original message\s*-{2,}/i,
    /^begin forwarded message/i,
    /^from:\s*.+\s*\nsent:\s*/i,
  ];
  let quoteSentinelEl: Element | null = null;
  for (const el of Array.from(body.querySelectorAll("p, h1, h2, h3, h4, div, td, blockquote"))) {
    const text = (el.textContent ?? "").trim();
    if (text.length === 0 || text.length > 400) continue;
    if (!QUOTE_SENTINELS.some((re) => re.test(text))) continue;
    quoteSentinelEl = el;
    break;
  }
  if (quoteSentinelEl && body.contains(quoteSentinelEl)) {
    // Walk up until the parent IS the body. That gives us the topmost
    // ancestor whose siblings (forward) safely encompass the rest of the
    // quoted content.
    let topAncestor: Element = quoteSentinelEl;
    while (topAncestor.parentElement && topAncestor.parentElement !== body) {
      topAncestor = topAncestor.parentElement;
    }
    if (topAncestor.parentElement === body) {
      const collected: Element[] = [];
      let cursor: Element | null = topAncestor;
      while (cursor) {
        collected.push(cursor);
        cursor = cursor.nextElementSibling;
      }
      if (collected.length > 0) {
        const details = doc.createElement("details");
        details.className = "helpdesk-quoted-history";
        const summary = doc.createElement("summary");
        summary.textContent = "Show quoted thread history";
        details.appendChild(summary);
        const wrapper = doc.createElement("div");
        for (const el of collected) {
          wrapper.appendChild(el);
        }
        details.appendChild(wrapper);
        body.appendChild(details);
      }
    }
  }

  // 2e. Drop the eBay-injected "New message:" preview header that sits at
  //     the top of every notification email. The actual body text is
  //     repeated again below as the real message content. Showing both
  //     makes every bubble appear to start with a duplicate sentence.
  for (const el of Array.from(body.querySelectorAll("p, td, div"))) {
    const text = (el.textContent ?? "").trim();
    if (!/^new message\s*:/i.test(text)) continue;
    // Only strip if the same text appears elsewhere in the body — that's
    // the duplicate-preview signal. Otherwise keep it.
    const dup = body.textContent?.match(
      new RegExp(text.slice(13).slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
    );
    if (dup && dup.length > 1) {
      const row = el.closest("tr") ?? el;
      row.remove();
      break;
    }
  }

  // 2f. Drop the "New message from: <buyer>" header eBay inserts. It
  //     duplicates the sender chip we already render at the top of every
  //     bubble.
  for (const h of Array.from(body.querySelectorAll("h1, h2, h3"))) {
    const text = (h.textContent ?? "").trim();
    if (/^new message from\b/i.test(text)) {
      const row = h.closest("tr") ?? h;
      row.remove();
    }
  }

  // 2g. Drop "Dear <name>," salutation lines that sit at the very start of
  //     the body. eBay emails always open with one. We keep them if the
  //     buyer wrote them in the middle of a longer body (uncommon, but
  //     possible in long replies).
  for (const el of Array.from(body.querySelectorAll("p, div"))) {
    const text = (el.textContent ?? "").trim();
    if (!/^dear\s+\S+,?\s*$/i.test(text)) continue;
    // Only strip if this is one of the first ~3 visible blocks.
    let order = 0;
    let walker = el.previousElementSibling;
    while (walker) {
      if ((walker.textContent ?? "").trim().length > 0) order += 1;
      walker = walker.previousElementSibling;
    }
    if (order <= 3) {
      el.remove();
    }
  }

  // 2h. Drop trailing signature lines like "- buyername" or "- theperfectpart"
  //     that eBay appends. These duplicate the sender chip too.
  for (const el of Array.from(body.querySelectorAll("p, div"))) {
    const text = (el.textContent ?? "").trim();
    if (/^-\s*\S+\s*$/i.test(text) && text.length < 60) {
      el.remove();
    }
  }

  // 3. Collapse empty wrappers left behind by the strips above. Repeat a few
  //    passes since removing one row can leave its parent empty.
  for (let pass = 0; pass < 3; pass += 1) {
    let removed = 0;
    for (const el of Array.from(
      body.querySelectorAll("table, tbody, tr, td, div, span, p"),
    )) {
      if (
        el.children.length === 0 &&
        (el.textContent ?? "").trim().length === 0
      ) {
        el.remove();
        removed += 1;
      }
    }
    if (removed === 0) break;
  }

  return body.innerHTML;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Module-level cache + processing pipeline.
 *
 * WHY THIS MATTERS FOR PERF:
 * ──────────────────────────
 * Each eBay message body can be 50–500 KB of HTML. Sanitising one body costs
 * one DOMPurify pass (~10–50ms) plus a `stripEbayChrome` pass that creates a
 * new DOMParser document and runs a half-dozen full `querySelectorAll` walks
 * over hundreds of elements (~50–200ms). When a thread has 8–15 messages,
 * mounting `TicketReader` synchronously processes the entire stack in one tick
 * — easily a 1–3 second long task that blocks the click from feeling snappy.
 *
 * Two changes here remove that cost:
 *
 *   1. Cache the sanitised output in a module-level Map keyed by the raw input
 *      string. Re-opening the same ticket (or any ticket sharing the same
 *      eBay template body) returns instantly with no DOMPurify / DOMParser
 *      work at all.
 *
 *   2. On the FIRST view of a body, render a tiny shimmer placeholder
 *      synchronously and run the heavy processing inside `requestIdleCallback`
 *      (with a `setTimeout` fallback for browsers that don't support it).
 *      This breaks the work into small chunks that interleave with paint, so
 *      the click resolves immediately and the bubbles fill in over the next
 *      few frames — exactly the pattern eDesk uses.
 *
 * The cache is bounded with a simple LRU (delete-and-reinsert) policy so
 * memory can't grow without bound across long sessions.
 */

const SANITISED_CACHE_MAX = 300;
const sanitisedCache = new Map<string, string>();

function lruGet(key: string): string | undefined {
  const value = sanitisedCache.get(key);
  if (value === undefined) return undefined;
  // Re-insert to mark as most-recently-used.
  sanitisedCache.delete(key);
  sanitisedCache.set(key, value);
  return value;
}

function lruSet(key: string, value: string): void {
  if (sanitisedCache.size >= SANITISED_CACHE_MAX) {
    const oldest = sanitisedCache.keys().next().value;
    if (oldest !== undefined) sanitisedCache.delete(oldest);
  }
  sanitisedCache.set(key, value);
}

/**
 * DOMPurify hooks are global state. The previous version of this file
 * `addHook`'d/`removeAllHooks`'d on every render, which races when several
 * `SafeHtml` instances render in the same React commit (the first one's
 * `removeAllHooks` wipes the hook the others just added). Install once at
 * module load instead.
 */
let __dompurifyHookInstalled = false;
function ensureDompurifyHook() {
  if (__dompurifyHookInstalled) return;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
    if (node.tagName === "IMG") {
      node.setAttribute("loading", "lazy");
      node.setAttribute("referrerpolicy", "no-referrer");
    }
  });
  __dompurifyHookInstalled = true;
}

function computeSanitised(decoded: string): string {
  ensureDompurifyHook();
  const clean = DOMPurify.sanitize(decoded, PURIFY_CONFIG);
  return stripEbayChrome(clean);
}

type IdleCb = (cb: () => void, opts?: { timeout?: number }) => number;
type CancelIdleCb = (id: number) => void;
function scheduleIdle(cb: () => void, timeoutMs = 250): () => void {
  if (typeof window === "undefined") {
    cb();
    return () => {};
  }
  const ric = (window as unknown as { requestIdleCallback?: IdleCb }).requestIdleCallback;
  const cic = (window as unknown as { cancelIdleCallback?: CancelIdleCb }).cancelIdleCallback;
  if (ric) {
    const id = ric(cb, { timeout: timeoutMs });
    return () => cic?.(id);
  }
  const id = window.setTimeout(cb, 0);
  return () => window.clearTimeout(id);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Serialised processing queue.
 *
 * `requestIdleCallback` happily runs every queued callback in a single idle
 * slice if there's enough budget — which means 5 SafeHtml instances scheduled
 * in the same React commit can chain into one ~1.5 second long task instead
 * of 5 separate small ones. The whole point of deferring sanitisation is to
 * keep individual frames short, so we explicitly serialise: at most ONE
 * sanitisation runs per macrotask, and we yield to the event loop (and to
 * paint) between each one.
 *
 * We use `MessageChannel` to schedule the next item — it's faster than
 * setTimeout(..., 0) (no 4ms clamp), runs after the current macrotask
 * completes, and lets the browser interleave input + paint work.
 * ────────────────────────────────────────────────────────────────────────── */
type SanitiseTask = () => void;
const sanitiseQueue: SanitiseTask[] = [];
let sanitiseFlushScheduled = false;
let sanitiseChannel: MessageChannel | null = null;

function flushSanitiseQueue() {
  sanitiseFlushScheduled = false;
  // Pop one task. Even big eBay bodies are <250ms; one per macrotask keeps
  // frame budgets healthy and lets paint/input get a turn between bubbles.
  const task = sanitiseQueue.shift();
  if (task) {
    try {
      task();
    } catch {
      // swallow — the failing component will fall back to its placeholder
    }
  }
  if (sanitiseQueue.length > 0) scheduleSanitiseFlush();
}

function scheduleSanitiseFlush() {
  if (sanitiseFlushScheduled) return;
  sanitiseFlushScheduled = true;
  if (typeof window === "undefined") {
    flushSanitiseQueue();
    return;
  }
  if (!sanitiseChannel) {
    try {
      sanitiseChannel = new MessageChannel();
      sanitiseChannel.port1.onmessage = () => flushSanitiseQueue();
    } catch {
      sanitiseChannel = null;
    }
  }
  if (sanitiseChannel) {
    sanitiseChannel.port2.postMessage(0);
  } else {
    window.setTimeout(flushSanitiseQueue, 0);
  }
}

function enqueueSanitise(cb: SanitiseTask): () => void {
  sanitiseQueue.push(cb);
  scheduleSanitiseFlush();
  let cancelled = false;
  return () => {
    if (cancelled) return;
    cancelled = true;
    const idx = sanitiseQueue.indexOf(cb);
    if (idx >= 0) sanitiseQueue.splice(idx, 1);
  };
}

export function SafeHtml({ html, forceHtml, className }: SafeHtmlProps) {
  const { isHtml, decoded } = useMemo(
    () => detectHtml(html ?? "", forceHtml),
    [html, forceHtml],
  );

  // Synchronous cache check on first render. If we've already processed this
  // exact body in this session (different ticket sharing the same eBay
  // template, or re-opening this ticket) the bubble paints with the final
  // sanitised HTML on the very first frame — zero extra work, zero flicker.
  const initialCached = isHtml ? lruGet(decoded) ?? null : null;
  const [sanitised, setSanitised] = useState<string | null>(initialCached);

  useEffect(() => {
    if (!isHtml) {
      if (sanitised !== null) setSanitised(null);
      return;
    }
    const cached = lruGet(decoded);
    if (cached !== undefined) {
      if (cached !== sanitised) setSanitised(cached);
      return;
    }
    // Uncached → enqueue for serialised idle processing. The bubble shows a
    // shimmer placeholder until the result is ready, but the click that
    // opened this ticket has long since resolved. Multiple bubbles in the
    // same thread run one-per-macrotask so they don't chain into one
    // multi-second long task.
    let cancelled = false;
    const cancel = enqueueSanitise(() => {
      if (cancelled) return;
      const result = computeSanitised(decoded);
      lruSet(decoded, result);
      if (!cancelled) setSanitised(result);
    });
    return () => {
      cancelled = true;
      cancel();
    };
    // We deliberately do not include `sanitised` in deps — it's an output
    // of this effect, including it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decoded, isHtml]);

  if (!isHtml) {
    return (
      <div className={className}>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
          {decoded || (
            <span className="italic text-muted-foreground">
              (empty message body)
            </span>
          )}
        </p>
      </div>
    );
  }

  // First view of this body — show a shimmer skeleton synchronously. The
  // useEffect above will swap this out once idle processing finishes,
  // typically within a frame or two. This is the single biggest perceived
  // perf win: clicks register instantly even on huge eBay payloads.
  if (sanitised === null) {
    return (
      <div className={`space-y-2 ${className ?? ""}`}>
        <div className="h-3 w-3/4 animate-pulse rounded bg-foreground/10" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-foreground/10" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-foreground/10" />
      </div>
    );
  }

  // After DOMPurify + stripEbayChrome we may end up with literally nothing
  // (e.g. a quoted-only "Re:" mail where the buyer added no new text). Show
  // a friendly placeholder so the bubble isn't visually empty.
  const trimmed = sanitised.trim();
  if (trimmed.length === 0) {
    return (
      <p className={`text-xs italic text-muted-foreground ${className ?? ""}`}>
        (No new message text — only quoted content from eBay.)
      </p>
    );
  }

  return (
    <div
      className={`helpdesk-html-body max-w-full overflow-x-auto text-sm leading-relaxed text-foreground/90 ${className ?? ""}`}
      // eslint-disable-next-line react/no-danger -- sanitised by DOMPurify above
      dangerouslySetInnerHTML={{ __html: sanitised }}
    />
  );
}
