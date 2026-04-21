/**
 * eBay Help Desk message-digest parser.
 *
 * ─── Why this exists ──────────────────────────────────────────────────────
 * eBay's GetMyMessages API does NOT return one message at a time. Each
 * "message" body is actually a styled HTML *digest* of the entire member-to-
 * member conversation thread up to that point. The latest message sits at
 * the top inside `<div id="UserInputtedText">`, followed by previously-
 * delivered messages in `MessageHistory[N]` blocks, each carrying its own
 * `<div id="UserInputtedText[N]">` with the historical body.
 *
 * If we naively store the raw eBay body as a single HelpdeskMessage row
 * we get:
 *   1. The thread view shows ~100KB of eBay marketing chrome and template
 *      navigation per "message".
 *   2. Earlier messages from the same conversation are missing entirely
 *      from our DB unless eBay also sent us a separate, older digest.
 *   3. Auto-Responder sends and agent replies that happened directly on
 *      eBay.com never appear because they live INSIDE the digest, not as
 *      their own GetMyMessages payloads.
 *
 * This parser turns one digest body into N discrete `ParsedSubMessage`
 * records (one per `UserInputtedText[N]`), tagging each with a direction
 * (INBOUND/OUTBOUND/UNKNOWN) inferred from the surrounding heading:
 *   - The LIVE entry uses the `<h1>New message from:</h1>` (INBOUND from
 *     buyer) vs `<h1>New message to:</h1>` (OUTBOUND from seller — this
 *     is how Auto-Responder echoes show up) inside the `PrimaryMessage`
 *     table.
 *   - Each HISTORY entry uses the `<p align="center">` heading inside
 *     its enclosing `MessageHistory[N]` table — `Your previous message`
 *     is OUTBOUND, a buyer-username link (`/usr/<handle>`) is INBOUND.
 *
 * We deliberately ignore the hidden `<div id="V4PrimaryMessage[N]">`
 * blocks that look like they would carry per-message sender/recipient
 * metadata. In practice eBay always recapitulates the OUTER envelope
 * inside V4 (seller as recipient on the live message, seller as signer
 * on every history block), which is the opposite of what the heading
 * actually shows for the conversation. The MessageHistory heading is
 * the only authoritative discriminator.
 *
 * ─── What the parser does NOT do ──────────────────────────────────────────
 * - It does NOT touch the database. The result is a pure value the
 *   caller (helpdesk-ebay-sync.ts) is responsible for inserting and
 *   deduping.
 * - It does NOT synthesize fake timestamps. eBay's digest doesn't carry
 *   per-history timestamps, so historical sub-messages come back with
 *   no per-row `sentAt`. The caller is expected to keep timestamps from
 *   *earlier* digests where the same body was the live "current" entry,
 *   falling back to evenly spreading them backwards from the digest
 *   ReceiveDate when no better hint exists.
 * - It does NOT distinguish AGENT replies from AUTO_RESPONDER sends.
 *   Both surface as `direction = "outbound"`. The caller is responsible
 *   for hashing the body and matching it against the AR send-log to
 *   promote the source from AGENT (default) to AUTO_RESPONDER.
 *
 * ─── Design notes on the regex approach ───────────────────────────────────
 * We deliberately avoid pulling in a server-side DOM library (jsdom,
 * cheerio, linkedom). The eBay templates are extremely regular — every
 * `UserInputtedText[N]` is rendered by the same backend with the same
 * surrounding markup — so a tight regex pass is faster, keeps cold-start
 * times low on Vercel, and avoids the security-surface of running a real
 * HTML parser over remote content.
 *
 * If eBay ever changes the markup we'll see it as a sudden drop in
 * `parsed.subMessages.length` for new digests; the caller logs the
 * pre/post counts on every sync run for that exact reason.
 */

export interface ParsedSubMessage {
  /** 0-based position within the digest. 0 = oldest, length-1 = newest. */
  index: number;
  /**
   * Stable identifier: `<digestMessageId>:<n>` where N matches the
   * `UserInputtedText` suffix (no suffix = "0", suffix `1` = "1", etc.).
   * Used downstream as part of the `(ticketId, externalId)` upsert key
   * so re-running the parser on the same digest is idempotent.
   */
  externalId: string;
  /** Decoded HTML body (still HTML; SafeHtml will sanitize at render). */
  bodyHtml: string;
  /** Plain-text version, used for hashing + AR matching. */
  bodyText: string;
  /** SHA-1-ish stable hash of the normalized text — see `normalizeForHash`. */
  bodyHash: string;
  /**
   * Direction of this sub-message *from the seller's perspective*:
   *   - "outbound" = seller sent this to the buyer (came from the
   *     "Your previous message" heading in the digest, OR the V4 block
   *     for the live message names the seller as the signer).
   *   - "inbound"  = buyer sent this to the seller (came from a
   *     `<a href=".../usr/<buyer>">` heading in the digest).
   *   - "unknown"  = could not determine; caller should fall back to
   *     content-based heuristics (AR match, agent send-log).
   *
   * NOTE: We deliberately do NOT return seller/buyer handles per
   * sub-message because eBay's V4PrimaryMessage hidden blocks ALWAYS
   * recapitulate the *envelope* (seller as recipient for live, seller as
   * signer for history), so they're worthless for direction. The
   * MessageHistory heading is the authoritative signal.
   */
  direction: "inbound" | "outbound" | "unknown";
  /**
   * True iff this sub-message is the digest's "live" / current message
   * (i.e. matches the `<div id="UserInputtedText">` with no numeric
   * suffix). The digest's outer `ReceiveDate` is the authoritative
   * timestamp for this one entry.
   */
  isLive: boolean;
}

