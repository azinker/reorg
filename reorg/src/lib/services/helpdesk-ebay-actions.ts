/**
 * Help Desk eBay Actions client + sync workers.
 *
 * This file mirrors three buyer-initiated eBay events into reorG so the
 * agent timeline can render a complete out-of-band escalation history:
 *
 *   1. Returns / INAD cases  → HelpdeskCase rows
 *      Source: post-order Returns API (return search by date window)
 *
 *   2. Cancellation requests → HelpdeskCancellation rows
 *      Source: post-order Cancellation API (cancellation search)
 *
 *   3. Buyer feedback        → HelpdeskFeedback rows
 *      Source: Trading API GetFeedback (we already have Trading credentials
 *      and the sell.feedback REST API is gated behind a separate scope we
 *      haven't requested; using GetFeedback keeps the OAuth surface small)
 *
 * The workers are READ-ONLY. None of these endpoints initiate any writes
 * to eBay — that respects the global write lock semantics (sync = pull
 * only). Each upsert is idempotent on (integrationId, externalId) so
 * re-running the worker never duplicates a case/feedback/cancellation.
 *
 * Cost shape: each call returns a paginated JSON page (~5–30KB). Cursor
 * is persisted on HelpdeskSyncCheckpoint with folder keys "returns",
 * "cancellations", "feedback" so the rest of the helpdesk-poll plumbing
 * (budget tracking, lastWatermark) keeps working unchanged.
 */

import { Buffer } from "node:buffer";
import { db } from "@/lib/db";
import {
  Platform,
  HelpdeskCaseKind,
  HelpdeskCaseStatus,
  HelpdeskCancellationStatus,
  HelpdeskFeedbackKind,
  type Integration,
  type Prisma,
} from "@prisma/client";
import {
  buildEbayConfig,
  getEbayAccessToken,
} from "@/lib/services/helpdesk-ebay";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";

const REST_BASE = "https://api.ebay.com";
const TRADING_API = "https://api.ebay.com/ws/api.dll";
const COMPAT_LEVEL = "1199";
const SITE_ID = "0";
const REQUEST_TIMEOUT_MS = 30_000;

// How far back to look the *first* time we run each worker against a fresh
// integration. After that the watermark on HelpdeskSyncCheckpoint moves
// forward and we only fetch deltas.
//
// Aligned with helpdesk-ebay-sync.BACKFILL_DAYS so the message timeline and
// the eBay-action timeline cover the same horizon. Tunable via env var.
const INITIAL_LOOKBACK_DAYS = Number.parseInt(
  process.env.HELPDESK_BACKFILL_DAYS ?? "60",
  10,
);

// Per-tick page caps so a single sync tick can't blow the eBay rate budget.
const MAX_PAGES_PER_TICK = 4;
const PAGE_SIZE = 50;

// ─── Shared HTTP helpers ─────────────────────────────────────────────────────

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

function recordCall(args: {
  integrationId: string;
  callName: string;
  bytes: number;
}): void {
  void recordNetworkTransferSample({
    channel: "MARKETPLACE_INBOUND",
    label: `helpdesk_ebay / ${args.callName}`,
    bytesEstimate: args.bytes,
    integrationId: args.integrationId,
    metadata: { feature: "helpdesk_actions", callName: args.callName },
  });
}

// ─── REST client: post-order Returns ─────────────────────────────────────────

/**
 * eBay post-order Returns API. We use the *seller* search endpoint which
 * returns every return / INAD case opened against the seller in a date
 * window, regardless of which buyer triggered it.
 *
 * https://developer.ebay.com/Devzone/post-order/post-order_v2_return_search.html
 */
interface EbayReturnEntry {
  returnId?: string;
  state?: string; // OPEN, CLOSED, etc.
  reason?: string;
  creationInfo?: { creationDate?: { value?: string } };
  closedDate?: { value?: string };
  buyerLoginName?: string;
  itemInfo?: { itemId?: string };
  // The order this return is attached to.
  orderId?: string;
}

interface ListReturnsArgs {
  integrationId: string;
  fromDate: Date;
  toDate?: Date;
  offset?: number;
}

