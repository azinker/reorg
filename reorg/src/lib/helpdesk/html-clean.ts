/**
 * Server-side HTML cleaning for helpdesk message bodies.
 *
 * Strips eBay chrome, tracking pixels, inline styles, and other bloat
 * BEFORE storing in the DB, reducing storage by ~60-80% per message.
 *
 * This mirrors what SafeHtml.tsx does at render time on the client,
 * but applied at ingest so we never store the bloat in the first place.
 */

const EBAY_CHROME_HOST_RE =
  /ebaystatic\.com|pics\.ebaystatic|pages\.ebay\.com\/img|ir\.ebaystatic/i;

const TRACKING_PIXEL_RE =
  /<img[^>]*(?:width\s*=\s*["']?1["']?|height\s*=\s*["']?1["']?)[^>]*\/?>/gi;

const STYLE_ATTR_RE = /\s+(?:style|class|id|data-[\w-]+|bgcolor|background|align|valign|border|cellpadding|cellspacing|width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

const EMPTY_TAG_RE = /<(span|div|p|font|b|i|u|em|strong|center|table|tr|td|th|tbody|thead)\b[^>]*>\s*<\/\1>/gi;

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

const EBAY_CHROME_IMG_RE = new RegExp(
  `<img[^>]*src\\s*=\\s*["']https?://[^"']*(?:${EBAY_CHROME_HOST_RE.source})[^"']*["'][^>]*/?>`,
  "gi",
);

const MULTI_BR_RE = /(<br\s*\/?\s*>[\s\n]*){3,}/gi;
const MULTI_NBSP_RE = /(&nbsp;\s*){3,}/gi;
const MULTI_NEWLINE_RE = /\n{3,}/g;

/**
 * Strip eBay HTML chrome and bloat from a message body.
 * Safe to call on both HTML and plain-text bodies.
 */
export function cleanMessageHtml(html: string): string {
  if (!html) return html;

  let cleaned = html;

  cleaned = cleaned.replace(HTML_COMMENT_RE, "");
  cleaned = cleaned.replace(TRACKING_PIXEL_RE, "");
  cleaned = cleaned.replace(EBAY_CHROME_IMG_RE, "");
  cleaned = cleaned.replace(STYLE_ATTR_RE, "");

  // Collapse empty tags (run twice for nested empties)
  cleaned = cleaned.replace(EMPTY_TAG_RE, "");
  cleaned = cleaned.replace(EMPTY_TAG_RE, "");

  // Collapse excessive whitespace
  cleaned = cleaned.replace(MULTI_BR_RE, "<br/><br/>");
  cleaned = cleaned.replace(MULTI_NBSP_RE, "&nbsp;");
  cleaned = cleaned.replace(MULTI_NEWLINE_RE, "\n\n");

  return cleaned.trim();
}

/**
 * For digest envelopes that have been expanded into sub-messages,
 * extract preview image URLs before discarding the body.
 *
 * Returns array of { url, mimeType } for images found in
 * `<td id="previewImageCont...">` blocks.
 */
export function extractEnvelopePreviewImages(
  html: string,
): Array<{ url: string; mimeType: string }> {
  const out: Array<{ url: string; mimeType: string }> = [];
  if (!html) return out;

  const seen = new Set<string>();
  const push = (url: string) => {
    const normalized = url.replace(/&amp;/gi, "&");
    if (seen.has(normalized)) return;
    seen.add(normalized);
    const ext =
      normalized.split(".").pop()?.split("?")[0]?.toLowerCase() ?? "jpg";
    const mimeType =
      ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
    out.push({ url: normalized, mimeType });
  };

  // Newer eBay digest envelopes wrap buyer uploads in a previewImageCont
  // table cell. Capture only URLs inside those blocks so product thumbnails
  // elsewhere in the envelope do not become fake buyer attachments.
  const blockRe =
    /<td\b[^>]*id\s*=\s*["']previewImageCont\d*["'][^>]*>[\s\S]*?<\/td>/gi;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) !== null) {
    const imgRe =
      /<img\b[^>]*src\s*=\s*["'](https?:\/\/i\.ebayimg\.com\/[^"']+)["'][^>]*>/gi;
    let img: RegExpExecArray | null;
    while ((img = imgRe.exec(block[0])) !== null) {
      push(img[1]!);
    }
  }

  // Some historical envelopes lost the wrapping td attributes during
  // cleaning but kept the preview image id on the <img> itself. Support
  // both attribute orders.
  const previewImgRe = /<img\b[^>]*>/gi;
  let imgTag: RegExpExecArray | null;
  while ((imgTag = previewImgRe.exec(html)) !== null) {
    const tag = imgTag[0];
    if (!/id\s*=\s*["']previewimage\d*["']/i.test(tag)) continue;
    const src = /src\s*=\s*["'](https?:\/\/i\.ebayimg\.com\/[^"']+)["']/i.exec(
      tag,
    )?.[1];
    if (src) push(src);
  }

  return out;
}

const ENVELOPE_STUB = "[digest envelope – body stripped to save storage]";

/**
 * Replacement body for a digest envelope after sub-messages have been
 * extracted. Tiny string that makes it obvious the content was moved.
 */
export function envelopeStubBody(): string {
  return ENVELOPE_STUB;
}
