/**
 * Returns service layer.
 *
 * Owns all DB reads/writes for the returns feature plus the orchestration of
 * the eBay refresh + the preview/commit write flow. Routes stay thin and call
 * into here. Audit logging for every write attempt (committed / failed /
 * blocked) lives here so the userId + idempotency key are always recorded.
 *
 * Live eBay writes always follow this chain inside {@link commitReturnAction}:
 *   re-fetch Get Return  →  safety gate (admin/lock/env/toggle/availability)
 *   →  single write call  →  audit  →  targeted refresh.
 */

import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  Platform,
  Prisma,
  HelpdeskReturnActionStatus,
  type HelpdeskReturnCase,
} from "@prisma/client";
import { buildEbayConfig } from "@/lib/services/helpdesk-ebay";
import { getOrderContextCached } from "@/lib/services/helpdesk-order-context-cache";
import type { EbayOrderContext } from "@/lib/services/auto-responder-ebay";
import {
  getReturnDetail,
  getReturnTracking,
  getReturnFiles,
  decideReturn,
  issueRefund,
  markAsReceived,
  addForwardedShippingLabel,
  uploadReturnShippingLabel,
  uploadReturnFile,
  provideEbayReturnLabel,
  type EbayReturnsCallResult,
} from "@/lib/services/helpdesk-ebay-returns-client";
import {
  normalizeReturnSummary,
  matchesStatusFilter,
  getReturnLifecycle,
  isReturnClosed,
  validateDeduction,
  validateRefundAmount,
  parseAmount,
  isSupportedCarrier,
  extractReturnShipmentTracking,
  extractActionTypes,
  isActionExecutable,
  describeReturnStatus,
  parseEstimatedRefundLines,
  buildItemizedRefund,
  isDeductionAllowedForShippingService,
  type EbayReturnSummary,
  type EbayAvailableOption,
  type ReturnActionKey,
  type ReturnStatusFilterKey,
  type ReturnStatusDescriptor,
} from "@/lib/helpdesk/returns";
import { assertReturnWriteAllowed } from "@/lib/helpdesk/returns-safety";

const EBAY_PLATFORMS: Platform[] = [Platform.TPP_EBAY, Platform.TT_EBAY];

// ─── List ────────────────────────────────────────────────────────────────────

export interface ListReturnsFilters {
  platform?: Platform | null;
  /** "all" bypasses the status-bucket filter entirely (search any status). */
  status?: ReturnStatusFilterKey | "all" | null;
  search?: string | null;
  fromDate?: Date | null;
  toDate?: Date | null;
  sort?: "opened_desc" | "opened_asc" | "deadline_asc";
  page?: number;
  pageSize?: number;
}

export interface ReturnListItem {
  id: string;
  returnId: string;
  platform: Platform;
  ebayOrderNumber: string | null;
  ebayItemId: string | null;
  itemTitle: string | null;
  imageUrl: string | null;
  buyerUserId: string | null;
  returnState: string | null;
  lifecycle: ReturnType<typeof getReturnLifecycle>;
  isClosed: boolean;
  statusDescriptor: ReturnStatusDescriptor;
  sellerActionDue: boolean;
  reason: string | null;
  reasonType: string | null;
  sellerRefundValue: number | null;
  sellerRefundCurrency: string | null;
  refundIsActual: boolean;
  sellerResponseDueAt: string | null;
  openedAt: string;
  closedAt: string | null;
  lastSyncedAt: string;
  ticketId: string | null;
}

function toListItem(row: HelpdeskReturnCase): ReturnListItem {
  return {
    id: row.id,
    returnId: row.returnId,
    platform: row.platform,
    ebayOrderNumber: row.ebayOrderNumber,
    ebayItemId: row.ebayItemId,
    itemTitle: row.itemTitle,
    imageUrl: row.imageUrl,
    buyerUserId: row.buyerUserId,
    returnState: row.returnState,
    lifecycle: getReturnLifecycle(row.returnState),
    isClosed: isReturnClosed(row.returnState),
    statusDescriptor: describeReturnStatus({
      state: row.returnState,
      status: row.returnStatus,
      sellerActionDue: row.sellerActionDue,
    }),
    sellerActionDue: row.sellerActionDue,
    reason: row.reason,
    reasonType: row.reasonType,
    sellerRefundValue: row.sellerRefundValue,
    sellerRefundCurrency: row.sellerRefundCurrency,
    refundIsActual: row.refundIsActual,
    sellerResponseDueAt: row.sellerResponseDueAt?.toISOString() ?? null,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    lastSyncedAt: row.lastSyncedAt.toISOString(),
    ticketId: row.ticketId,
  };
}

/**
 * List returns from our local cache (hybrid freshness — list never round-trips
 * to eBay). Store/date/search filter at the DB; the status bucket is applied
 * in-memory because the bucket math (open vs replacement vs lifecycle) is a
 * pure helper, not a single column.
 */
export async function listReturnCases(filters: ListReturnsFilters): Promise<{
  items: ReturnListItem[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));

  const where: Prisma.HelpdeskReturnCaseWhereInput = {
    platform: filters.platform ?? { in: EBAY_PLATFORMS },
  };
  if (filters.fromDate || filters.toDate) {
    where.openedAt = {};
    if (filters.fromDate) where.openedAt.gte = filters.fromDate;
    if (filters.toDate) where.openedAt.lte = filters.toDate;
  }
  const q = filters.search?.trim();
  if (q) {
    where.OR = [
      { ebayOrderNumber: { contains: q, mode: Prisma.QueryMode.insensitive } },
      { buyerUserId: { contains: q, mode: Prisma.QueryMode.insensitive } },
      { ebayItemId: { contains: q, mode: Prisma.QueryMode.insensitive } },
      { itemTitle: { contains: q, mode: Prisma.QueryMode.insensitive } },
      { returnId: { contains: q, mode: Prisma.QueryMode.insensitive } },
    ];
  }

  // Cap the candidate set; returns volume is modest relative to messages.
  const candidates = await db.helpdeskReturnCase.findMany({
    where,
    orderBy: { openedAt: "desc" },
    take: 3000,
  });

  const statusKey = filters.status ?? "open_all";
  // "all" = search across every status bucket (used by the "search all
  // statuses" toggle); skip status filtering entirely and keep the
  // store/date/search-scoped candidates as-is.
  const filtered =
    statusKey === "all"
      ? candidates
      : candidates.filter((row) => {
          // Classify off the CURRENT return state, not the eBay bucket tags
          // recorded at the last bulk sync. The per-case detail refresh (run on
          // every open + after every write) updates `returnState` but NOT the
          // `ebayBuckets` tags, and eBay's CLOSED bucket sync is page-capped —
          // so a freshly-closed/delivered case keeps a stale ITEM_SHIPPED /
          // ITEM_DELIVERED tag and leaked into the wrong filter. State is the
          // single source of truth that also drives the status badge, so the
          // filter and the badge now always agree.
          const closedNow = isReturnClosed(row.returnState);
          // Closed is authoritative: a closed case belongs ONLY to "Closed
          // returns/replacements" and must leave every open/shipped/delivered/
          // in-progress bucket; a still-open case never shows under Closed.
          if (statusKey === "closed") return closedNow;
          if (closedNow) return false;
          return matchesStatusFilter(statusKey, {
            state: row.returnState,
            currentType: row.currentType,
            sellerActionDue: row.sellerActionDue,
          });
        });

  const sort = filters.sort ?? "opened_desc";
  filtered.sort((a, b) => {
    if (sort === "opened_asc") return a.openedAt.getTime() - b.openedAt.getTime();
    if (sort === "deadline_asc") {
      const ad = a.sellerResponseDueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bd = b.sellerResponseDueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return ad - bd;
    }
    return b.openedAt.getTime() - a.openedAt.getTime();
  });

  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize).map(toListItem);
  return { items, total, page, pageSize };
}