async function listReturns(
  args: ListReturnsArgs,
  config: Awaited<ReturnType<typeof buildEbayConfig>>,
): Promise<{ entries: EbayReturnEntry[]; totalPages: number }> {
  const accessToken = await getEbayAccessToken(args.integrationId, config);
  const params = new URLSearchParams({
    item_creation_date_range_from: args.fromDate.toISOString(),
    item_creation_date_range_to: (args.toDate ?? new Date()).toISOString(),
    limit: String(PAGE_SIZE),
    offset: String(args.offset ?? 0),
  });
  const url = `${REST_BASE}/post-order/v2/return/search?${params.toString()}`;

  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      // post-order v2 endpoints require the IAF (Identity Auth Framework)
      // scheme, NOT the Bearer scheme used by the Sell/Buy/Commerce REST APIs.
      // Sending "Bearer" returns "401 Bad scheme: Bearer".
      Authorization: `IAF ${accessToken}`,
      "Content-Type": "application/json",
      "Accept-Language": "en-US",
    },
  });
  recordCall({
    integrationId: args.integrationId,
    callName: "post-order/return/search",
    bytes: res.body.length,
  });

  if (!res.ok) {
    // 204/404 mean "nothing in this window" — treat as empty page.
    if (res.status === 204 || res.status === 404) {
      return { entries: [], totalPages: 0 };
    }
    throw new Error(`Returns search failed: ${res.status} ${res.body.slice(0, 200)}`);
  }

  let parsed: { members?: EbayReturnEntry[]; total?: number } = {};
  try {
    parsed = JSON.parse(res.body) as typeof parsed;
  } catch {
    return { entries: [], totalPages: 0 };
  }
  const entries = parsed.members ?? [];
  const total = parsed.total ?? entries.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  return { entries, totalPages };
}

// ─── REST client: post-order Cancellations ───────────────────────────────────

interface EbayCancellationEntry {
  cancelId?: string;
  cancelState?: string; // REQUESTED, APPROVED, DENIED, COMPLETED
  cancelStatus?: string; // alias on some responses
  cancelReason?: string;
  cancelRequestDate?: { value?: string };
  cancelCloseDate?: { value?: string };
  buyerLoginName?: string;
  legacyOrderId?: string;
  refundInfo?: {
    totalAmount?: { value?: string; currency?: string };
  };
}

async function listCancellations(
  args: ListReturnsArgs,
  config: Awaited<ReturnType<typeof buildEbayConfig>>,
): Promise<{ entries: EbayCancellationEntry[]; totalPages: number }> {
  const accessToken = await getEbayAccessToken(args.integrationId, config);
  const params = new URLSearchParams({
    creation_date_range_from: args.fromDate.toISOString(),
    creation_date_range_to: (args.toDate ?? new Date()).toISOString(),
    limit: String(PAGE_SIZE),
    offset: String(args.offset ?? 0),
    role: "SELLER",
  });
  const url = `${REST_BASE}/post-order/v2/cancellation/search?${params.toString()}`;

  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      // post-order v2 requires the IAF scheme; "Bearer" → 401 Bad scheme.
      Authorization: `IAF ${accessToken}`,
      "Content-Type": "application/json",
      "Accept-Language": "en-US",
    },
  });
  recordCall({
    integrationId: args.integrationId,
    callName: "post-order/cancellation/search",
    bytes: res.body.length,
  });

  if (!res.ok) {
    if (res.status === 204 || res.status === 404) {
      return { entries: [], totalPages: 0 };
    }
    throw new Error(`Cancellation search failed: ${res.status} ${res.body.slice(0, 200)}`);
  }

  let parsed: { cancellations?: EbayCancellationEntry[]; total?: number } = {};
  try {
    parsed = JSON.parse(res.body) as typeof parsed;
  } catch {
    return { entries: [], totalPages: 0 };
  }
  const entries = parsed.cancellations ?? [];
  const total = parsed.total ?? entries.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  return { entries, totalPages };
}

// ─── Trading API: GetFeedback ────────────────────────────────────────────────
//
// We use Trading API GetFeedback because the sell.feedback REST scope is
// separate from the messaging scope we already have, and adding scopes
// requires re-authenticating every store. GetFeedback returns the same data
// we need (feedback id, comment, rating, item id, buyer) under our existing
// OAuth grant.

