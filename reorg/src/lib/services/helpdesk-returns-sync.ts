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
  type EbayReturnSummary,
} from "@/lib/helpdesk/returns";

const EBAY_PLATFORMS: Platform[] = [Platform.TPP_EBAY, Platform.TT_EBAY];

const INITIAL_LOOKBACK_DAYS = Number.parseInt(
  process.env.HELPDESK_RETURNS_BACKFILL_DAYS ?? process.env.HELPDESK_BACKFILL_DAYS ?? "90",
  10,
);
const MAX_PAGES_PER_TICK = 10;
const PAGE_SIZE = 100;
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

  let upserted = 0;
  let offset = 0;
  for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
    const { members, totalPages, result } = await searchReturns({
      integrationId: integration.id,
      config,
      fromDate,
      toDate: new Date(),
      offset,
      limit: PAGE_SIZE,
    });
    if (!result.ok && result.status !== 0 && members.length === 0 && page === 0) {
      // Surface a hard failure on the very first page; empty windows (204/404)
      // come back ok-ish with members=[] and are not errors.
      if (result.status >= 400 && result.status !== 404) {
        throw new Error(result.errorMessage ?? `return/search ${result.status}`);
      }
    }

    for (const member of members) {
      const raw = member as EbayReturnSummary;
      const fields = normalizeReturnSummary(raw);
      if (!fields.returnId) continue;

      const ticketId = await findTicketIdForReturn({
        integrationId: integration.id,
        ebayOrderNumber: fields.ebayOrderNumber,
        buyerUserId: fields.buyerUserId,
      });

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
        sellerActionDue: fields.sellerActionDue,
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
            returnId: fields.returnId,
          },
        },
        create: {
          integrationId: integration.id,
          returnId: fields.returnId,
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

    if (members.length < PAGE_SIZE || page + 1 >= totalPages) break;
    offset += PAGE_SIZE;
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
    where: { integrationId: integration.id, itemTitle: null },
    orderBy: { openedAt: "desc" },
    take: ENRICH_BUDGET_PER_TICK,
    select: { id: true, returnId: true, ebayItemId: true },
  });
  if (missing.length === 0) return;

  for (const row of missing) {
    let itemTitle: string | null = null;
    let imageUrl: string | null = null;
    let sku: string | null = null;

    // (1) Local catalog lookup — free, no eBay call.
    if (row.ebayItemId) {
      const listing = await db.marketplaceListing.findFirst({
        where: { integrationId: integration.id, platformItemId: row.ebayItemId },
        select: { title: true, imageUrl: true, sku: true },
      });
      if (listing?.title) {
        itemTitle = listing.title;
        imageUrl = listing.imageUrl ?? null;
        sku = listing.sku ?? null;
      }
    }

    // (2) Fall back to Get Return detail (authoritative title + pic url).
    if (!itemTitle) {
      const detail = await getReturnDetail({
        integrationId: integration.id,
        config,
        returnId: row.returnId,
      });
      if (detail.ok && detail.body) {
        const p = extractItemPresentation(detail.body as EbayReturnSummary);
        itemTitle = p.itemTitle;
        imageUrl = imageUrl ?? p.imageUrl;
        sku = sku ?? p.sku;
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
      summary.upserted = await syncReturnsForIntegration(integration, config);
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
    summary.upserted = await syncReturnsForIntegration(integration, config);
  } catch (err) {
    summary.errors.push(err instanceof Error ? err.message : String(err));
  }
  return summary;
}
