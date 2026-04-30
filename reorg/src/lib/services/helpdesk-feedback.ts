import { HelpdeskFeedbackKind, type HelpdeskFeedback } from "@prisma/client";
import type {
  EbayConfig,
  EbayOrderContext,
  EbayOrderContextLineItem,
} from "@/lib/services/auto-responder-ebay";
import { getEbayAccessToken } from "@/lib/services/helpdesk-ebay";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const COMPAT_LEVEL = "1199";
const SITE_ID = "0";
const REQUEST_TIMEOUT_MS = 30_000;
const EBAY_AUTOMATED_FEEDBACK_COMMENTS = new Set([
  "order delivered on time with no issues",
]);

export interface HelpdeskFeedbackSnapshot {
  id: string;
  externalId: string;
  kind: HelpdeskFeedbackKind;
  starRating: number | null;
  comment: string | null;
  sellerResponse: string | null;
  ebayOrderNumber: string | null;
  ebayItemId: string | null;
  buyerUserId: string | null;
  leftAt: string;
  source: "mirror" | "live";
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function parseXmlSimple(xml: string): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { XMLParser } = require("fast-xml-parser");
    const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
    return parser.parse(xml) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asList<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : value != null
      ? String(value).trim() || null
      : null;
}

function mapFeedbackKind(value: unknown): HelpdeskFeedbackKind {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "NEGATIVE") return HelpdeskFeedbackKind.NEGATIVE;
  if (normalized === "NEUTRAL") return HelpdeskFeedbackKind.NEUTRAL;
  return HelpdeskFeedbackKind.POSITIVE;
}