/** Needs-attention badge count (open returns with a seller action due). */
export async function countReturnsNeedingAttention(): Promise<number> {
  return db.helpdeskReturnCase.count({
    where: { platform: { in: EBAY_PLATFORMS }, sellerActionDue: true },
  });
}

/**
 * Break out the "needs attention" total by store so the header can explain
 * exactly what the number represents (open returns awaiting a seller action).
 */
export async function getReturnsAttentionSummary(): Promise<{
  total: number;
  byPlatform: Record<string, number>;
}> {
  const grouped = await db.helpdeskReturnCase.groupBy({
    by: ["platform"],
    where: { platform: { in: EBAY_PLATFORMS }, sellerActionDue: true },
    _count: { _all: true },
  });
  const byPlatform: Record<string, number> = {};
  let total = 0;
  for (const g of grouped) {
    const n = g._count._all;
    byPlatform[g.platform] = n;
    total += n;
  }
  return { total, byPlatform };
}

// ─── Detail + refresh ────────────────────────────────────────────────────────

async function resolveCaseByReturnId(returnId: string): Promise<HelpdeskReturnCase | null> {
  return db.helpdeskReturnCase.findFirst({ where: { returnId } });
}

function fingerprintTrackingEvent(e: {
  eventDate?: string | null;
  status?: string | null;
  location?: string | null;
  description?: string | null;
}): string {
  return [e.eventDate ?? "", e.status ?? "", e.location ?? "", e.description ?? ""].join("|");
}

/**
 * Resolve the SKU the buyer ACTUALLY purchased from the live eBay order.
 *
 * eBay's Post-Order return `itemDetail.sku` is unreliable for multi-variation
 * listings — it frequently reports the listing's default/first variation SKU
 * instead of the variant the buyer bought (e.g. a return for CB129_MAG_BACK_3XL
 * coming back as CB109_MAG_BACK_S). The order's transaction record is the
 * ground truth, so we match the return's transaction id (most precise), then a
 * unique item-id line, then a single-line order. Returns null if no confident
 * match — the caller decides the fallback. This is what guarantees the SkuVault
 * add-back restocks the correct SKU.
 */
function pickOrderLineSku(
  ctx: EbayOrderContext | null | undefined,
  args: { transactionId: string | null; itemId: string | null },
): string | null {
  const lines = ctx?.lineItems ?? [];
  if (lines.length === 0) return null;
  // 1. Exact transaction match — the only signal that disambiguates which
  //    variation of a multi-variation listing was bought.
  if (args.transactionId) {
    const byTx = lines.find(
      (l) => l.transactionId && l.transactionId === args.transactionId,
    );
    const sku = byTx?.sku?.trim();
    if (sku) return sku;
  }
  // 2. Item-id match, but ONLY when unambiguous (a single line for that item).
  if (args.itemId) {
    const byItem = lines.filter((l) => l.itemId === args.itemId);
    if (byItem.length === 1) {
      const sku = byItem[0].sku?.trim();
      if (sku) return sku;
    }
  }
  // 3. Single-line order — no ambiguity possible.
  if (lines.length === 1) {
    const sku = lines[0].sku?.trim();
    if (sku) return sku;
  }
  return null;
}

/**
 * Authoritative SKU for a return, resolved from the live eBay ORDER transaction
 * the buyer purchased. Returns null when there's no confident match (the caller
 * decides the fallback). Shared by the detail refresh, the bulk sync hydration,
 * and the retroactive backfill so all three agree on the same ground truth.
 * Read-only against eBay (GetOrders via the shared order-context cache).
 */
