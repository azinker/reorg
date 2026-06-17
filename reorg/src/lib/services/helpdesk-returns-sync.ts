/**
 * eBay Returns pull-only sync worker.
 *
 * Mirrors eBay return requests into HelpdeskReturnCase rows so the list page +
 * needs-attention badge can render instantly from our DB (hybrid freshness:
 * list = local cache, detail/actions = direct eBay refresh).
 *
 * SAFETY: This worker is strictly READ-ONLY against eBay. It only calls the
 * search/get READ wrappers and only WRITES to our own tables
 * (HelpdeskReturnCase + HelpdeskReturnSyncCheckpoint). It never invokes a write
 * wrapper, never marks anything on eBay, and is idempotent on
 * (integrationId, returnId) so re-running a tick never duplicates a row.
 *
 * It also never overwrites agent-authored linkage: ticketId is only ever
 * filled in (never cleared) by sync.
 */

import { db } from "@/lib/db";
import { Platform, Prisma, type Integration } from "@prisma/client";
import { buildEbayConfig } from "@/lib/services/helpdesk-ebay";
import {
  searchReturns,
  getReturnDetail,
} from "@/lib/services/helpdesk-ebay-returns-client";
import {
  normalizeReturnSummary,
  extractItemPresentation,
  RETURN_SYNC_BUCKETS,
  type EbayReturnSummary,
} from "@/lib/helpdesk/returns";
import { resolveOrderLineSku } from "@/lib/services/helpdesk-returns";

const EBAY_PLATFORMS: Platform[] = [Platform.TPP_EBAY, Platform.TT_EBAY];

const INITIAL_LOOKBACK_DAYS = Number.parseInt(
  process.env.HELPDESK_RETURNS_BACKFILL_DAYS ?? process.env.HELPDESK_BACKFILL_DAYS ?? "90",
  10,
);
/** eBay caps return/search at 200 entries per page; use the max to minimize calls. */
const PAGE_SIZE = 200;
/** Open/shipped/delivered buckets are small — page them to completion. */
const MAX_PAGES_PER_TICK = 20;
/**
 * The CLOSED bucket can hold thousands of returns. We page it newest-first up
 * to this depth (≈2000 entries) so the table shows a large, representative
 * slice; the actual stop is governed by the shared time budget below so the
 * cron never exceeds its serverless maxDuration. Open buckets are tiny and
 * always page to completion.
 */
const CLOSED_MAX_PAGES = 12;
/**
 * Wall-clock budget for the whole multi-integration sync. Open/shipped/
 * delivered always finish (they're small); CLOSED stops paging once we cross
 * this so a slow eBay never trips Vercel's 120s maxDuration. CLOSED converges
 * across ticks since it's idempotent on (integrationId, returnId).
 */
const SYNC_TIME_BUDGET_MS = 95_000;
/** How many returns missing a title/image we enrich (via Get Return) per tick. */
const ENRICH_BUDGET_PER_TICK = 30;

export interface ReturnsSyncSummary {
  integrationId: string;
  platform: Platform;
  upserted: number;
  errors: string[];
}