interface EbayFeedbackEntry {
  externalId: string;
  kind: HelpdeskFeedbackKind;
  starRating: number | null;
  comment: string | null;
  sellerResponse: string | null;
  ebayOrderNumber: string | null;
  ebayItemId: string | null;
  buyerUserId: string | null;
  leftAt: Date;
  raw: unknown;
}

async function listFeedback(args: {
  integrationId: string;
  config: Awaited<ReturnType<typeof buildEbayConfig>>;
  pageNumber: number;
}): Promise<{ entries: EbayFeedbackEntry[]; hasMore: boolean }> {
  const accessToken = await getEbayAccessToken(args.integrationId, args.config);
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetFeedbackRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${accessToken}</eBayAuthToken>
  </RequesterCredentials>
  <FeedbackType>FeedbackReceived</FeedbackType>
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination>
    <EntriesPerPage>${PAGE_SIZE}</EntriesPerPage>
    <PageNumber>${args.pageNumber}</PageNumber>
  </Pagination>
</GetFeedbackRequest>`;

  const res = await fetchWithTimeout(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": "GetFeedback",
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-IAF-TOKEN": accessToken,
      "Content-Type": "text/xml",
    },
    body: xml,
  });
  recordCall({
    integrationId: args.integrationId,
    callName: "GetFeedback",
    bytes: res.body.length,
  });

  if (!res.ok) {
    throw new Error(`GetFeedback failed: ${res.status} ${res.body.slice(0, 200)}`);
  }

  // Parse the XML response. We use the same fast-xml-parser dependency the
  // existing helpdesk-ebay.ts relies on so we don't add a new package.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { XMLParser } = require("fast-xml-parser");
  const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
  const parsed = parser.parse(res.body) as Record<string, unknown>;
  const root = parsed.GetFeedbackResponse as Record<string, unknown> | undefined;
  if (!root) return { entries: [], hasMore: false };
  const detailArray = root.FeedbackDetailArray as Record<string, unknown> | undefined;
  const raw = detailArray?.FeedbackDetail;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];

  const pageInfo = root.PaginationResult as
    | { TotalNumberOfPages?: number | string }
    | undefined;
  const totalPages = pageInfo
    ? typeof pageInfo.TotalNumberOfPages === "string"
      ? parseInt(pageInfo.TotalNumberOfPages, 10)
      : pageInfo.TotalNumberOfPages ?? 1
    : 1;

  const entries: EbayFeedbackEntry[] = list.map((row: unknown) => {
    const r = (row ?? {}) as Record<string, unknown>;
    const ratingStr = r.CommentType as string | undefined; // Positive / Negative / Neutral
    const kind: HelpdeskFeedbackKind =
      ratingStr === "Negative"
        ? HelpdeskFeedbackKind.NEGATIVE
        : ratingStr === "Neutral"
          ? HelpdeskFeedbackKind.NEUTRAL
          : HelpdeskFeedbackKind.POSITIVE;
    return {
      externalId: String(r.FeedbackID ?? r.TransactionID ?? r.ItemID ?? ""),
      kind,
      starRating: null, // GetFeedback doesn't expose DSR star ratings here
      comment: typeof r.CommentText === "string" ? r.CommentText : null,
      sellerResponse:
        typeof r.CommentReplaced === "string" && r.CommentReplaced
          ? r.CommentReplaced
          : null,
      ebayOrderNumber: typeof r.OrderLineItemID === "string" ? null : null,
      ebayItemId: typeof r.ItemID === "string" ? r.ItemID : null,
      buyerUserId: typeof r.CommentingUser === "string" ? r.CommentingUser : null,
      leftAt: r.CommentTime ? new Date(String(r.CommentTime)) : new Date(),
      raw: r,
    };
  });
  return { entries, hasMore: args.pageNumber < totalPages };
}

// ─── Ticket linkage helper ───────────────────────────────────────────────────

/**
 * Best-effort lookup: given an order number and/or buyer login, find the
 * HelpdeskTicket the case/cancel/feedback should attach to. This is a
 * READ-ONLY join — if no ticket exists, the row is still inserted with a
 * null ticketId so it can be attached later when a ticket *does* appear.
 */
async function findTicketIdForLinkage(args: {
  integrationId: string;
  ebayOrderNumber: string | null;
  buyerUserId: string | null;
}): Promise<string | null> {
  const where: Prisma.HelpdeskTicketWhereInput[] = [];
  if (args.ebayOrderNumber) {
    where.push({ ebayOrderNumber: args.ebayOrderNumber });
  }
  if (args.buyerUserId) {
    where.push({ buyerUserId: args.buyerUserId });
  }
  if (where.length === 0) return null;
  const ticket = await db.helpdeskTicket.findFirst({
    where: {
      integrationId: args.integrationId,
      OR: where,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return ticket?.id ?? null;
}

// ─── Upsert workers ──────────────────────────────────────────────────────────

interface ActionsSummary {
  integrationId: string;
  returns: number;
  cancellations: number;
  feedback: number;
  errors: string[];
}

function mapReturnState(state: string | undefined): HelpdeskCaseStatus {
  switch ((state ?? "").toUpperCase()) {
    case "OPEN":
    case "ESCALATED":
    case "PENDING":
      return HelpdeskCaseStatus.OPEN;
    case "CLOSED":
    case "RESOLVED":
      return HelpdeskCaseStatus.CLOSED;
    default:
      return HelpdeskCaseStatus.OPEN;
  }
}

function mapReturnKind(reason: string | undefined): HelpdeskCaseKind {
  // eBay return reason codes are wide and inconsistent; we collapse them
  // into the four buckets exposed by HelpdeskCaseKind so the timeline pill
  // language stays predictable for agents.
  const r = (reason ?? "").toUpperCase();
  if (r.includes("NOT_AS_DESCRIBED") || r.includes("DEFECTIVE")) {
    return HelpdeskCaseKind.NOT_AS_DESCRIBED;
  }
  if (r.includes("ITEM_NOT_RECEIVED") || r.includes("NOT_RECEIVED")) {
    return HelpdeskCaseKind.ITEM_NOT_RECEIVED;
  }
  return HelpdeskCaseKind.RETURN;
}

function mapCancelStatus(state: string | undefined): HelpdeskCancellationStatus {
  // eBay's cancellation state vocabulary doesn't line up perfectly with
  // ours — we collapse synonyms (e.g. APPROVED+COMPLETED) into the closest
  // HelpdeskCancellationStatus and fall back to UNKNOWN when eBay sends
  // something we haven't seen before so we don't silently mis-tag it.
  switch ((state ?? "").toUpperCase()) {
    case "REQUESTED":
    case "PENDING":
      return HelpdeskCancellationStatus.REQUESTED;
    case "APPROVED":
      return HelpdeskCancellationStatus.APPROVED;
    case "COMPLETED":
    case "REFUNDED":
      return HelpdeskCancellationStatus.COMPLETED;
    case "DENIED":
    case "REJECTED":
      return HelpdeskCancellationStatus.REJECTED;
    case "CANCELLED":
    case "CANCELLED_BY_BUYER":
    case "WITHDRAWN":
      return HelpdeskCancellationStatus.CANCELLED_BY_BUYER;
    case "CLOSED":
      return HelpdeskCancellationStatus.UNKNOWN;
    default:
      return HelpdeskCancellationStatus.UNKNOWN;
  }
}

async function syncReturnsForIntegration(
  integration: Integration,
  config: Awaited<ReturnType<typeof buildEbayConfig>>,
): Promise<number> {
  const checkpoint = await db.helpdeskSyncCheckpoint.upsert({
    where: { integrationId_folder: { integrationId: integration.id, folder: "returns" } },
    create: { integrationId: integration.id, folder: "returns" },
    update: {},
  });
  const fromDate =
    checkpoint.lastWatermark ??
    new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86_400_000);

  let inserted = 0;
  let offset = 0;
  for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
    const { entries, totalPages } = await listReturns(
      { integrationId: integration.id, fromDate, offset },
      config,
    );
    for (const entry of entries) {
      if (!entry.returnId) continue;
      const openedAt = entry.creationInfo?.creationDate?.value
        ? new Date(entry.creationInfo.creationDate.value)
        : new Date();
      const closedAt = entry.closedDate?.value
        ? new Date(entry.closedDate.value)
        : null;
      const ticketId = await findTicketIdForLinkage({
        integrationId: integration.id,
        ebayOrderNumber: entry.orderId ?? null,
        buyerUserId: entry.buyerLoginName ?? null,
      });
      await db.helpdeskCase.upsert({
        where: {
          integrationId_externalId: {
            integrationId: integration.id,
            externalId: entry.returnId,
          },
        },
        create: {
          integrationId: integration.id,
          ticketId,
          externalId: entry.returnId,
          kind: mapReturnKind(entry.reason),
          status: mapReturnState(entry.state),
          ebayOrderNumber: entry.orderId ?? null,
          buyerUserId: entry.buyerLoginName ?? null,
          reason: entry.reason ?? null,
          openedAt,
          closedAt,
          rawData: entry as unknown as Prisma.InputJsonValue,
        },
        update: {
          ticketId: ticketId ?? undefined,
          status: mapReturnState(entry.state),
          closedAt,
          rawData: entry as unknown as Prisma.InputJsonValue,
        },
      });
      inserted++;
    }
    if (entries.length < PAGE_SIZE || page + 1 >= totalPages) break;
    offset += PAGE_SIZE;
  }

  await db.helpdeskSyncCheckpoint.update({
    where: { id: checkpoint.id },
    data: { lastWatermark: new Date(), lastFullSyncAt: new Date() },
  });
  return inserted;
}

async function syncCancellationsForIntegration(
  integration: Integration,
  config: Awaited<ReturnType<typeof buildEbayConfig>>,
): Promise<number> {
  const checkpoint = await db.helpdeskSyncCheckpoint.upsert({
    where: {
      integrationId_folder: { integrationId: integration.id, folder: "cancellations" },
    },
    create: { integrationId: integration.id, folder: "cancellations" },
    update: {},
  });
  const fromDate =
    checkpoint.lastWatermark ??
    new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86_400_000);

  let inserted = 0;
  let offset = 0;
  for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
    const { entries, totalPages } = await listCancellations(
      { integrationId: integration.id, fromDate, offset },
      config,
    );
    for (const entry of entries) {
      if (!entry.cancelId) continue;
      const requestedAt = entry.cancelRequestDate?.value
        ? new Date(entry.cancelRequestDate.value)
        : new Date();
      const resolvedAt = entry.cancelCloseDate?.value
        ? new Date(entry.cancelCloseDate.value)
        : null;
      const ticketId = await findTicketIdForLinkage({
        integrationId: integration.id,
        ebayOrderNumber: entry.legacyOrderId ?? null,
        buyerUserId: entry.buyerLoginName ?? null,
      });
      const refundAmtRaw = entry.refundInfo?.totalAmount?.value;
      const refundAmount = refundAmtRaw ? Number(refundAmtRaw) : null;

      await db.helpdeskCancellation.upsert({
        where: {
          integrationId_externalId: {
            integrationId: integration.id,
            externalId: entry.cancelId,
          },
        },
        create: {
          integrationId: integration.id,
          ticketId,
          externalId: entry.cancelId,
          status: mapCancelStatus(entry.cancelState ?? entry.cancelStatus),
          reason: entry.cancelReason ?? null,
          refundAmount,
          refundCurrency: entry.refundInfo?.totalAmount?.currency ?? null,
          ebayOrderNumber: entry.legacyOrderId ?? null,
          buyerUserId: entry.buyerLoginName ?? null,
          requestedAt,
          resolvedAt,
          rawData: entry as unknown as Prisma.InputJsonValue,
        },
        update: {
          ticketId: ticketId ?? undefined,
          status: mapCancelStatus(entry.cancelState ?? entry.cancelStatus),
          refundAmount,
          refundCurrency: entry.refundInfo?.totalAmount?.currency ?? null,
          resolvedAt,
          rawData: entry as unknown as Prisma.InputJsonValue,
        },
      });
      inserted++;
    }
    if (entries.length < PAGE_SIZE || page + 1 >= totalPages) break;
    offset += PAGE_SIZE;
  }

  await db.helpdeskSyncCheckpoint.update({
    where: { id: checkpoint.id },
    data: { lastWatermark: new Date(), lastFullSyncAt: new Date() },
  });
  return inserted;
}

async function syncFeedbackForIntegration(
  integration: Integration,
  config: Awaited<ReturnType<typeof buildEbayConfig>>,
): Promise<number> {
  const checkpoint = await db.helpdeskSyncCheckpoint.upsert({
    where: {
      integrationId_folder: { integrationId: integration.id, folder: "feedback" },
    },
    create: { integrationId: integration.id, folder: "feedback" },
    update: {},
  });
  // GetFeedback has no creation_date filter — pagination + dedupe via the
  // unique externalId constraint is what prevents reinserts. We still cap
  // at MAX_PAGES_PER_TICK so we don't drain the budget on a brand-new
  // integration with thousands of legacy feedback rows.

  let inserted = 0;
  for (let page = 1; page <= MAX_PAGES_PER_TICK; page++) {
    const { entries, hasMore } = await listFeedback({
      integrationId: integration.id,
      config,
      pageNumber: page,
    });
    if (entries.length === 0) break;
    for (const entry of entries) {
      if (!entry.externalId) continue;
      const ticketId = await findTicketIdForLinkage({
        integrationId: integration.id,
        ebayOrderNumber: entry.ebayOrderNumber,
        buyerUserId: entry.buyerUserId,
      });
      await db.helpdeskFeedback.upsert({
        where: {
          integrationId_externalId: {
            integrationId: integration.id,
            externalId: entry.externalId,
          },
        },
        create: {
          integrationId: integration.id,
          ticketId,
          externalId: entry.externalId,
          kind: entry.kind,
          starRating: entry.starRating,
          comment: entry.comment,
          sellerResponse: entry.sellerResponse,
          ebayOrderNumber: entry.ebayOrderNumber,
          ebayItemId: entry.ebayItemId,
          buyerUserId: entry.buyerUserId,
          leftAt: entry.leftAt,
          rawData: entry.raw as Prisma.InputJsonValue,
        },
        update: {
          ticketId: ticketId ?? undefined,
          sellerResponse: entry.sellerResponse,
          rawData: entry.raw as Prisma.InputJsonValue,
        },
      });
      inserted++;
    }
    if (!hasMore) break;
  }

  await db.helpdeskSyncCheckpoint.update({
    where: { id: checkpoint.id },
    data: { lastWatermark: new Date(), lastFullSyncAt: new Date() },
  });
  return inserted;
}

// ─── Public entrypoint ───────────────────────────────────────────────────────

/**
 * Run all three eBay action workers across every enabled eBay integration.
 * Designed to be called from the same cron tick as `runHelpdeskPoll`.
 *
 * Each worker is wrapped in try/catch so a failure in one (e.g. the buyer
 * cancellation API hiccupping) doesn't take down the others. Errors are
 * collected per-integration into `summary.errors` for the caller to log.
 */
export async function runHelpdeskActionsPoll(): Promise<{
  durationMs: number;
  summaries: ActionsSummary[];
}> {
  const startedAt = Date.now();
  const summaries: ActionsSummary[] = [];

  const integrations = await db.integration.findMany({
    where: {
      enabled: true,
      platform: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] },
    },
  });

  for (const integration of integrations) {
    const config = buildEbayConfig(integration);
    const summary: ActionsSummary = {
      integrationId: integration.id,
      returns: 0,
      cancellations: 0,
      feedback: 0,
      errors: [],
    };
    if (!config.appId || !config.refreshToken) {
      summary.errors.push("missing eBay credentials");
      summaries.push(summary);
      continue;
    }

    try {
      summary.returns = await syncReturnsForIntegration(integration, config);
    } catch (err) {
      summary.errors.push(`returns: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      summary.cancellations = await syncCancellationsForIntegration(integration, config);
    } catch (err) {
      summary.errors.push(`cancellations: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      summary.feedback = await syncFeedbackForIntegration(integration, config);
    } catch (err) {
      summary.errors.push(`feedback: ${err instanceof Error ? err.message : String(err)}`);
    }
    summaries.push(summary);
  }

  return { durationMs: Date.now() - startedAt, summaries };
}