export async function resolveOrderLineSku(
  integrationId: string,
  config: ReturnType<typeof buildEbayConfig>,
  args: {
    orderNumber: string | null;
    transactionId: string | null;
    itemId: string | null;
  },
): Promise<string | null> {
  if (!args.orderNumber) return null;
  try {
    const ctx = await getOrderContextCached(integrationId, config, args.orderNumber, {
      awaitFresh: true,
    });
    return pickOrderLineSku(ctx ?? null, {
      transactionId: args.transactionId,
      itemId: args.itemId,
    });
  } catch (err) {
    console.warn(
      "[helpdesk-returns] order-context SKU resolve failed",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Re-fetch a single return's detail (+ tracking + files) directly from eBay and
 * persist it. This is the authoritative read used by the detail page and
 * ALWAYS run immediately before any write so the availability check is fresh.
 * Read-only against eBay.
 */
export async function refreshReturnDetail(returnId: string): Promise<{
  caseRow: HelpdeskReturnCase | null;
  detailResult: EbayReturnsCallResult | null;
  error: string | null;
}> {
  const existing = await resolveCaseByReturnId(returnId);
  if (!existing) return { caseRow: null, detailResult: null, error: "Return not found." };

  const integration = await db.integration.findUnique({
    where: { id: existing.integrationId },
  });
  if (!integration) {
    return { caseRow: existing, detailResult: null, error: "Integration not found." };
  }
  const config = buildEbayConfig(integration);

  // FULL returns BOTH the `summary` container (sellerAvailableOptions / state /
  // response-due) AND the `detail` container (returnShipmentInfo with the buyer's
  // return-shipment tracking, refundInfo, item detail, files). SUMMARY omits
  // returnShipmentInfo entirely, so we'd never learn the return tracking number.
  const detailResult = await getReturnDetail({
    integrationId: integration.id,
    config,
    returnId,
    fieldgroups: "FULL",
  });
  if (!detailResult.ok || !detailResult.body) {
    return { caseRow: existing, detailResult, error: detailResult.errorMessage };
  }

  const raw = detailResult.body as EbayReturnSummary;
  const fields = normalizeReturnSummary(raw);
  const shipTracking = extractReturnShipmentTracking(raw);

  // ── Accurate SKU resolution ────────────────────────────────────────────────
  // The SKU on the actual ORDER line item the buyer purchased is the ground
  // truth. eBay's return itemDetail.sku is unreliable for multi-variation
  // listings (it can report the listing's default variant, not the one bought),
  // so resolve from the order's transaction FIRST and OVERWRITE any prior value.
  // Only fall back to the return detail / catalog when the order can't be read.
  const orderNumber = fields.ebayOrderNumber ?? existing.ebayOrderNumber;
  const skuTransactionId = fields.transactionId ?? existing.transactionId;
  const skuItemId = fields.ebayItemId ?? existing.ebayItemId;

  // Fetch the live order ONCE — it's the ground truth for BOTH the SKU the buyer
  // bought AND the shipping service they used. The shipping service decides
  // refund-deduction eligibility (eBay's return API has no usable deduction
  // flag), so we persist it here. Cached, so the cost is shared.
  let orderCtx: EbayOrderContext | null = null;
  if (orderNumber) {
    try {
      orderCtx =
        (await getOrderContextCached(integration.id, config, orderNumber, {
          awaitFresh: true,
        })) ?? null;
    } catch (err) {
      console.warn(
        "[helpdesk-returns] order-context fetch failed",
        err instanceof Error ? err.message : err,
      );
    }
  }

  let resolvedSku = pickOrderLineSku(orderCtx, {
    transactionId: skuTransactionId,
    itemId: skuItemId,
  });
  const buyerShippingServiceCode =
    orderCtx?.shippingService ?? existing.buyerShippingServiceCode ?? null;
  // Fallbacks only when the authoritative order line SKU is unavailable.
  if (!resolvedSku) resolvedSku = fields.sku ?? existing.sku ?? null;
  if (!resolvedSku && skuItemId) {
    // Catalog fallback by item id — trust it ONLY when the listing maps to a
    // single SKU (non-variation). Multiple distinct SKUs means it's a variation
    // listing and the item id alone can't tell us which variant was bought.
    const listings = await db.marketplaceListing.findMany({
      where: { integrationId: integration.id, platformItemId: skuItemId },
      select: { sku: true },
    });
    const distinct = Array.from(
      new Set(
        listings
          .map((l) => l.sku?.trim())
          .filter((s): s is string => !!s),
      ),
    );
    if (distinct.length === 1) resolvedSku = distinct[0];
  }

  const updated = await db.helpdeskReturnCase.update({
    where: { id: existing.id },
    data: {
      returnTrackingNumber: shipTracking.trackingNumber ?? existing.returnTrackingNumber,
      returnCarrier: shipTracking.carrier ?? existing.returnCarrier,
      returnCarrierUsed: shipTracking.carrierUsed ?? existing.returnCarrierUsed,
      returnDeliveryStatus: shipTracking.deliveryStatus ?? existing.returnDeliveryStatus,
      ebayOrderNumber: fields.ebayOrderNumber ?? existing.ebayOrderNumber,
      ebayItemId: fields.ebayItemId ?? existing.ebayItemId,
      transactionId: fields.transactionId ?? existing.transactionId,
      returnQuantity: fields.returnQuantity ?? existing.returnQuantity,
      itemTitle: fields.itemTitle ?? existing.itemTitle,
      imageUrl: fields.imageUrl ?? existing.imageUrl,
      sku: resolvedSku,
      buyerShippingServiceCode,
      buyerUserId: fields.buyerUserId ?? existing.buyerUserId,
      sellerUserId: fields.sellerUserId ?? existing.sellerUserId,
      returnState: fields.returnState ?? existing.returnState,
      returnStatus: fields.returnStatus ?? existing.returnStatus,
      currentType: fields.currentType ?? existing.currentType,
      sellerActionDue: fields.sellerActionDue,
      escalated: fields.escalated,
      caseId: fields.caseId ?? existing.caseId,
      reason: fields.reason ?? existing.reason,
      reasonType: fields.reasonType ?? existing.reasonType,
      buyerComments: fields.buyerComments ?? existing.buyerComments,
      sellerRefundValue: fields.sellerRefundValue,
      sellerRefundCurrency: fields.sellerRefundCurrency,
      buyerRefundValue: fields.buyerRefundValue,
      buyerRefundCurrency: fields.buyerRefundCurrency,
      refundIsActual: fields.refundIsActual,
      sellerResponseDueAt: fields.sellerResponseDueAt,
      buyerResponseDueAt: fields.buyerResponseDueAt,
      timeoutDate: fields.timeoutDate,
      closedAt: fields.closedAt ?? existing.closedAt,
      sellerAvailableOptions: fields.sellerAvailableOptions as unknown as Prisma.InputJsonValue,
      buyerAvailableOptions: fields.buyerAvailableOptions as unknown as Prisma.InputJsonValue,
      rawDetail: raw as unknown as Prisma.InputJsonValue,
      detailFetchedAt: new Date(),
      lastSyncedAt: new Date(),
    },
  });

  // Tracking + files are best-effort enrichment; never block the detail render.
  try {
    if (shipTracking.carrierUsed && shipTracking.trackingNumber) {
      await syncTrackingEvents(existing.id, integration.id, config, returnId, {
        carrierUsed: shipTracking.carrierUsed,
        trackingNumber: shipTracking.trackingNumber,
      });
    }
  } catch {
    /* non-fatal */
  }
  try {
    await syncReturnFiles(existing.id, integration.id, config, returnId);
  } catch {
    /* non-fatal */
  }

  return { caseRow: updated, detailResult, error: null };
}

/** A single ScanDetailType node from GET /return/{id}/tracking scanHistory. */
interface RawScanDetail {
  eventCity?: string;
  eventCode?: string;
  eventDesc?: string;
  eventPostalCode?: string;
  eventStateOrProvince?: string;
  eventStatus?: string;
  eventTime?: { value?: string; formattedValue?: string };
}

async function syncTrackingEvents(
  returnCaseId: string,
  integrationId: string,
  config: ReturnType<typeof buildEbayConfig>,
  returnId: string,
  shipment: { carrierUsed: string; trackingNumber: string },
): Promise<void> {
  const res = await getReturnTracking({
    integrationId,
    config,
    returnId,
    carrierUsed: shipment.carrierUsed,
    trackingNumber: shipment.trackingNumber,
  });
  if (!res.ok || !res.body) return;
  const body = res.body as {
    carrierUsed?: string;
    trackingNumber?: string;
    trackingStatus?: string;
    scanHistory?: RawScanDetail[];
  };
  const carrier = body.carrierUsed ?? shipment.carrierUsed;
  const trackingNumber = body.trackingNumber ?? shipment.trackingNumber;
  const scans = Array.isArray(body.scanHistory) ? body.scanHistory : [];

  // Keep the case's headline delivery status fresh from the live scan feed.
  if (body.trackingStatus) {
    await db.helpdeskReturnCase.update({
      where: { id: returnCaseId },
      data: { returnDeliveryStatus: body.trackingStatus },
    });
  }

  for (const ev of scans) {
    const eventDate = ev.eventTime?.value ?? null;
    const location = [ev.eventCity, ev.eventStateOrProvince].filter(Boolean).join(", ") || null;
    const status = ev.eventStatus ?? null;
    const description = ev.eventDesc ?? null;
    const fingerprint = fingerprintTrackingEvent({ eventDate, status, location, description });
    await db.helpdeskReturnTrackingEvent.upsert({
      where: { returnCaseId_fingerprint: { returnCaseId, fingerprint } },
      create: {
        returnCaseId,
        carrier,
        trackingNumber,
        eventDate: eventDate ? new Date(eventDate) : null,
        status,
        location,
        description,
        fingerprint,
        rawData: ev as unknown as Prisma.InputJsonValue,
      },
      update: {},
    });
  }
}

interface RawReturnFile {
  fileId?: string;
  fileName?: string;
  filePurpose?: string;
  fileType?: string;
  fileFormat?: string;
  contentType?: string;
  fileSize?: number;
  url?: string;
  /** eBay's hosted URL for the file (Get Files). */
  secureUrl?: string;
  /** base64 binary (Get Files returns this for attached files). */
  fileData?: string;
  /** base64 thumbnail (smaller — preferred for inline preview). */
  resizedFileData?: string;
  /** BUYER | SELLER | EBAY | SYSTEM | OTHER. */
  submitter?: string;
}

/** Map an eBay fileFormat (e.g. "JPEG", "PNG", "PDF") to a MIME content type. */
function fileFormatToMime(fmt?: string | null): string | null {
  if (!fmt) return null;
  const f = fmt.trim().toUpperCase();
  if (f === "JPEG" || f === "JPG") return "image/jpeg";
  if (f === "PNG") return "image/png";
  if (f === "GIF") return "image/gif";
  if (f === "BMP") return "image/bmp";
  if (f === "PDF") return "application/pdf";
  return null;
}

async function syncReturnFiles(
  returnCaseId: string,
  integrationId: string,
  config: ReturnType<typeof buildEbayConfig>,
  returnId: string,
): Promise<void> {
  const res = await getReturnFiles({ integrationId, config, returnId });
  if (!res.ok || !res.body) return;
  const body = res.body as { files?: RawReturnFile[] };
  for (const f of body.files ?? []) {
    if (!f.fileId) continue;
    const contentType = f.contentType ?? fileFormatToMime(f.fileFormat ?? f.fileType) ?? null;
    // Prefer the inline base64 the Get Files response carries so buyer-uploaded
    // photos render WITHOUT a second authenticated fetch. eBay's secureUrl
    // requires the seller's auth token, so an <img src=secureUrl> renders broken
    // (403) in the browser — that was the broken-thumbnail bug. Use the resized
    // thumbnail when available to keep the row small; fall back to the hosted
    // URL only when no base64 is provided.
    // `url` = small thumbnail for the grid (resized when eBay provides it).
    // `fullUrl` = full-resolution image for the expand/lightbox view. Both are
    // inline base64 data URLs so they render WITHOUT a second authenticated
    // fetch — eBay's secureUrl requires the seller token and 403s in <img>.
    let url: string | null = null;
    let fullUrl: string | null = null;
    const thumbB64 = f.resizedFileData ?? f.fileData;
    const fullB64 = f.fileData ?? f.resizedFileData;
    if (thumbB64 && contentType) url = `data:${contentType};base64,${thumbB64}`;
    if (fullB64 && contentType) fullUrl = `data:${contentType};base64,${fullB64}`;
    if (!url) url = f.secureUrl ?? f.url ?? null;
    const existing = await db.helpdeskReturnFile.findFirst({
      where: { returnCaseId, ebayFileId: f.fileId },
    });
    if (existing) {
      // Backfill URL/submitter on previously-synced rows (e.g. before this fix).
      // Also REPLACE a previously-stored secureUrl (renders broken without auth)
      // with the inline base64 data URL when we now have one.
      const hasInlineNow = !!url && url.startsWith("data:");
      const existingIsRemote = !!existing.url && !existing.url.startsWith("data:");
      const needsUrl = (!existing.url && url) || (hasInlineNow && existingIsRemote);
      const existingRow = existing as typeof existing & { fullUrl?: string | null };
      const needsFullUrl = !!fullUrl && !existingRow.fullUrl;
      if (
        needsUrl ||
        needsFullUrl ||
        (!existing.submitter && f.submitter) ||
        (!existing.contentType && contentType)
      ) {
        await db.helpdeskReturnFile.update({
          where: { id: existing.id },
          data: {
            ...(needsUrl && url ? { url } : {}),
            ...(needsFullUrl && fullUrl ? { fullUrl } : {}),
            ...(existing.submitter ? {} : f.submitter ? { submitter: f.submitter } : {}),
            ...(existing.contentType ? {} : contentType ? { contentType } : {}),
          },
        });
      }
      continue;
    }
    await db.helpdeskReturnFile.create({
      data: {
        returnCaseId,
        ebayFileId: f.fileId,
        fileName: f.fileName ?? null,
        filePurpose: f.filePurpose ?? null,
        contentType,
        sizeBytes: typeof f.fileSize === "number" ? f.fileSize : null,
        url,
        fullUrl,
        submitter: f.submitter ?? null,
        source: "EBAY",
        rawData: f as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

export interface ReturnFileDownload {
  bytes: Buffer;
  contentType: string;
  fileName: string;
}

function dataUrlToBuffer(
  url: string,
): { bytes: Buffer; contentType: string } | null {
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(url);
  if (!m) return null;
  try {
    return { bytes: Buffer.from(m[2], "base64"), contentType: m[1] };
  } catch {
    return null;
  }
}

/**
 * Resolve a return file's actual bytes for download.
 *
 * The eBay-hosted file URL (return.nuobject.io) is a short-lived (~15 min)
 * pre-signed S3 link that also frequently won't resolve from a browser, so we
 * never hand it to the client. Instead we resolve the bytes server-side, in
 * priority order:
 *   1. Inline base64 already stored on the row (fullUrl/url data: URLs).
 *   2. A FRESH copy from eBay Get Files (prefer inline base64; else fetch the
 *      fresh secureUrl server-side — bypasses the browser DNS/expiry issue).
 *   3. The original bytes from the reorG UPLOAD_LABEL attempt payload.
 *   4. Last resort: fetch the stored (possibly stale) remote URL server-side.
 * Read-only against eBay.
 */
export async function getReturnFileDownload(
  returnId: string,
  fileRowId: string,
): Promise<ReturnFileDownload | null> {
  const caseRow = await resolveCaseByReturnId(returnId);
  if (!caseRow) return null;
  const file = await db.helpdeskReturnFile.findFirst({
    where: { id: fileRowId, returnCaseId: caseRow.id },
  });
  if (!file) return null;

  const baseName = file.fileName?.trim() || `return-${returnId}-label`;
  const extFor = (ct: string | null): string => {
    if (!ct) return "";
    if (ct === "application/pdf") return ".pdf";
    if (ct.startsWith("image/")) return "." + ct.split("/")[1];
    return "";
  };
  const nameWithExt = (ct: string | null): string =>
    /\.[a-z0-9]+$/i.test(baseName) ? baseName : baseName + extFor(ct);

  // 1) Inline base64 already on the row.
  for (const candidate of [file.fullUrl, file.url]) {
    if (candidate && candidate.startsWith("data:")) {
      const decoded = dataUrlToBuffer(candidate);
      if (decoded) {
        const ct = file.contentType ?? decoded.contentType;
        return { bytes: decoded.bytes, contentType: ct, fileName: nameWithExt(ct) };
      }
    }
  }

  // 2) Re-fetch a fresh copy from eBay.
  const integration = await db.integration.findUnique({
    where: { id: caseRow.integrationId },
  });
  if (integration && file.ebayFileId) {
    try {
      const config = buildEbayConfig(integration);
      const res = await getReturnFiles({ integrationId: integration.id, config, returnId });
      if (res.ok && res.body) {
        const files = (res.body as { files?: RawReturnFile[] }).files ?? [];
        const match = files.find((f) => f.fileId === file.ebayFileId);
        if (match) {
          const ct =
            match.contentType ??
            fileFormatToMime(match.fileFormat ?? match.fileType) ??
            file.contentType ??
            "application/octet-stream";
          if (match.fileData) {
            return {
              bytes: Buffer.from(match.fileData, "base64"),
              contentType: ct,
              fileName: nameWithExt(ct),
            };
          }
          const fresh = match.secureUrl ?? match.url;
          if (fresh) {
            const resp = await fetch(fresh);
            if (resp.ok) {
              const buf = Buffer.from(await resp.arrayBuffer());
              const respCt = resp.headers.get("content-type") ?? ct;
              return { bytes: buf, contentType: respCt, fileName: nameWithExt(respCt) };
            }
          }
        }
      }
    } catch {
      // fall through
    }
  }

  // 3) Original bytes from a reorG UPLOAD_LABEL attempt.
  const attempt = await db.helpdeskReturnActionAttempt.findFirst({
    where: {
      returnCaseId: caseRow.id,
      actionType: "UPLOAD_LABEL",
      status: HelpdeskReturnActionStatus.COMMITTED,
    },
    orderBy: { committedAt: "desc" },
  });
  const payload = (attempt?.requestPayload ?? null) as {
    labelFileData?: string;
    labelFileName?: string;
  } | null;
  if (payload?.labelFileData) {
    const ct = file.contentType ?? "application/pdf";
    return {
      bytes: Buffer.from(payload.labelFileData, "base64"),
      contentType: ct,
      fileName: payload.labelFileName?.trim() || nameWithExt(ct),
    };
  }

  // 4) Last resort: fetch the stored remote URL server-side.
  if (file.url && !file.url.startsWith("data:")) {
    try {
      const resp = await fetch(file.url);
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        const ct = resp.headers.get("content-type") ?? file.contentType ?? "application/octet-stream";
        return { bytes: buf, contentType: ct, fileName: nameWithExt(ct) };
      }
    } catch {
      // give up
    }
  }

  return null;
}

export async function getReturnCaseDetail(returnId: string): Promise<{
  caseRow:
    | (HelpdeskReturnCase & {
        trackingEvents: Awaited<ReturnType<typeof db.helpdeskReturnTrackingEvent.findMany>>;
        files: Awaited<ReturnType<typeof db.helpdeskReturnFile.findMany>>;
        actionAttempts: Awaited<ReturnType<typeof db.helpdeskReturnActionAttempt.findMany>>;
      })
    | null;
}> {
  const base = await resolveCaseByReturnId(returnId);
  if (!base) return { caseRow: null };
  const [trackingEvents, files, actionAttempts] = await Promise.all([
    db.helpdeskReturnTrackingEvent.findMany({
      where: { returnCaseId: base.id },
      orderBy: { eventDate: "desc" },
    }),
    db.helpdeskReturnFile.findMany({
      where: { returnCaseId: base.id },
      orderBy: { createdAt: "desc" },
    }),
    db.helpdeskReturnActionAttempt.findMany({
      where: { returnCaseId: base.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  return { caseRow: { ...base, trackingEvents, files, actionAttempts } };
}

// ─── Action preview + commit ─────────────────────────────────────────────────

export interface ActionParams {
  /** OFFER_PARTIAL_REFUND / ISSUE_REFUND: explicit amount. */
  amount?: number;
  /** ISSUE_REFUND with a free-return deduction. */
  deductionType?: "none" | "percent" | "amount";
  deductionValue?: number;
  deductionReason?: string;
  deductionComment?: string;
  /** CONFIRM_LABEL_SENT / UPLOAD_LABEL: forwarded label details. */
  carrierEnum?: string;
  trackingNumber?: string;
  comments?: string;
  /** UPLOAD_LABEL: base64 (no data: prefix) of a PDF/image label file. */
  labelFileData?: string;
  labelFileName?: string;
}

export interface PreviewResult {
  ok: boolean;
  idempotencyKey?: string;
  summary?: {
    action: ReturnActionKey;
    headline: string;
    lines: string[];
    requiresTypedConfirmation: boolean;
    finalRefundAmount?: number;
    currency?: string;
  };
  error?: string;
}

function refundCurrencyFor(caseRow: HelpdeskReturnCase): string {
  return caseRow.sellerRefundCurrency ?? caseRow.buyerRefundCurrency ?? "USD";
}

function maxRefundFor(caseRow: HelpdeskReturnCase): number {
  // Use the eBay-estimated seller refund as the ceiling; fall back to buyer.
  return (
    caseRow.sellerRefundValue ??
    caseRow.buyerRefundValue ??
    Number.POSITIVE_INFINITY
  );
}

/**
 * Validate an action and persist a PREVIEWED attempt with an idempotency key.
 * No eBay call happens here. The commit step must echo the key back so the
 * committed payload matches exactly what the user confirmed.
 */
export async function previewReturnAction(args: {
  returnId: string;
  userId: string;
  action: ReturnActionKey;
  params: ActionParams;
}): Promise<PreviewResult> {
  const caseRow = await resolveCaseByReturnId(args.returnId);
  if (!caseRow) return { ok: false, error: "Return not found." };

  const currency = refundCurrencyFor(caseRow);
  const lines: string[] = [];
  let headline = "";
  let requiresTypedConfirmation = false;
  let finalRefundAmount: number | undefined;
  const requestPayload: Record<string, unknown> = { action: args.action };

  switch (args.action) {
    case "APPROVE_RETURN": {
      headline = "Accept this return request";
      lines.push("eBay will notify the buyer the return is accepted.");
      lines.push("You'll then provide a return label for the buyer.");
      break;
    }
    case "DECLINE_RETURN": {
      headline = "Decline this return request";
      lines.push("Closes the return request; the buyer keeps the item.");
      lines.push("This is a final action that resolves the case against the buyer.");
      requiresTypedConfirmation = true;
      if (args.params.comments) requestPayload.comments = args.params.comments;
      break;
    }
    case "MARK_AS_RECEIVED": {
      headline = "Mark the returned item as received";
      lines.push("Confirms to eBay that you received the returned item.");
      break;
    }
    case "CONFIRM_LABEL_SENT": {
      if (args.params.carrierEnum && !isSupportedCarrier(args.params.carrierEnum)) {
        return { ok: false, error: "Unsupported carrier." };
      }
      headline = "Confirm you sent the buyer a return label";
      if (args.params.carrierEnum) lines.push(`Carrier: ${args.params.carrierEnum}`);
      if (args.params.trackingNumber) lines.push(`Tracking: ${args.params.trackingNumber}`);
      requestPayload.carrierEnum = args.params.carrierEnum;
      requestPayload.trackingNumber = args.params.trackingNumber;
      break;
    }
    case "UPLOAD_LABEL": {
      if (!args.params.carrierEnum || !isSupportedCarrier(args.params.carrierEnum)) {
        return { ok: false, error: "Choose a supported carrier." };
      }
      if (!args.params.trackingNumber || !args.params.trackingNumber.trim()) {
        return { ok: false, error: "Enter the tracking number on your label." };
      }
      if (!args.params.labelFileData || !args.params.labelFileName) {
        return { ok: false, error: "Attach the PDF or image label file to upload." };
      }
      headline = "Upload your return shipping label";
      lines.push(`File: ${args.params.labelFileName}`);
      lines.push(`Carrier: ${args.params.carrierEnum}`);
      lines.push(`Tracking: ${args.params.trackingNumber.trim()}`);
      lines.push("eBay attaches this label file + tracking and shares it with the buyer.");
      requestPayload.carrierEnum = args.params.carrierEnum;
      requestPayload.trackingNumber = args.params.trackingNumber.trim();
      requestPayload.labelFileData = args.params.labelFileData;
      requestPayload.labelFileName = args.params.labelFileName;
      break;
    }
    case "PROVIDE_EBAY_LABEL": {
      headline = "Provide an eBay return label (eBay charges you)";
      lines.push("eBay generates a prepaid return label and gives it to the buyer.");
      lines.push("eBay charges YOU, the seller, for the cost of this label.");
      lines.push("This is a paid, live action and cannot be undone from reorG.");
      if (args.params.carrierEnum) lines.push(`Carrier: ${args.params.carrierEnum}`);
      requiresTypedConfirmation = true;
      if (args.params.carrierEnum) requestPayload.carrierEnum = args.params.carrierEnum;
      break;
    }
    case "OFFER_PARTIAL_REFUND": {
      const amount = args.params.amount ?? 0;
      const check = validateRefundAmount({ amount, maxAmount: maxRefundFor(caseRow) });
      if (!check.ok) return { ok: false, error: check.error };
      headline = "Offer the buyer a partial refund";
      lines.push(`Offer amount: ${currency} ${amount.toFixed(2)}`);
      lines.push("The buyer can accept or decline this offer.");
      finalRefundAmount = amount;
      requiresTypedConfirmation = true;
      requestPayload.amount = amount;
      requestPayload.currency = currency;
      break;
    }
    case "ISSUE_REFUND": {
      const deductionType = args.params.deductionType ?? "none";
      const original =
        args.params.amount ??
        (Number.isFinite(maxRefundFor(caseRow)) ? maxRefundFor(caseRow) : 0);
      if (!Number.isFinite(original) || original <= 0) {
        return { ok: false, error: "Could not determine the refund amount from eBay." };
      }
      const ded = validateDeduction({
        originalAmount: original,
        deductionType,
        deductionValue: args.params.deductionValue ?? 0,
        reason: args.params.deductionReason,
        comment: args.params.deductionComment,
      });
      if (!ded.ok) return { ok: false, error: ded.error };
      headline = "Issue a refund to the buyer";
      lines.push(`Order total: ${currency} ${original.toFixed(2)}`);
      if (ded.deductionAmount > 0) {
        lines.push(`Deduction: −${currency} ${ded.deductionAmount.toFixed(2)}`);
        lines.push(`Reason: ${args.params.deductionReason}`);
      }
      lines.push(`Refund to buyer: ${currency} ${ded.finalRefund.toFixed(2)}`);
      lines.push("This is final and cannot be undone.");
      finalRefundAmount = ded.finalRefund;
      requiresTypedConfirmation = true;
      requestPayload.amount = ded.finalRefund;
      requestPayload.currency = currency;
      requestPayload.deductionAmount = ded.deductionAmount;
      requestPayload.deductionReason = args.params.deductionReason ?? null;
      break;
    }
    default:
      return { ok: false, error: "This action is not supported." };
  }

  if (args.params.comments) requestPayload.comments = args.params.comments;

  const idempotencyKey = randomUUID();
  const summary = {
    action: args.action,
    headline,
    lines,
    requiresTypedConfirmation,
    finalRefundAmount,
    currency,
  };

  await db.helpdeskReturnActionAttempt.create({
    data: {
      returnCaseId: caseRow.id,
      integrationId: caseRow.integrationId,
      userId: args.userId,
      actionType: args.action,
      status: HelpdeskReturnActionStatus.PREVIEWED,
      idempotencyKey,
      previewSummary: summary as unknown as Prisma.InputJsonValue,
      requestPayload: requestPayload as unknown as Prisma.InputJsonValue,
    },
  });

  return { ok: true, idempotencyKey, summary };
}

export interface CommitResult {
  ok: boolean;
  status: "COMMITTED" | "FAILED" | "BLOCKED";
  error?: string;
  ebayRequestId?: string | null;
  refundStatus?: string | null;
}

async function writeAudit(args: {
  userId: string;
  action: string;
  returnCaseId: string;
  details: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: args.userId,
        action: args.action,
        entityType: "HelpdeskReturnCase",
        entityId: args.returnCaseId,
        details: args.details as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.error("[helpdesk-returns] audit write failed", err);
  }
}

/**
 * Commit a previously-previewed action. Re-fetches the return from eBay, runs
 * the safety gate against FRESH availability, executes a single live write,
 * then audits + refreshes. Idempotent: a committed/failed key can't re-fire.
 */
export async function commitReturnAction(args: {
  returnId: string;
  userId: string;
  isAdmin: boolean;
  idempotencyKey: string;
  typedConfirmation?: string | null;
}): Promise<CommitResult> {
  const attempt = await db.helpdeskReturnActionAttempt.findUnique({
    where: { idempotencyKey: args.idempotencyKey },
  });
  if (!attempt) return { ok: false, status: "FAILED", error: "Unknown or expired preview token." };
  if (attempt.status !== HelpdeskReturnActionStatus.PREVIEWED) {
    return {
      ok: false,
      status: "FAILED",
      error: "This action was already processed. Start a new preview.",
    };
  }

  const action = attempt.actionType as ReturnActionKey;
  const payload = attempt.requestPayload as Record<string, unknown>;
  const summary = attempt.previewSummary as { requiresTypedConfirmation?: boolean };

  // Typed confirmation gate for paid/irreversible actions.
  if (summary?.requiresTypedConfirmation) {
    if ((args.typedConfirmation ?? "").trim().toUpperCase() !== "CONFIRM") {
      return { ok: false, status: "FAILED", error: 'Type "CONFIRM" to authorize this action.' };
    }
  }

  const caseRow = await resolveCaseByReturnId(args.returnId);
  if (!caseRow || caseRow.id !== attempt.returnCaseId) {
    return { ok: false, status: "FAILED", error: "Return not found." };
  }

  const integration = await db.integration.findUnique({ where: { id: caseRow.integrationId } });
  if (!integration) return { ok: false, status: "FAILED", error: "Integration not found." };
  const config = buildEbayConfig(integration);

  // STEP 1 — re-fetch the latest detail so availability is authoritative.
  const refresh = await refreshReturnDetail(args.returnId);
  const freshCase = refresh.caseRow ?? caseRow;
  let freshOptions = (freshCase.sellerAvailableOptions ?? []) as unknown as EbayAvailableOption[];

  // STEP 1b — Accept-then-act parity. eBay Seller Hub treats "provide a label"
  // (or "send a refund") on a STILL-REQUESTED return as accept + act in one
  // flow: clicking "Accept the return" just navigates to the label screen, and
  // submitting a label/refund is what actually resolves the request. We mirror
  // that: if the buyer's request is still pending (SELLER_APPROVE_REQUEST) and
  // the user chose a label/refund action that eBay hasn't surfaced yet, accept
  // the return first (gated as APPROVE_RETURN), then re-fetch so the chosen
  // option becomes available. The user already explicitly confirmed the
  // label/refund action, which on eBay inherently accepts the return.
  const ACCEPT_THEN_ACT: ReturnActionKey[] = [
    "PROVIDE_EBAY_LABEL",
    "UPLOAD_LABEL",
    "CONFIRM_LABEL_SENT",
    "ISSUE_REFUND",
    "OFFER_PARTIAL_REFUND",
  ];
  const stillRequested = extractActionTypes(freshOptions).includes("SELLER_APPROVE_REQUEST");
  if (stillRequested && ACCEPT_THEN_ACT.includes(action) && !isActionExecutable(action, freshOptions)) {
    const acceptGate = await assertReturnWriteAllowed({
      isAdmin: args.isAdmin,
      platform: integration.platform,
      action: "APPROVE_RETURN",
      freshSellerOptions: freshOptions,
    });
    if (!acceptGate.allowed) {
      await db.helpdeskReturnActionAttempt.update({
        where: { id: attempt.id },
        data: { status: HelpdeskReturnActionStatus.BLOCKED, blockReason: acceptGate.reason },
      });
      await writeAudit({
        userId: args.userId,
        action: "HELPDESK_RETURN_ACTION_BLOCKED",
        returnCaseId: caseRow.id,
        details: { action, step: "auto_accept", code: acceptGate.code, reason: acceptGate.reason, returnId: args.returnId },
      });
      return { ok: false, status: "BLOCKED", error: acceptGate.reason };
    }
    const acceptRes = await decideReturn({
      integrationId: integration.id,
      config,
      returnId: args.returnId,
      decision: "APPROVE",
    });
    if (!acceptRes.ok) {
      await db.helpdeskReturnActionAttempt.update({
        where: { id: attempt.id },
        data: {
          status: HelpdeskReturnActionStatus.FAILED,
          errorMessage: acceptRes.errorMessage ?? "Failed to accept the return before providing the label.",
        },
      });
      await writeAudit({
        userId: args.userId,
        action: "HELPDESK_RETURN_ACTION_FAILED",
        returnCaseId: caseRow.id,
        details: { action, step: "auto_accept", error: acceptRes.errorMessage, returnId: args.returnId },
      });
      return { ok: false, status: "FAILED", error: acceptRes.errorMessage ?? undefined };
    }
    await writeAudit({
      userId: args.userId,
      action: "HELPDESK_RETURN_AUTO_ACCEPTED",
      returnCaseId: caseRow.id,
      details: { action, returnId: args.returnId, ebayRequestId: acceptRes.requestId },
    });
    // Re-fetch so the label/refund option is now offered by eBay.
    try {
      const reRefresh = await refreshReturnDetail(args.returnId);
      if (reRefresh.caseRow?.sellerAvailableOptions) {
        freshOptions = reRefresh.caseRow.sellerAvailableOptions as unknown as EbayAvailableOption[];
      }
    } catch {
      /* non-fatal — gate below will catch an unavailable option */
    }
  }

  // STEP 2 — safety gate.
  const gate = await assertReturnWriteAllowed({
    isAdmin: args.isAdmin,
    platform: integration.platform,
    action,
    freshSellerOptions: freshOptions,
  });
  if (!gate.allowed) {
    await db.helpdeskReturnActionAttempt.update({
      where: { id: attempt.id },
      data: { status: HelpdeskReturnActionStatus.BLOCKED, blockReason: gate.reason },
    });
    await writeAudit({
      userId: args.userId,
      action: "HELPDESK_RETURN_ACTION_BLOCKED",
      returnCaseId: caseRow.id,
      details: { action, code: gate.code, reason: gate.reason, returnId: args.returnId },
    });
    return { ok: false, status: "BLOCKED", error: gate.reason };
  }

  // STEP 3 — single live eBay write.
  const currency = (payload.currency as string) ?? refundCurrencyFor(freshCase);
  const comments = (payload.comments as string) ?? undefined;
  let result: EbayReturnsCallResult<{ refundStatus?: string }>;
  try {
    switch (action) {
      case "APPROVE_RETURN":
        result = await decideReturn({
          integrationId: integration.id,
          config,
          returnId: args.returnId,
          decision: "APPROVE",
          comments,
        });
        break;
      case "DECLINE_RETURN":
        result = await decideReturn({
          integrationId: integration.id,
          config,
          returnId: args.returnId,
          decision: "DECLINE",
          comments,
        });
        break;
      case "OFFER_PARTIAL_REFUND":
        result = await decideReturn({
          integrationId: integration.id,
          config,
          returnId: args.returnId,
          decision: "OFFER_PARTIAL_REFUND",
          partialRefundAmount: { value: Number(payload.amount), currency },
          comments,
        });
        break;
      case "MARK_AS_RECEIVED":
        result = await markAsReceived({
          integrationId: integration.id,
          config,
          returnId: args.returnId,
          comments,
        });
        break;
      case "ISSUE_REFUND": {
        const requested = Number(payload.amount);
        // eBay caps each itemized line (PURCHASE_PRICE, ORIGINAL_SHIPPING, …) at
        // its estimated amount. Mirror that breakdown from the FRESH detail we
        // just fetched; otherwise a single PURCHASE_PRICE line is rejected with
        // "Refund amount cannot exceed estimated amount" whenever the order had
        // original shipping.
        const estLines = parseEstimatedRefundLines(refresh.detailResult?.body);
        if (estLines.length > 0) {
          // Deduction eligibility is decided off the buyer's original shipping
          // service (eBay exposes no usable deduction flag). buildItemizedRefund
          // blocks a deduction only when we're certain none is allowed; for the
          // allow case eBay remains the final authority on issue_refund.
          const deductionAllowed = isDeductionAllowedForShippingService(
            freshCase.buyerShippingServiceCode,
          );
          const built = buildItemizedRefund(estLines, requested, deductionAllowed);
          if (!built.ok) {
            await db.helpdeskReturnActionAttempt.update({
              where: { id: attempt.id },
              data: { status: HelpdeskReturnActionStatus.FAILED, errorMessage: built.error },
            });
            await writeAudit({
              userId: args.userId,
              action: "HELPDESK_RETURN_ACTION_FAILED",
              returnCaseId: caseRow.id,
              details: { action, step: "itemize_refund", error: built.error, returnId: args.returnId },
            });
            return { ok: false, status: "FAILED", error: built.error };
          }
          result = await issueRefund({
            integrationId: integration.id,
            config,
            returnId: args.returnId,
            totalAmount: { value: built.total, currency },
            itemizedRefundDetails: built.lines.map((l) => ({
              refundFeeType: l.refundFeeType,
              amount: { value: l.amount, currency },
            })),
            comments,
          });
        } else {
          // No itemized estimate from eBay — fall back to a single line.
          result = await issueRefund({
            integrationId: integration.id,
            config,
            returnId: args.returnId,
            totalAmount: { value: requested, currency },
            comments,
          });
        }
        break;
      }
      case "CONFIRM_LABEL_SENT":
        result = await addForwardedShippingLabel({
          integrationId: integration.id,
          config,
          returnId: args.returnId,
          carrierEnum: payload.carrierEnum as string | undefined,
          trackingNumber: payload.trackingNumber as string | undefined,
          comments,
        });
        break;
      case "UPLOAD_LABEL": {
        // First base64-upload the label file to eBay (if attached), then
        // reference the returned fileId from add_shipping_label.
        let fileId: string | undefined;
        const labelFileData = payload.labelFileData as string | undefined;
        const labelFileName = payload.labelFileName as string | undefined;
        if (labelFileData && labelFileName) {
          const upload = await uploadReturnFile({
            integrationId: integration.id,
            config,
            returnId: args.returnId,
            data: labelFileData,
            fileName: labelFileName,
            filePurpose: "LABEL_RELATED",
          });
          if (!upload.ok || !upload.body?.fileId) {
            throw new Error(upload.errorMessage ?? "Failed to upload the label file to eBay.");
          }
          fileId = upload.body.fileId;
        }
        result = await uploadReturnShippingLabel({
          integrationId: integration.id,
          config,
          returnId: args.returnId,
          carrierEnum: payload.carrierEnum as string,
          trackingNumber: payload.trackingNumber as string,
          fileId,
          comments,
        });
        break;
      }
      case "PROVIDE_EBAY_LABEL":
        result = (await provideEbayReturnLabel({
          integrationId: integration.id,
          config,
          returnId: args.returnId,
          carrierEnum: payload.carrierEnum as string | undefined,
          comments,
        })) as unknown as EbayReturnsCallResult<{ refundStatus?: string }>;
        break;
      default:
        return { ok: false, status: "FAILED", error: "Unsupported action." };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.helpdeskReturnActionAttempt.update({
      where: { id: attempt.id },
      data: { status: HelpdeskReturnActionStatus.FAILED, errorMessage: message },
    });
    await writeAudit({
      userId: args.userId,
      action: "HELPDESK_RETURN_ACTION_FAILED",
      returnCaseId: caseRow.id,
      details: { action, error: message, returnId: args.returnId },
    });
    return { ok: false, status: "FAILED", error: message };
  }

  const refundStatus = result.body?.refundStatus ?? null;

  // STEP 4 — audit + persist outcome.
  await db.helpdeskReturnActionAttempt.update({
    where: { id: attempt.id },
    data: {
      status: result.ok ? HelpdeskReturnActionStatus.COMMITTED : HelpdeskReturnActionStatus.FAILED,
      committedAt: result.ok ? new Date() : null,
      ebayRequestId: result.requestId,
      responsePayload: {
        status: result.status,
        refundStatus,
        errors: result.errors,
      } as unknown as Prisma.InputJsonValue,
      errorMessage: result.ok ? null : result.errorMessage,
    },
  });
  await writeAudit({
    userId: args.userId,
    action: result.ok ? "HELPDESK_RETURN_ACTION_COMMITTED" : "HELPDESK_RETURN_ACTION_FAILED",
    returnCaseId: caseRow.id,
    details: {
      action,
      returnId: args.returnId,
      ebayStatus: result.status,
      ebayRequestId: result.requestId,
      refundStatus,
      ok: result.ok,
      amount: payload.amount ?? null,
      currency,
    },
  });

  if (!result.ok) {
    return {
      ok: false,
      status: "FAILED",
      error: result.errorMessage ?? undefined,
      ebayRequestId: result.requestId,
    };
  }

  // STEP 5 — targeted refresh so the UI reflects the new eBay state.
  try {
    await refreshReturnDetail(args.returnId);
  } catch {
    /* non-fatal — the next sync tick will reconcile */
  }

  return { ok: true, status: "COMMITTED", ebayRequestId: result.requestId, refundStatus };
}

// ─── Message correspondence (read-only) ───────────────────────────────────────

export interface CorrespondenceMessage {
  id: string;
  direction: string;
  source: string;
  fromName: string | null;
  bodyText: string;
  isHtml: boolean;
  sentAt: string;
}

export interface CorrespondenceThread {
  ticketId: string;
  subject: string | null;
  ebayOrderNumber: string | null;
  messages: CorrespondenceMessage[];
}

export interface ReturnCorrespondence {
  buyerUserId: string | null;
  threads: CorrespondenceThread[];
  ticketSearchHref: string | null;
}

const EBAY_SYSTEM_SENDER = /^ebay$/i;

/**
 * Returns true only for genuine buyer↔seller communication. Filters out eBay
 * system notifications (return-request alerts, refund/feedback notices) — which
 * arrive as inbound EBAY-source messages whose sender is literally "eBay" — and
 * internal SYSTEM-source event rows. This mirrors how `ThreadView` distinguishes
 * `isEbaySystem` notifications from real messages in the main Help Desk.
 */
function isBuyerSellerMessage(m: {
  source: string;
  fromName: string | null;
  fromIdentifier: string | null;
  bodyText: string | null;
}): boolean {
  if (m.source === "SYSTEM") return false;
  if (
    m.source === "EBAY" &&
    (EBAY_SYSTEM_SENDER.test(m.fromName ?? "") || EBAY_SYSTEM_SENDER.test(m.fromIdentifier ?? ""))
  ) {
    return false;
  }
  // Digest-envelope stubs are storage placeholders, not real message content —
  // their sub-messages are stored separately, so hide the empty stub.
  const body = (m.bodyText ?? "").trim();
  if (!body) return false;
  if (/digest envelope.*stripped to save storage/i.test(body)) return false;
  return true;
}

/**
 * Gather the Help Desk message correspondence tied to a return's buyer so the
 * detail page can show it inline (read-only). Prefers the directly-linked
 * ticket, then widens to every ticket for the same buyer on the same store.
 * Never writes anything.
 */
export async function getReturnCorrespondence(returnId: string): Promise<ReturnCorrespondence | null> {
  const caseRow = await resolveCaseByReturnId(returnId);
  if (!caseRow) return null;

  const orFilters: Prisma.HelpdeskTicketWhereInput[] = [];
  if (caseRow.ticketId) orFilters.push({ id: caseRow.ticketId });
  if (caseRow.buyerUserId) {
    orFilters.push({
      integrationId: caseRow.integrationId,
      buyerUserId: { equals: caseRow.buyerUserId, mode: Prisma.QueryMode.insensitive },
    });
  }
  if (caseRow.ebayOrderNumber) {
    orFilters.push({
      integrationId: caseRow.integrationId,
      ebayOrderNumber: caseRow.ebayOrderNumber,
    });
  }

  const ticketSearchHref = caseRow.buyerUserId
    ? `/help-desk?q=${encodeURIComponent(caseRow.buyerUserId)}`
    : null;

  if (orFilters.length === 0) {
    return { buyerUserId: caseRow.buyerUserId, threads: [], ticketSearchHref };
  }

  const tickets = await db.helpdeskTicket.findMany({
    where: { OR: orFilters },
    orderBy: { lastBuyerMessageAt: "desc" },
    take: 10,
    select: {
      id: true,
      subject: true,
      ebayOrderNumber: true,
      messages: {
        where: { deletedAt: null },
        orderBy: { sentAt: "asc" },
        take: 200,
        select: {
          id: true,
          direction: true,
          source: true,
          fromName: true,
          fromIdentifier: true,
          bodyText: true,
          isHtml: true,
          sentAt: true,
        },
      },
    },
  });

  const threads: CorrespondenceThread[] = tickets
    .map((t) => ({
      ticketId: t.id,
      subject: t.subject,
      ebayOrderNumber: t.ebayOrderNumber,
      // Only true buyer↔seller communication — drop eBay system notifications
      // (return-request alerts, refund/feedback notices) and internal SYSTEM
      // rows so this mirrors the human conversation, just like the Help Desk
      // thread shows when you search the buyer/order directly.
      messages: t.messages
        .filter((m) => isBuyerSellerMessage(m))
        .map((m) => ({
          id: m.id,
          direction: m.direction,
          source: m.source,
          fromName: m.fromName,
          bodyText: m.bodyText,
          isHtml: m.isHtml,
          sentAt: m.sentAt.toISOString(),
        })),
    }))
    .filter((t) => t.messages.length > 0);

  return { buyerUserId: caseRow.buyerUserId, threads, ticketSearchHref };
}

export { parseAmount };