export interface ParsedDigest {
  /** Whether this body looked like an eBay digest at all. */
  isDigest: boolean;
  /** Sub-messages in chronological order (oldest first). */
  subMessages: ParsedSubMessage[];
}

/**
 * Decode a few common HTML entities. The full set isn't needed here —
 * eBay's templates only emit `&amp; &lt; &gt; &quot; &#39; &nbsp;` plus
 * the occasional numeric ref. Anything else falls through unchanged.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/**
 * Strip every HTML tag and collapse whitespace. We don't care about
 * formatting here — this is for hashing and AR-content matching, both
 * of which want a deterministic plain-text view.
 */
function htmlToPlainText(html: string): string {
  // <br> → newline, then strip remaining tags. We do this instead of just
  // stripping tags so the hash and AR matcher see the buyer's intended
  // line breaks.
  const withBreaks = html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/p\s*>/gi, "\n\n")
    .replace(/<\s*\/div\s*>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, "");
  return decodeEntities(stripped).replace(/\r\n/g, "\n").trim();
}

/**
 * Normalize text aggressively for hashing:
 *   - lowercase
 *   - strip every emoji / non-ascii (eBay's notification preview adds
 *     extra emojis; the AR sometimes sends with subtly different ones)
 *   - collapse whitespace
 *   - strip the order-number reference (so the SAME AR template across
 *     two different orders still hashes equally if we want it to)
 *
 * The hash is "fingerprint-strong, not crypto-strong" — we only ever
 * use it for dedupe/AR-matching, never for security.
 */
function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u{1F000}-\u{1FFFF}]|[\u2600-\u27BF]/gu, "")
    .replace(/#?\d{2}-\d{5}-\d{5}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Cheap, dependency-free 53-bit string hash (cyrb53). Stable across
 * Node and the browser. We only need collision-resistance to dedupe
 * messages within a single thread (~100s of rows), so 53 bits is many
 * orders of magnitude more than required.
 */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}

/**
 * Determine the direction of the LIVE (top-of-digest) sub-message from
 * the `<h1>New message from: <a>buyer</a></h1>` (INBOUND) versus
 * `<h1>New message to: <a>buyer</a></h1>` (OUTBOUND) heading inside the
 * `<table id="PrimaryMessage">` block.
 *
 * Auto-Responder sends end up here as OUTBOUND because eBay echoes the
 * AR send into the seller's inbox as "New message to:".
 */
function liveDirection(html: string): "inbound" | "outbound" | "unknown" {
  // Restrict the lookup to the PrimaryMessage table so we don't pick up
  // an unrelated "New message" string buried in a marketing footer.
  const primary = html.match(
    /<table\s+id="PrimaryMessage"[\s\S]*?<\/table>\s*<\/td>\s*<\/tr>\s*<\/table>/i,
  );
  const scope = primary ? primary[0] : html;
  if (/New\s+message\s+from\s*:/i.test(scope)) return "inbound";
  if (/New\s+message\s+to\s*:/i.test(scope)) return "outbound";
  return "unknown";
}

/**
 * Determine the direction of a HISTORY sub-message by looking at the
 * heading immediately above its UserInputtedText body.
 *
 * eBay uses two heading styles inside a `<table id="MessageHistoryN">`:
 *   - `<p align="center">Your previous message</p>` → OUTBOUND
 *     (this was something the seller previously sent).
 *   - `<p align="center"><a href=".../usr/buyer">buyer</a></p>` → INBOUND
 *     (the buyer authored this entry).
 *
 * We pass in the raw history block so we can scan just the heading
 * region right before the `UserInputtedText` div.
 */
