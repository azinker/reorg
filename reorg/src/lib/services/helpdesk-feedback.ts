import { HelpdeskFeedbackKind, type HelpdeskFeedback } from "@prisma/client";
import type {
  EbayConfig,
  EbayOrderContext,
  EbayOrderContextLineItem,
} from "@/lib/services/auto-responder-ebay";
import { db } from "@/lib/db";
import { SYSTEM_MESSAGE_TYPES } from "@/lib/helpdesk/from-ebay-detect";
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
  isAutomated: boolean;
  /**
   * eBay TransactionID / OrderLineItemID the feedback was left on. Feedback
   * on eBay is per order line (transaction), so these are the ONLY exact way
   * to tell two orders apart when the same buyer bought the same listing
   * twice. Null for legacy rows synced before this field existed.
   */
  transactionId?: string | null;
  orderLineItemId?: string | null;
  /**
   * ISO timestamp of the "Feedback Removal Approved" eBay notification when
   * this feedback was later removed from eBay. Derived at read time from the
   * order's system tickets — never persisted, so it stays correct even for
   * historical data. Null when the feedback is still live on eBay.
   */
  removedAt?: string | null;
}

/** A "Feedback Removal Approved" notification found for an order. */
export interface FeedbackRemovalNotice {
  at: string;
  ebayItemId: string | null;
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

/**
 * Pull TransactionID / OrderLineItemID out of a raw GetFeedback row.
 * eBay uses TransactionID "0" for non-order feedback — treat it as null.
 */
function extractFeedbackTransaction(rawData: unknown): {
  transactionId: string | null;
  orderLineItemId: string | null;
} {
  const raw = (rawData ?? {}) as Record<string, unknown>;
  const tx = text(raw.TransactionID);
  const oli = text(raw.OrderLineItemID);
  return {
    transactionId: tx && tx !== "0" ? tx : null,
    orderLineItemId: oli && !oli.endsWith("-0") ? oli : null,
  };
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
  const kind = mapFeedbackKind(row.CommentType);
  const comment = text(row.CommentText);
  const { transactionId, orderLineItemId } = extractFeedbackTransaction(row);

  return {
    id: `live:${externalId}`,
    externalId,
    kind,
    starRating: null,
    comment,
    sellerResponse: text(row.FeedbackResponse),
    ebayOrderNumber: null,
    ebayItemId: text(row.ItemID),
    buyerUserId: text(row.CommentingUser),
    leftAt: leftAtDate.toISOString(),
    source: "live",
    isAutomated: isEbayAutomatedFeedbackSnapshot({
      kind,
      comment,
    }),
    transactionId,
    orderLineItemId,
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
  > &
    Partial<Pick<HelpdeskFeedback, "rawData">>,
): HelpdeskFeedbackSnapshot {
  const { transactionId, orderLineItemId } = extractFeedbackTransaction(
    row.rawData,
  );
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
    isAutomated: isEbayAutomatedFeedbackSnapshot(row),
    transactionId,
    orderLineItemId,
  };
}

/**
 * Scope feedback snapshots to ONE order.
 *
 * eBay feedback is left per order line (transaction). When the same buyer
 * buys the same listing on two different orders, item+buyer matching alone
 * pulls BOTH orders' feedback into one ticket. Given the order's line items
 * (with their TransactionID / OrderLineItemID), keep only the snapshots
 * that belong to this order:
 *
 * 1. Snapshot has a transaction id AND we know the order's transactions →
 *    keep only on an exact transaction match.
 * 2. Otherwise fall back to order-number equality when both sides know it.
 * 3. When neither side has anything to compare, keep the snapshot — hiding
 *    real feedback is worse than occasionally showing an ambiguous one.
 */
export function filterFeedbackSnapshotsToOrder(
  snapshots: HelpdeskFeedbackSnapshot[],
  order: {
    ebayOrderNumber: string | null;
    lineItems?:
      | Pick<EbayOrderContextLineItem, "transactionId" | "orderLineItemId">[]
      | null;
  },
): HelpdeskFeedbackSnapshot[] {
  const txKeys = new Set<string>();
  for (const line of order.lineItems ?? []) {
    if (line.transactionId) txKeys.add(String(line.transactionId));
    if (line.orderLineItemId) txKeys.add(String(line.orderLineItemId));
  }
  return snapshots.filter((snapshot) => {
    const tx = snapshot.transactionId ?? null;
    const oli = snapshot.orderLineItemId ?? null;
    if (txKeys.size > 0 && (tx || oli)) {
      return (tx != null && txKeys.has(tx)) || (oli != null && txKeys.has(oli));
    }
    if (order.ebayOrderNumber && snapshot.ebayOrderNumber) {
      return snapshot.ebayOrderNumber === order.ebayOrderNumber;
    }
    return true;
  });
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

// ─── Feedback removal history ────────────────────────────────────────────────

/**
 * Find "Feedback Removal Approved" eBay notifications for an order.
 *
 * Removal notifications arrive as SYSTEM tickets (threadKey
 * `sys:ord:<order>|type:FEEDBACK_REMOVAL_APPROVED`). Read-only: we look at
 * the stored notification message, never call eBay. The email body includes
 * "Item ID: ..." which lets us scope a removal to a specific line item when
 * an order has several.
 */
export async function findFeedbackRemovalNotices(args: {
  integrationId: string;
  ebayOrderNumber: string;
}): Promise<FeedbackRemovalNotice[]> {
  const tickets = await db.helpdeskTicket.findMany({
    where: {
      integrationId: args.integrationId,
      ebayOrderNumber: args.ebayOrderNumber,
      systemMessageType: SYSTEM_MESSAGE_TYPES.FEEDBACK_REMOVAL_APPROVED,
    },
    select: {
      createdAt: true,
      messages: {
        where: { deletedAt: null },
        orderBy: { sentAt: "asc" },
        take: 5,
        select: { sentAt: true, bodyText: true },
      },
    },
    take: 10,
  });

  const notices: FeedbackRemovalNotice[] = [];
  for (const ticket of tickets) {
    if (ticket.messages.length === 0) {
      notices.push({ at: ticket.createdAt.toISOString(), ebayItemId: null });
      continue;
    }
    for (const message of ticket.messages) {
      const itemId =
        /Item\s+ID\s*:?\s*(\d{9,15})/i.exec(message.bodyText ?? "")?.[1] ?? null;
      notices.push({
        at: (message.sentAt ?? ticket.createdAt).toISOString(),
        ebayItemId: itemId,
      });
    }
  }
  return notices.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

/**
 * Annotate feedback snapshots with `removedAt` using the order's removal
 * notices. A removal applies to buyer-authored (non-automated) feedback left
 * BEFORE the notice arrived; when the notice names an item id we only mark
 * feedback on that item. Each notice marks at most one snapshot (the most
 * recent eligible one) so a re-left feedback after a removal stays live.
 */
export function applyFeedbackRemovals(
  snapshots: HelpdeskFeedbackSnapshot[],
  notices: FeedbackRemovalNotice[],
): HelpdeskFeedbackSnapshot[] {
  if (notices.length === 0) {
    return snapshots.map((s) => ({ ...s, removedAt: s.removedAt ?? null }));
  }
  const out = snapshots.map((s) => ({ ...s, removedAt: s.removedAt ?? null }));
  for (const notice of notices) {
    const noticeMs = new Date(notice.at).getTime();
    const eligible = out
      .filter(
        (s) =>
          !s.removedAt &&
          !s.isAutomated &&
          new Date(s.leftAt).getTime() <= noticeMs &&
          (!notice.ebayItemId ||
            !s.ebayItemId ||
            s.ebayItemId === notice.ebayItemId),
      )
      .sort(
        (a, b) => new Date(b.leftAt).getTime() - new Date(a.leftAt).getTime(),
      );
    const target = eligible[0];
    if (target) target.removedAt = notice.at;
  }
  return out;
}

/**
 * When a buyer authors their own feedback, eBay REPLACES the automated
 * feedback that our auto-feedback rule had left — the automated entry no
 * longer exists on eBay. Mirror rows (and stale live reads) can still carry
 * both, which makes the UI show "Automated + Buyer" side by side. This
 * helper drops any automated snapshot that was superseded by a buyer-authored
 * snapshot for the same order line.
 *
 * Replacement happens PER TRANSACTION on eBay: an order with four line items
 * (e.g. four variations of one listing) can legitimately carry buyer feedback
 * on two lines AND automated feedback on the other two at the same time. So
 * when both snapshots have a transaction id we require an exact match; the
 * item-id comparison only applies to legacy rows without transaction info.
 *
 * Time-aware on purpose: a buyer feedback that was left BEFORE an automated
 * one (e.g. buyer negative → removed → automated positive posted later) does
 * NOT suppress the later automated entry — that automated feedback is real.
 */
export function suppressReplacedAutomatedFeedback(
  snapshots: HelpdeskFeedbackSnapshot[],
): HelpdeskFeedbackSnapshot[] {
  const buyerAuthored = snapshots.filter((s) => !s.isAutomated);
  if (buyerAuthored.length === 0) return snapshots;
  return snapshots.filter((s) => {
    if (!s.isAutomated) return true;
    const automatedMs = new Date(s.leftAt).getTime();
    return !buyerAuthored.some((b) => {
      const sameLine =
        b.transactionId && s.transactionId
          ? b.transactionId === s.transactionId
          : !b.ebayItemId || !s.ebayItemId || b.ebayItemId === s.ebayItemId;
      return sameLine && new Date(b.leftAt).getTime() >= automatedMs;
    });
  });
}