/** Best-effort ticket linkage by order number then buyer (read-only). */
async function findTicketIdForReturn(args: {
  integrationId: string;
  ebayOrderNumber: string | null;
  buyerUserId: string | null;
}): Promise<string | null> {
  if (args.ebayOrderNumber) {
    const t = await db.helpdeskTicket.findFirst({
      where: { integrationId: args.integrationId, ebayOrderNumber: args.ebayOrderNumber },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (t) return t.id;
  }
  if (args.buyerUserId) {
    const t = await db.helpdeskTicket.findFirst({
      where: {
        integrationId: args.integrationId,
        buyerUserId: { equals: args.buyerUserId, mode: Prisma.QueryMode.insensitive },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (t) return t.id;
  }
  return null;
}

async function syncReturnsForIntegration(
  integration: Integration,
  config: Awaited<ReturnType<typeof buildEbayConfig>>,
  deadline: number,
): Promise<number> {
  const checkpoint = await db.helpdeskReturnSyncCheckpoint.upsert({
    where: { integrationId: integration.id },
    create: { integrationId: integration.id },
    update: {},
  });
  // Always scan a rolling lookback window rather than walking forward from a
  // watermark. eBay returns are low-volume, so re-scanning the last N days
  // every tick is cheap and guarantees two things the forward-watermark
  // approach silently broke: (1) a return that's still open is never dropped,
  // and (2) state changes on already-synced returns (approved → shipped →
  // refunded) get refreshed in the list, not just on the detail page.
  const fromDate = new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86_400_000);
  const toDate = new Date();

  // Query eBay once per ReturnCountFilterEnum bucket and union the buckets each
  // return appears in. This is exactly how Seller Hub's status dropdown counts
  // are computed, so our list filters (in progress / shipped / delivered /
  // closed) now match eBay 1:1 instead of guessing from a single raw state.
  const collected = new Map<
    string,
    { raw: EbayReturnSummary; fields: ReturnType<typeof normalizeReturnSummary>; buckets: Set<string> }
  >();

  for (const bucket of RETURN_SYNC_BUCKETS) {
    const isClosed = bucket === "CLOSED";
    const maxPages = isClosed ? CLOSED_MAX_PAGES : MAX_PAGES_PER_TICK;
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      // The CLOSED bucket is huge; yield once we cross the shared time budget so
      // the cron never trips its serverless maxDuration. Small open/shipped/
      // delivered buckets always run to completion regardless of the clock.
      if (isClosed && page > 0 && Date.now() > deadline) break;
      const { members, total, totalPages, result } = await searchReturns({
        integrationId: integration.id,
        config,
        fromDate,
        toDate,
        returnState: bucket,
        offset,
        limit: PAGE_SIZE,
      });
      if (page === 0 && members.length === 0 && result.status >= 400 && result.status !== 404) {
        // Surface a hard failure on the very first page; empty buckets (204/404)
        // come back ok-ish with members=[] and are not errors.
        throw new Error(result.errorMessage ?? `return/search ${bucket} ${result.status}`);
      }

      for (const member of members) {
        const raw = member as EbayReturnSummary;
        const fields = normalizeReturnSummary(raw);
        if (!fields.returnId) continue;
        const existing = collected.get(fields.returnId);
        if (existing) {
          existing.buckets.add(bucket);
        } else {
          collected.set(fields.returnId, { raw, fields, buckets: new Set([bucket]) });
        }
      }

      // Stop when this page was the last one. Use the authoritative
      // paginationOutput-derived total/totalPages (NOT the broken top-level
      // `total`, which used to report the page size and capped us at one page).
      const fetchedSoFar = offset + members.length;
      if (members.length < PAGE_SIZE || page + 1 >= totalPages || fetchedSoFar >= total) break;
      offset += PAGE_SIZE;
    }
  }

  // Pre-load existing rows' ticket linkage in ONE query so we only run the
  // (expensive) per-return ticket lookup for rows that don't have a ticket yet.
  // Without this the upsert loop ran up to 2 ticket queries × hundreds of rows
  // every tick, which dominated the sync time budget.
  const returnIds = Array.from(collected.keys());
  const existingRows = await db.helpdeskReturnCase.findMany({
    where: { integrationId: integration.id, returnId: { in: returnIds } },
    select: { returnId: true, ticketId: true },
  });
  const existingTicketByReturnId = new Map(existingRows.map((r) => [r.returnId, r.ticketId]));

  let upserted = 0;
  for (const [returnId, { raw, fields, buckets }] of collected.entries()) {
    // Only resolve ticket linkage when we don't already have one for this row.
    let ticketId = existingTicketByReturnId.get(returnId) ?? null;
    if (!ticketId) {
      ticketId = await findTicketIdForReturn({
        integrationId: integration.id,
        ebayOrderNumber: fields.ebayOrderNumber,
        buyerUserId: fields.buyerUserId,
      });
    }

    const commonData = {
      platform: integration.platform,
      ebayOrderNumber: fields.ebayOrderNumber,
      ebayItemId: fields.ebayItemId,
      transactionId: fields.transactionId,
      returnQuantity: fields.returnQuantity,
      buyerUserId: fields.buyerUserId,
      sellerUserId: fields.sellerUserId,
      returnState: fields.returnState,
      returnStatus: fields.returnStatus,
      currentType: fields.currentType,
      ebayBuckets: Array.from(buckets) as unknown as Prisma.InputJsonValue,
      sellerActionDue: fields.sellerActionDue || buckets.has("SELLER_ACTION_DUE"),
      escalated: fields.escalated,
      caseId: fields.caseId,
      reason: fields.reason,
      reasonType: fields.reasonType,
      buyerComments: fields.buyerComments,
      sellerRefundValue: fields.sellerRefundValue,
      sellerRefundCurrency: fields.sellerRefundCurrency,
      buyerRefundValue: fields.buyerRefundValue,
      buyerRefundCurrency: fields.buyerRefundCurrency,
      refundIsActual: fields.refundIsActual,
      sellerResponseDueAt: fields.sellerResponseDueAt,
      buyerResponseDueAt: fields.buyerResponseDueAt,
      timeoutDate: fields.timeoutDate,
      openedAt: fields.openedAt ?? new Date(),
      closedAt: fields.closedAt,
      sellerAvailableOptions: fields.sellerAvailableOptions as unknown as Prisma.InputJsonValue,
      buyerAvailableOptions: fields.buyerAvailableOptions as unknown as Prisma.InputJsonValue,
      rawSummary: raw as unknown as Prisma.InputJsonValue,
      lastSyncedAt: new Date(),
    };

    await db.helpdeskReturnCase.upsert({
      where: {
        integrationId_returnId: {
          integrationId: integration.id,
          returnId,
        },
      },
      create: {
        integrationId: integration.id,
        returnId,
        // Only set the ticket linkage on create; on update we fill it only
        // when we found one (never clear an existing link).
        ticketId,
        ...commonData,
      },
      update: {
        ...commonData,
        ...(ticketId ? { ticketId } : {}),
      },
    });
    upserted++;
  }

  // Search summaries don't carry the listing title/image — only Get Return
  // does. Hydrate rows that are still missing a title, prefering our local
  // catalog (no API call) and falling back to a budgeted Get Return.
  await enrichMissingItemDetails(integration, config);

  await db.helpdeskReturnSyncCheckpoint.update({
    where: { id: checkpoint.id },
    data: { lastWatermark: new Date(), lastFullSyncAt: new Date(), backfillDone: true },
  });
  return upserted;
}

/**
 * Fill in itemTitle/imageUrl/sku for returns that don't have them yet. The eBay
 * Search Returns response omits item presentation, so we hydrate from (1) our
 * MarketplaceListing catalog by eBay item id when present (free), then (2) a
 * bounded number of Get Return detail calls. Title never changes once set, so
 * this runs only against rows where itemTitle is still null and is capped per
 * tick to keep the sync well under the serverless time budget.
 */
async function enrichMissingItemDetails(
  integration: Integration,
  config: Awaited<ReturnType<typeof buildEbayConfig>>,
): Promise<void> {
  const missing = await db.helpdeskReturnCase.findMany({
    // Rows still missing a title, image, OR sku need hydration. Including
    // image-less rows lets us correct variation thumbnails once we learn the
    // purchased variant's SKU (see SKU-match step below); including sku-less
    // rows lets us backfill the SKU from our catalog by item id even when the
    // title/image already arrived from the search summary.
    where: {
      integrationId: integration.id,
      OR: [{ itemTitle: null }, { imageUrl: null }, { sku: null }],
    },
    orderBy: { openedAt: "desc" },
    take: ENRICH_BUDGET_PER_TICK,
    select: {
      id: true,
      returnId: true,
      ebayItemId: true,
      ebayOrderNumber: true,
      transactionId: true,
      itemTitle: true,
      sku: true,
    },
  });
  if (missing.length === 0) return;

  for (const row of missing) {
    let itemTitle: string | null = row.itemTitle;
    let imageUrl: string | null = null;
    let sku: string | null = row.sku;

    // (1) Authoritative SKU from the actual ORDER transaction the buyer
    // purchased. This is the ground truth for the variant (eBay's return
    // itemDetail.sku is wrong for multi-variation listings), so it OVERRIDES
    // any prior value and drives the variation-thumbnail match below.
    const orderSku = await resolveOrderLineSku(integration.id, config, {
      orderNumber: row.ebayOrderNumber,
      transactionId: row.transactionId,
      itemId: row.ebayItemId,
    });
    if (orderSku) sku = orderSku;

    // (2) Get Return detail for title/image (and SKU only as a fallback when
    // the order didn't yield one). The pic is often the parent/default variant.
    if (!itemTitle || !imageUrl || !sku) {
      const detail = await getReturnDetail({
        integrationId: integration.id,
        config,
        returnId: row.returnId,
        // itemDetail (title + pic + sku) only ships in the FULL/`detail` container.
        fieldgroups: "FULL",
      });
      if (detail.ok && detail.body) {
        const p = extractItemPresentation(detail.body as EbayReturnSummary);
        itemTitle = itemTitle ?? p.itemTitle;
        imageUrl = p.imageUrl; // eBay's pic (often the parent/default variant image)
        sku = sku ?? p.sku;
      }
    }

    // (2) Variant-accurate thumbnail: match the purchased SKU against our own
    // catalog. Each variation child listing has its own SKU + imageUrl, so a
    // SKU match yields the exact variant the buyer purchased (e.g. the BLACK
    // controller, not the parent's WHITE default). This overrides the eBay pic.
    if (sku) {
      const bySku = await db.marketplaceListing.findFirst({
        where: { integrationId: integration.id, sku },
        select: { title: true, imageUrl: true },
      });
      if (bySku?.imageUrl) imageUrl = bySku.imageUrl;
      if (!itemTitle && bySku?.title) itemTitle = bySku.title;
    }

    // (3) Last-resort fallbacks from the parent listing by item id (free).
    if ((!itemTitle || !imageUrl) && row.ebayItemId) {
      const listing = await db.marketplaceListing.findFirst({
        where: { integrationId: integration.id, platformItemId: row.ebayItemId },
        select: { title: true, imageUrl: true, sku: true },
      });
      if (listing) {
        itemTitle = itemTitle ?? listing.title ?? null;
        imageUrl = imageUrl ?? listing.imageUrl ?? null;
        sku = sku ?? listing.sku ?? null;
      }
    }

    if (itemTitle || imageUrl || sku) {
      await db.helpdeskReturnCase.update({
        where: { id: row.id },
        data: {
          ...(itemTitle ? { itemTitle } : {}),
          ...(imageUrl ? { imageUrl } : {}),
          ...(sku ? { sku } : {}),
        },
      });
    }
  }
}

/**
 * Run the returns sync across every enabled eBay integration (TPP + TT).
 * Each integration is isolated in try/catch so one store failing doesn't take
 * down the others. Safe to call from the same cron tick as the message poll.
 */
export async function runHelpdeskReturnsSync(): Promise<{
  durationMs: number;
  summaries: ReturnsSyncSummary[];
}> {
  const startedAt = Date.now();
  const deadline = startedAt + SYNC_TIME_BUDGET_MS;
  const summaries: ReturnsSyncSummary[] = [];

  const integrations = await db.integration.findMany({
    where: { enabled: true, platform: { in: EBAY_PLATFORMS } },
  });

  for (const integration of integrations) {
    const config = buildEbayConfig(integration);
    const summary: ReturnsSyncSummary = {
      integrationId: integration.id,
      platform: integration.platform,
      upserted: 0,
      errors: [],
    };
    if (!config.appId || !config.refreshToken) {
      summary.errors.push("missing eBay credentials");
      summaries.push(summary);
      continue;
    }
    try {
      summary.upserted = await syncReturnsForIntegration(integration, config, deadline);
    } catch (err) {
      summary.errors.push(err instanceof Error ? err.message : String(err));
    }
    summaries.push(summary);
  }

  return { durationMs: Date.now() - startedAt, summaries };
}

/** Sync a single integration on demand (used by manual "Sync now" if wired). */
export async function runHelpdeskReturnsSyncForIntegration(
  integrationId: string,
): Promise<ReturnsSyncSummary> {
  const integration = await db.integration.findUnique({ where: { id: integrationId } });
  const summary: ReturnsSyncSummary = {
    integrationId,
    platform: integration?.platform ?? Platform.TPP_EBAY,
    upserted: 0,
    errors: [],
  };
  if (!integration || !integration.enabled) {
    summary.errors.push("integration not found or disabled");
    return summary;
  }
  if (!EBAY_PLATFORMS.includes(integration.platform)) {
    summary.errors.push("not an eBay integration");
    return summary;
  }
  const config = buildEbayConfig(integration);
  if (!config.appId || !config.refreshToken) {
    summary.errors.push("missing eBay credentials");
    return summary;
  }
  try {
    summary.upserted = await syncReturnsForIntegration(
      integration,
      config,
      Date.now() + SYNC_TIME_BUDGET_MS,
    );
  } catch (err) {
    summary.errors.push(err instanceof Error ? err.message : String(err));
  }
  return summary;
}