function historyDirection(historyBlockHtml: string): "inbound" | "outbound" | "unknown" {
  // The heading <p> sits BEFORE <div id="UserInputtedText..."> inside
  // the same MessageHistory table. Slice off the body to avoid matching
  // a username inside the body itself.
  const cut = historyBlockHtml.split(/<div\s+id="UserInputtedText/i)[0] ?? "";
  if (/Your\s+previous\s+message/i.test(cut)) return "outbound";
  // A buyer's username heading always renders as a link inside an
  // `<a href=".../usr/...">` — that's the INBOUND signal.
  if (/<a[^>]*href="[^"]*\/usr\/[^"]+"[^>]*>[\s\S]*?<\/a>/i.test(cut)) {
    return "inbound";
  }
  return "unknown";
}

/**
 * Parse a single eBay digest body. Returns `{ isDigest: false }` for
 * anything that doesn't carry the `<div id="UserInputtedText">`
 * marker — those bodies are non-digest (system notifications,
 * pre-2014 templates, plain text replies) and the caller should
 * handle them with the legacy single-message path.
 */
export function parseEbayDigest(args: {
  bodyHtml: string;
  digestExternalId: string;
}): ParsedDigest {
  const { bodyHtml, digestExternalId } = args;
  if (!bodyHtml || typeof bodyHtml !== "string") {
    return { isDigest: false, subMessages: [] };
  }
  if (!/<div\s+id="UserInputtedText\d*"/i.test(bodyHtml)) {
    return { isDigest: false, subMessages: [] };
  }

  // 1. Pull every UserInputtedText body. The numeric suffix doubles as
  //    a stable key for dedupe and lets us pair each body with the
  //    MessageHistoryN block whose heading reveals its direction.
  type RawEntry = { suffix: string; bodyHtml: string };
  const userInputtedRe =
    /<div\s+id="UserInputtedText(\d*)"[^>]*>([\s\S]*?)<\/div>/gi;
  const entries: RawEntry[] = [];
  let m: RegExpExecArray | null;
  while ((m = userInputtedRe.exec(bodyHtml)) !== null) {
    entries.push({ suffix: m[1] ?? "", bodyHtml: m[2] });
  }
  if (entries.length === 0) {
    return { isDigest: false, subMessages: [] };
  }

  // 2. Pull every MessageHistoryN block, keyed by suffix. We need the
  //    surrounding markup so historyDirection() can read the heading.
  //    Each block is a `<table id="MessageHistoryN">` … `</table>` and
  //    eBay never nests them, so a non-greedy match is safe.
  const histRe =
    /<table\s+id="MessageHistory(\d+)"[\s\S]*?<\/table>\s*<\/td>\s*<\/tr>\s*<\/table>/gi;
  const histMap = new Map<string, string>();
  let h: RegExpExecArray | null;
  while ((h = histRe.exec(bodyHtml)) !== null) {
    histMap.set(h[1], h[0]);
  }

  // 3. Order chronologically (oldest → newest):
  //    suffix scheme = "" is the LIVE current message at the TOP of the
  //    digest, "1" is the previous message, "2" is older, etc. So
  //    chronological order is [largest-N, …, "2", "1", ""].
  const sorted = entries.slice().sort((a, b) => {
    const ai = a.suffix === "" ? -1 : Number(a.suffix);
    const bi = b.suffix === "" ? -1 : Number(b.suffix);
    // -1 (the live one) sorts to the END, larger-N to the START.
    return bi - ai;
  });

  const subs: ParsedSubMessage[] = sorted.map((entry, idx) => {
    const isLive = entry.suffix === "";
    let direction: "inbound" | "outbound" | "unknown";
    if (isLive) {
      direction = liveDirection(bodyHtml);
    } else {
      const hist = histMap.get(entry.suffix);
      direction = hist ? historyDirection(hist) : "unknown";
    }
    const text = htmlToPlainText(entry.bodyHtml);
    const hash = cyrb53(normalizeForHash(text));
    return {
      index: idx,
      externalId: `${digestExternalId}:${isLive ? "live" : entry.suffix}`,
      bodyHtml: entry.bodyHtml.trim(),
      bodyText: text,
      bodyHash: hash,
      direction,
      isLive,
    };
  });

  return { isDigest: true, subMessages: subs };
}

/**
 * Public helper: produce the same body hash the parser stores on each
 * sub-message, but starting from arbitrary input (HTML or plain text).
 *
 * Used by AR-attribution and dedupe code paths so they can compare an
 * arbitrary candidate body (e.g. a stored `AutoResponderSendLog.renderedBody`)
 * against the hashes of parsed sub-messages without re-implementing the
 * normalization rules.
 */
export function hashBodyForMatch(body: string | null | undefined): string {
  if (!body) return cyrb53("");
  // Use plain-text normalization regardless of whether the input is HTML
  // — htmlToPlainText is a no-op for input that has no tags.
  const text = htmlToPlainText(body);
  return cyrb53(normalizeForHash(text));
}
