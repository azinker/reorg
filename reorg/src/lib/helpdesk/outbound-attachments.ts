export const EBAY_IMAGE_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/webp",
] as const;

export const EBAY_IMAGE_ATTACHMENT_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".avif",
  ".heic",
  ".heif",
  ".webp",
] as const;

export const EBAY_IMAGE_ATTACHMENT_ACCEPT =
  "image/jpeg,image/png,image/gif,image/bmp,image/tiff,image/avif,image/heic,image/heif,image/webp,.jpg,.jpeg,.png,.gif,.bmp,.tif,.tiff,.avif,.heic,.heif,.webp";

/** External (Resend) email: images plus PDF; eBay replies stay images-only. */
export const EXTERNAL_EMAIL_ATTACHMENT_ACCEPT = `${EBAY_IMAGE_ATTACHMENT_ACCEPT},application/pdf,.pdf`;

export const MAX_EBAY_IMAGE_ATTACHMENTS = 5;
export const MAX_EBAY_IMAGE_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const EBAY_IMAGE_MIME_SET = new Set<string>(EBAY_IMAGE_ATTACHMENT_MIME_TYPES);
const EBAY_IMAGE_EXTENSION_SET = new Set<string>(EBAY_IMAGE_ATTACHMENT_EXTENSIONS);

export interface QueuedHelpdeskAttachment {
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface EbayMessageMediaInput {
  mediaName: string;
  mediaType: "IMAGE";
  mediaUrl: string;
}

function extensionOf(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  return idx >= 0 ? fileName.slice(idx).toLowerCase() : "";
}

export function normalizeAttachmentFileName(fileName: string): string {
  const cleaned = fileName
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 100) || "attachment";
}

export function inferEbayImageMimeType(fileName: string, declared: string): string {
  const normalized = declared.trim().toLowerCase();
  if (EBAY_IMAGE_MIME_SET.has(normalized)) {
    return normalized === "image/jpg" ? "image/jpeg" : normalized;
  }
  switch (extensionOf(fileName)) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".avif":
      return "image/avif";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    case ".webp":
      return "image/webp";
    default:
      return normalized;
  }
}

export function validateEbayImageAttachment(input: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}): string | null {
  if (input.sizeBytes <= 0) return `${input.fileName} is empty.`;
  if (input.sizeBytes > MAX_EBAY_IMAGE_ATTACHMENT_BYTES) {
    return `${input.fileName} is too large. eBay accepts images up to 12 MB.`;
  }

  const mimeType = inferEbayImageMimeType(input.fileName, input.mimeType);
  const ext = extensionOf(input.fileName);
  const validMime = EBAY_IMAGE_MIME_SET.has(mimeType);
  const validExt = EBAY_IMAGE_EXTENSION_SET.has(ext);
  if (!validMime && !validExt) {
    return `${input.fileName} is not an eBay-supported image type. Use JPG, GIF, PNG, BMP, TIFF, AVIF, HEIC, or WEBP.`;
  }
  return null;
}

export type HelpdeskOutboundAttachmentMode = "REPLY" | "EXTERNAL";

export function inferOutboundAttachmentMimeType(
  fileName: string,
  declared: string,
  options: { allowPdf: boolean },
): string {
  if (options.allowPdf) {
    if (extensionOf(fileName) === ".pdf") return "application/pdf";
    const normalized = declared.trim().toLowerCase();
    if (normalized === "application/pdf") return "application/pdf";
  }
  return inferEbayImageMimeType(fileName, declared);
}

/** REPLY: images only (eBay). EXTERNAL: images + PDF for Resend. */
export function validateOutboundAttachment(input: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  mode: HelpdeskOutboundAttachmentMode;
}): string | null {
  const allowPdf = input.mode === "EXTERNAL";
  const mimeType = inferOutboundAttachmentMimeType(input.fileName, input.mimeType, {
    allowPdf,
  });
  if (allowPdf && mimeType === "application/pdf") {
    if (input.sizeBytes <= 0) return `${input.fileName} is empty.`;
    if (input.sizeBytes > MAX_EBAY_IMAGE_ATTACHMENT_BYTES) {
      return `${input.fileName} is too large. Attachments must be 12 MB or smaller.`;
    }
    const ext = extensionOf(input.fileName);
    if (ext !== ".pdf" && input.mimeType.trim().toLowerCase() !== "application/pdf") {
      return `${input.fileName} is not a PDF.`;
    }
    return null;
  }
  return validateEbayImageAttachment({
    fileName: input.fileName,
    mimeType,
    sizeBytes: input.sizeBytes,
  });
}

export function isQueuedHelpdeskAttachment(
  value: unknown,
): value is QueuedHelpdeskAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.storageKey === "string" &&
    row.storageKey.length > 0 &&
    typeof row.fileName === "string" &&
    row.fileName.length > 0 &&
    typeof row.mimeType === "string" &&
    row.mimeType.length > 0 &&
    typeof row.sizeBytes === "number" &&
    Number.isFinite(row.sizeBytes)
  );
}

export function readQueuedHelpdeskAttachments(
  metadata: unknown,
): QueuedHelpdeskAttachment[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }
  const value = (metadata as Record<string, unknown>).attachments;
  if (!Array.isArray(value)) return [];
  return value.filter(isQueuedHelpdeskAttachment);
}