function normalizeFeedbackComment(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

export function isEbayAutomatedFeedbackComment(
  value: string | null | undefined,
): boolean {
  return EBAY_AUTOMATED_FEEDBACK_COMMENTS.has(normalizeFeedbackComment(value));
}

export function isEbayAutomatedFeedbackSnapshot(
  entry: Pick<HelpdeskFeedbackSnapshot, "kind" | "comment">,
): boolean {
  return (
    entry.kind === HelpdeskFeedbackKind.POSITIVE &&
    isEbayAutomatedFeedbackComment(entry.comment)
  );
}

function rowToSnapshot(
  row: Record<string, unknown>,
  fallbackId: string,
): HelpdeskFeedbackSnapshot | null {
  const externalId =
    text(row.FeedbackID) ??
    text(row.TransactionID) ??
    text(row.OrderLineItemID) ??
    fallbackId;
  const leftAt = text(row.CommentTime);
  if (!externalId || !leftAt) return null;
  const leftAtDate = new Date(leftAt);
  if (!Number.isFinite(leftAtDate.getTime())) return null;

  return {
    id: `live:${externalId}`,
    externalId,
    kind: mapFeedbackKind(row.CommentType),
    starRating: null,
    comment: text(row.CommentText),
    sellerResponse: text(row.FeedbackResponse),
    ebayOrderNumber: null,
    ebayItemId: text(row.ItemID),
    buyerUserId: text(row.CommentingUser),
    leftAt: leftAtDate.toISOString(),
    source: "live",
  };
}

function sameBuyer(left: string | null, right: string | null): boolean {
  if (!left || !right) return true;
  return left.toLowerCase() === right.toLowerCase();
}

function uniqueSnapshots(
  snapshots: HelpdeskFeedbackSnapshot[],
): HelpdeskFeedbackSnapshot[] {
  const seen = new Set<string>();
  const out: HelpdeskFeedbackSnapshot[] = [];
  for (const entry of snapshots) {
    const key = entry.externalId || `${entry.ebayItemId}:${entry.leftAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.sort(
    (a, b) => new Date(b.leftAt).getTime() - new Date(a.leftAt).getTime(),
  );
}

export function feedbackMirrorToSnapshot(
  row: Pick<
    HelpdeskFeedback,
    | "id"
    | "externalId"
    | "kind"
    | "starRating"
    | "comment"
    | "sellerResponse"
    | "ebayOrderNumber"
    | "ebayItemId"
    | "buyerUserId"
    | "leftAt"
  >,
): HelpdeskFeedbackSnapshot {
  return {
    id: row.id,
    externalId: row.externalId,
    kind: row.kind,
    starRating: row.starRating,
    comment: row.comment,
    sellerResponse: row.sellerResponse,
    ebayOrderNumber: row.ebayOrderNumber,
    ebayItemId: row.ebayItemId,
    buyerUserId: row.buyerUserId,
    leftAt: row.leftAt.toISOString(),
    source: "mirror",
  };
}

function feedbackFilterXml(line: EbayOrderContextLineItem): string | null {
  if (line.orderLineItemId) {
    return `<OrderLineItemID>${escapeXml(line.orderLineItemId)}</OrderLineItemID>`;
  }
  if (line.itemId && line.transactionId) {
    return [
      `<ItemID>${escapeXml(line.itemId)}</ItemID>`,
      `<TransactionID>${escapeXml(line.transactionId)}</TransactionID>`,
    ].join("\n");
  }
  return null;
}

async function getFeedbackForLine(args: {
  integrationId: string;
  accessToken: string;
  line: EbayOrderContextLineItem;
  buyerUserId: string | null;
}): Promise<HelpdeskFeedbackSnapshot[]> {
  const filter = feedbackFilterXml(args.line);
  if (!filter) return [];

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetFeedbackRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${escapeXml(args.accessToken)}</eBayAuthToken>
  </RequesterCredentials>
  <FeedbackType>FeedbackReceived</FeedbackType>
  <DetailLevel>ReturnAll</DetailLevel>
  ${filter}
</GetFeedbackRequest>`;

  const res = await fetchWithTimeout(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": "GetFeedback",
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-IAF-TOKEN": args.accessToken,
      "Content-Type": "text/xml",
    },
    body: xml,
  });

  void recordNetworkTransferSample({
    channel: "HELPDESK",
    label: "helpdesk_ebay / GetFeedback_Targeted",
    bytesEstimate: Buffer.byteLength(xml) + Buffer.byteLength(res.body),
    integrationId: args.integrationId,
    metadata: { feature: "helpdesk", callName: "GetFeedback_Targeted" },
  });

  if (!res.ok) {
    throw new Error(`GetFeedback failed: HTTP ${res.status}`);
  }

  const parsed = parseXmlSimple(res.body);
  const root = parsed.GetFeedbackResponse as Record<string, unknown> | undefined;
  const detailArray = root?.FeedbackDetailArray as Record<string, unknown> | undefined;
  const raw = detailArray?.FeedbackDetail;
  const rows = asList(raw as Record<string, unknown> | Record<string, unknown>[]);

  return rows
    .map((row, idx) =>
      rowToSnapshot(
        row,
        `${args.line.orderLineItemId ?? args.line.itemId}:${args.line.transactionId ?? idx}`,
      ),
    )
    .filter((entry): entry is HelpdeskFeedbackSnapshot => {
      if (!entry) return false;
      if (isEbayAutomatedFeedbackSnapshot(entry)) return false;
      if (args.line.itemId && entry.ebayItemId && entry.ebayItemId !== args.line.itemId) {
        return false;
      }
      return sameBuyer(entry.buyerUserId, args.buyerUserId);
    });
}

export async function fetchEbayFeedbackForOrderContext(args: {
  integrationId: string;
  config: EbayConfig;
  order: EbayOrderContext;
}): Promise<HelpdeskFeedbackSnapshot[]> {
  if (args.order.lineItems.length === 0) return [];
  const accessToken = await getEbayAccessToken(args.integrationId, args.config);
  const batches = await Promise.all(
    args.order.lineItems.map((line) =>
      getFeedbackForLine({
        integrationId: args.integrationId,
        accessToken,
        line,
        buyerUserId: args.order.buyerUserId,
      }),
    ),
  );
  return uniqueSnapshots(batches.flat());
}
