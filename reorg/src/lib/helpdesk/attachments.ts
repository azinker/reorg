/**
 * Pure helpers for inbound message attachments.
 *
 * Lives outside the React component so it can be unit-tested in Node and
 * reused server-side (e.g. dashboard preview, API normalisation) without
 * dragging in the "use client" boundary.
 */

export interface ParsedAttachment {
  url: string;
  isImage: boolean;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp)(\?|$)/i;

/**
 * Normalise an arbitrary `rawMedia` JSON blob (as stored on
 * HelpdeskMessage.rawMedia) into a list of safely-renderable URLs.
 *
 * Accepts either an array of strings or an array of objects with one of the
 * keys `url`, `URL`, or `MediaURL`. Anything else is silently dropped.
 *
 * URL hygiene:
 *   - must parse via `new URL(...)`
 *   - must be http: or https: (defends against javascript: / data: in the
 *     unlikely event the upstream payload is ever attacker-controlled)
 */
export function parseMedia(raw: unknown): ParsedAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedAttachment[] = [];
  for (const item of raw) {
    let url: string | null = null;
    if (typeof item === "string") {
      url = item;
    } else if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      const candidate =
        row.url ??
        row.URL ??
        row.MediaURL ??
        row.mediaUrl ??
        row.mediaURL ??
        row.imageUrl ??
        row.imageURL;
      if (typeof candidate === "string") url = candidate;
    }
    if (!url) continue;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      const row = item && typeof item === "object"
        ? (item as Record<string, unknown>)
        : null;
      const mediaType =
        typeof row?.mediaType === "string"
          ? row.mediaType
          : typeof row?.MediaType === "string"
            ? row.MediaType
            : "";
      const mimeType =
        typeof row?.mimeType === "string"
          ? row.mimeType
          : typeof row?.contentType === "string"
            ? row.contentType
            : "";
      out.push({
        url,
        isImage:
          IMAGE_EXTENSIONS.test(u.pathname) ||
          mediaType.toUpperCase() === "IMAGE" ||
          mimeType.toLowerCase().startsWith("image/"),
      });
    } catch {
      // skip invalid URLs
    }
  }
  return out;
}

/**
 * Truncate a long string by replacing the middle with "..." while preserving
 * both ends. Used to keep CDN URLs visually compact in the link list.
 */
export function truncateMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 3) / 2);
  return `${s.slice(0, half)}...${s.slice(-half)}`;
}
