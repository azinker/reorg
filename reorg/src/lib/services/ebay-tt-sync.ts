import { db } from "@/lib/db";
import { Platform, Prisma, type Integration, type SyncStatus } from "@prisma/client";
import { XMLParser } from "fast-xml-parser";
import type { RawListing } from "@/lib/integrations/types";
import { getIntegrationConfig, mergeIntegrationConfig } from "@/lib/integrations/runtime-config";
import {
  buildCompletedSyncConfigFromLatest,
  type SyncExecutionOptions,
} from "@/lib/services/sync-control";
import {
  buildEbayQuotaExhaustedMessage,
  fetchRateLimitSnapshotWithToken,
  getEbayMethodRate,
  getEbayTradingRateLimitSnapshotForIntegration,
  mergeSyncCallsIntoLocalUsage,
  serializeSnapshotForConfig,
  type EbayTradingRateLimitSnapshot,
  type LocalEbayApiUsage,
  type MonitoredEbayMethod,
} from "@/lib/services/ebay-analytics";
import {
  buildEbayIncrementalBudgetPlan,
  getPendingIncrementalWindow,
  getSharedEbayQuotaStoreCount,
} from "@/lib/services/ebay-sync-budget";
import {
  getFallbackPerRunEbayGetItemBudget,
  getPerRunEbayGetItemBudget,
} from "@/lib/services/ebay-sync-policy";
import {
  matchListings,
  upsertMarketplaceListings,
} from "@/lib/services/matching";
import { removeMarketplaceListingsOlderThan } from "@/lib/services/listing-prune";
import { repairVariationFamiliesForIntegration } from "@/lib/services/variation-repair";
import { propagateEbayRateLimitToAllSharedIntegrations } from "@/lib/services/ebay-rate-limit";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const MARKETING_API_BASE = "https://api.ebay.com/sell/marketing/v1";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const ADS_PAGE_SIZE = 500;
const GETITEM_CONCURRENCY = 8;
const GETITEM_BATCH_DELAY_MS = 100;
const EBAY_USAGE_LIMIT_ERROR_CODE = "518";
const EBAY_INVALID_TOKEN_ERROR_CODE = "21916984";
const GET_SELLER_EVENTS_RETRY_DELAYS_MS = [3_000, 8_000];
const GET_ITEM_RETRY_DELAYS_MS = [1_000, 3_000];
const REQUEST_TIMEOUT_MS = 30_000;
const SYNC_WALL_CLOCK_LIMIT_MS = 700_000;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  isArray: (tagName) => {
    const alwaysArray = new Set([
      "Item",
      "Variation",
      "NameValueList",
      "PictureURL",
      "VariationSpecificPictureSet",
    ]);
    return alwaysArray.has(tagName);
  },
});

interface EbayConfig {
  appId: string;
  certId: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  accountUserId?: string | null;
}

interface SyncProgress {
  jobId: string;
  status: SyncStatus;
  itemsProcessed: number;
  itemsCreated: number;
  itemsUpdated: number;
  errors: Array<{ sku: string; message: string }>;
}

interface IncrementalWindow {
  itemIds: string[];
  windowEndedAt: Date;
  eventItemsById?: Record<string, unknown>;
}

interface MarketingCampaign {
  campaignId?: string;
  campaignStatus?: string;
  fundingStrategy?: { fundingModel?: string };
}

interface MarketingAd {
  listingId?: string;
  bidPercentage?: string;
}

class EbayTradingApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "EbayTradingApiError";
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const UPSERT_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`eBay request timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function clearAccessTokenCache(config: EbayConfig) {
  config.accessToken = undefined;
  config.accessTokenExpiresAt = undefined;
}

function extractSellerUserId(item: unknown): string | null {
  const seller = obj(item, "Seller");
  return seller ? str(seller, "UserID") ?? null : null;
}

function normalizeSellerIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function extractStorefrontSellerId(item: unknown): string | null {
  const storefront = obj(item, "Storefront");
  const storefrontUrl = storefront ? str(storefront, "StoreURL") : null;
  if (!storefrontUrl) {
    return null;
  }

  try {
    const url = new URL(storefrontUrl);
    const segments = url.pathname
      .split("/")
      .map((segment) => segment.trim().toLowerCase())
      .filter(Boolean);
    const sellerSegment = segments.at(-1);
    return sellerSegment || null;
  } catch {
    const match = storefrontUrl.match(/\/(?:str|usr)\/([^/?#]+)/i);
    return normalizeSellerIdentity(match?.[1]);
  }
}

function matchesConfiguredSeller(item: unknown, config: EbayConfig): boolean {
  const expectedSellerId = normalizeSellerIdentity(config.accountUserId);
  if (!expectedSellerId) {
    return true;
  }

  const actualSellerId = normalizeSellerIdentity(extractSellerUserId(item));
  const storefrontSellerId = normalizeSellerIdentity(extractStorefrontSellerId(item));
  const knownSellerIds = [actualSellerId, storefrontSellerId].filter(
    (value): value is string => Boolean(value),
  );

  if (knownSellerIds.length === 0) {
    return true;
  }

  return knownSellerIds.every((sellerId) => sellerId === expectedSellerId);
}

async function removeForeignSellerListings(integrationId: string, itemId: string) {
  await Promise.all([
    db.marketplaceListing.deleteMany({
      where: { integrationId, platformItemId: itemId },
    }),
    db.unmatchedListing.deleteMany({
      where: { integrationId, platformItemId: itemId },
    }),
  ]);
}

async function purgeForeignSellerListingsForIntegration(
  integrationId: string,
  config: EbayConfig,
) {
  if (!normalizeSellerIdentity(config.accountUserId)) {
    return;
  }

  const BATCH_SIZE = 200;
  const foreignItemIds = new Set<string>();
  let cursor: string | undefined;

  // Paginate to avoid loading all rawData blobs into memory at once (OOM risk).
  for (;;) {
    const batch = await db.marketplaceListing.findMany({
      where: { integrationId },
      select: { id: true, platformItemId: true, rawData: true },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    });

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const listing of batch) {
      const rawData =
        listing.rawData && typeof listing.rawData === "object"
          ? (listing.rawData as Record<string, unknown>)
          : null;
      const item = rawData?.item ?? rawData;
      if (item && !matchesConfiguredSeller(item, config) && listing.platformItemId) {
        foreignItemIds.add(listing.platformItemId);
      }
    }

    if (batch.length < BATCH_SIZE) break;
  }

  if (foreignItemIds.size === 0) {
    return;
  }

  const ids = [...foreignItemIds];
  await Promise.all([
    db.marketplaceListing.deleteMany({
      where: { integrationId, platformItemId: { in: ids } },
    }),
    db.unmatchedListing.deleteMany({
      where: { integrationId, platformItemId: { in: ids } },
    }),
  ]);
}

function normalizeTradingErrors(rawErrors: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(rawErrors)) {
    return rawErrors.filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === "object" && !Array.isArray(entry),
    );
  }

  if (rawErrors && typeof rawErrors === "object") {
    return [rawErrors as Record<string, unknown>];
  }

  return [];
}

async function recordRateLimitState(
  integrationId: string,
  message: string,
  pendingIncrementalItemIds: string[] = [],
  pendingIncrementalWindowEndedAt: string | null = null,
  rateLimitResetAt?: string | null,
) {
  const integration = await db.integration.findUnique({
    where: { id: integrationId },
    select: { platform: true, config: true },
  });
  if (!integration) return;

  const config = getIntegrationConfig(integration);
  await db.integration.update({
    where: { id: integrationId },
    data: {
      config: {
        ...config,
        syncState: {
          ...config.syncState,
          lastRateLimitAt: new Date().toISOString(),
          lastRateLimitResetAt: rateLimitResetAt ?? null,
          lastRateLimitMessage: message,
          pendingIncrementalItemIds,
          pendingIncrementalWindowEndedAt,
        },
      } as unknown as Prisma.InputJsonValue,
    },
  });

  // Both eBay stores share the same developer app quota — propagate cooldown
  // to sibling eBay integrations so they all show the cooldown banner.
  void propagateEbayRateLimitToAllSharedIntegrations(integrationId, message, rateLimitResetAt);
}

export async function runEbayTtSync(
  options: SyncExecutionOptions = {},
): Promise<SyncProgress> {
  const integration = await db.integration.findUnique({
    where: { platform: Platform.TT_EBAY },
  });

  if (!integration?.enabled) {
    throw new Error("eBay TT integration is not enabled");
  }

  const config = integration.config as Record<string, unknown>;
  const appId =
    getString(config.appId) ??
    process.env.EBAY_TT_APP_ID ??
    process.env.EBAY_TPP_APP_ID;
  const certId =
    getString(config.certId) ??
    process.env.EBAY_TT_CERT_ID ??
    process.env.EBAY_TPP_CERT_ID;
  const refreshToken =
    getString(config.refreshToken) ?? process.env.EBAY_TT_REFRESH_TOKEN;

  if (!appId || !certId || !refreshToken) {
    throw new Error("eBay TT credentials missing from integration config");
  }

  const ebayConfig: EbayConfig = {
    appId,
    certId,
    refreshToken,
    accessToken: getString(config.accessToken),
    accountUserId: getString(config.accountUserId) ?? null,
    accessTokenExpiresAt:
      typeof config.accessTokenExpiresAt === "number"
        ? config.accessTokenExpiresAt
        : undefined,
  };

  if (!options.skipHeavyOperations) {
    try {
      await purgeForeignSellerListingsForIntegration(integration.id, ebayConfig);
    } catch (purgeErr) {
      console.error("[ebay-tt-sync] Foreign seller purge failed (non-fatal):", purgeErr);
    }
  }

  const syncJob = options.existingJobId
    ? await db.syncJob.findUniqueOrThrow({ where: { id: options.existingJobId } })
    : await db.syncJob.create({
        data: {
          integrationId: integration.id,
          status: "RUNNING",
          triggeredBy: options.triggeredBy ?? "system",
          startedAt: new Date(),
        },
      });

  const progress: SyncProgress = {
    jobId: syncJob.id,
    status: "RUNNING",
    itemsProcessed: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    errors: [],
  };
  let pendingIncrementalItemIdsForCompletion: string[] = [];
  let pendingIncrementalWindowEndedAtForCompletion: string | null = null;
  let analyticsSnapshot: EbayTradingRateLimitSnapshot | null = null;
  const seedUsage = (() => {
    const cfg = getIntegrationConfig(integration);
    const saved = cfg.syncState?.localApiUsage as LocalEbayApiUsage | undefined;
    const todayET = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    if (saved && saved.date === todayET) return saved;
    return null;
  })();
  const apiCalls: Record<MonitoredEbayMethod, number> = {
    GetItem: seedUsage?.GetItem ?? 0,
    GetSellerList: seedUsage?.GetSellerList ?? 0,
    GetSellerEvents: seedUsage?.GetSellerEvents ?? 0,
    ReviseFixedPriceItem: seedUsage?.ReviseFixedPriceItem ?? 0,
  };

  const syncStartedAt = Date.now();

  try {
    let effectiveMode = options.effectiveMode ?? options.requestedMode ?? "full";
    let completionCursor = new Date().toISOString();
    let fallbackReasonForCompletion = options.fallbackReason ?? null;
    const targetedPlatformItemIds = [
      ...new Set(
        (options.targetedPlatformItemIds ?? []).filter(
          (itemId): itemId is string => typeof itemId === "string" && itemId.trim().length > 0,
        ),
      ),
    ];
    analyticsSnapshot = await getEbayTradingRateLimitSnapshotForIntegration(
      integration,
    ).catch(() => null);

    if (effectiveMode === "incremental") {
      const integrationConfig = getIntegrationConfig(integration);
      const pendingWindow = getPendingIncrementalWindow(integrationConfig.syncState);
      if (targetedPlatformItemIds.length === 0 && !pendingWindow) {
        const getSellerEventsRate = getEbayMethodRate(
          analyticsSnapshot,
          "GetSellerEvents",
        );
        if (getSellerEventsRate?.status === "exhausted") {
          throw new EbayTradingApiError(
            buildEbayQuotaExhaustedMessage("GetSellerEvents", analyticsSnapshot),
            EBAY_USAGE_LIMIT_ERROR_CODE,
          );
        }
      }

      // Do NOT block incremental syncs just because GetItem is exhausted.
      // GetSellerEvents uses its own separate daily quota. The incremental sync
      // will still run GetSellerEvents to collect changed item IDs, then defer
      // all found items to the pending backlog for the next GetItem window.

      const lastCursorValue =
        integrationConfig.syncState.lastCursor ??
        integrationConfig.syncState.lastIncrementalSyncAt ??
        integrationConfig.syncState.lastFullSyncAt ??
        integration.lastSyncAt?.toISOString() ??
        null;
      if (targetedPlatformItemIds.length === 0 && !pendingWindow && lastCursorValue) {
        await db.syncJob.update({
          where: { id: syncJob.id },
          data: { errors: [{ sku: "_phase", message: "Collecting changed items via GetSellerEvents…" }] },
        }).catch(() => {});
      }

      const incrementalWindow =
        targetedPlatformItemIds.length > 0
          ? {
              itemIds: targetedPlatformItemIds,
              windowEndedAt: new Date(),
            }
          : pendingWindow ??
        (await fetchIncrementalItemIds(
          integration.id,
          ebayConfig,
          lastCursorValue,
          apiCalls,
        ));

      // Clear the phase indicator now that event collection is done
      await db.syncJob.update({
        where: { id: syncJob.id },
        data: { errors: [] },
      }).catch(() => {});

      if (!incrementalWindow) {
        progress.status = "COMPLETED";
        progress.errors.push({
          sku: "_global",
          message:
            "Incremental sync skipped — the last sync was more than 48 hours ago (eBay's GetSellerEvents limit). " +
            "Please run a Full Sync to re-baseline, then future incremental syncs will work automatically.",
        });
        await db.syncJob.update({
          where: { id: syncJob.id },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            itemsProcessed: 0,
            errors: JSON.parse(JSON.stringify(progress.errors)),
          },
        });
        return progress;
      } else {
        const budgetPlan = await buildEbayIncrementalBudgetPlan({
          integration,
          snapshot: analyticsSnapshot,
          timeZone: integrationConfig.syncProfile.timezone,
          window: {
            ...incrementalWindow,
            source:
              targetedPlatformItemIds.length > 0
                ? "fresh"
                : pendingWindow
                  ? "pending"
                  : "fresh",
          },
        });
        const processingItemIds =
          targetedPlatformItemIds.length > 0
            ? incrementalWindow.itemIds
            : budgetPlan.itemIdsToProcess;
        const incrementalEventItemsById =
          "eventItemsById" in incrementalWindow
            ? incrementalWindow.eventItemsById
            : undefined;
        pendingIncrementalItemIdsForCompletion =
          targetedPlatformItemIds.length > 0
            ? integrationConfig.syncState.pendingIncrementalItemIds
            : budgetPlan.pendingItemIds;
        pendingIncrementalWindowEndedAtForCompletion =
          targetedPlatformItemIds.length > 0
            ? integrationConfig.syncState.pendingIncrementalWindowEndedAt
            : budgetPlan.pendingItemIds.length > 0
              ? incrementalWindow.windowEndedAt.toISOString()
              : null;
        completionCursor =
          targetedPlatformItemIds.length > 0
            ? lastCursorValue ?? completionCursor
            : budgetPlan.pendingItemIds.length > 0
              ? lastCursorValue ?? completionCursor
              : incrementalWindow.windowEndedAt.toISOString();

        if (
          targetedPlatformItemIds.length === 0 &&
          budgetPlan.pendingItemIds.length > 0 &&
          budgetPlan.itemIdsToProcess.length > 0
        ) {
          fallbackReasonForCompletion =
            `Processed ${budgetPlan.itemIdsToProcess.length} changed eBay listings this run ` +
            `to stay within the shared API quota. ${budgetPlan.pendingItemIds.length} more ` +
            `will continue on the next scheduled pull.`;
        }

        if (
          targetedPlatformItemIds.length === 0 &&
          incrementalWindow.itemIds.length > 0 &&
          budgetPlan.itemIdsToProcess.length === 0
        ) {
          // GetItem quota exhausted — GetSellerEvents ran and collected
          // changed item IDs, but there is no budget to hydrate them now.
          // Save all found IDs to the pending backlog so the next sync
          // (after the daily quota resets) will process them via GetItem.
          pendingIncrementalItemIdsForCompletion = incrementalWindow.itemIds;
          pendingIncrementalWindowEndedAtForCompletion =
            incrementalWindow.windowEndedAt.toISOString();
          fallbackReasonForCompletion =
            `GetSellerEvents found ${incrementalWindow.itemIds.length} changed listing${incrementalWindow.itemIds.length !== 1 ? "s" : ""}. ` +
            `GetItem quota is exhausted — all changes are queued for the next pull window after the daily limit resets.`;
        }

        if (processingItemIds.length > 0) {
          await db.syncJob.update({
            where: { id: syncJob.id },
            data: { errors: [{ sku: "_phase", message: `Processing ${processingItemIds.length} changed listings via GetItem…` }] },
          }).catch(() => {});
        }

        let haltedIncrementalReason: string | null = null;

        for (
          let index = 0;
          index < processingItemIds.length;
          index += GETITEM_CONCURRENCY
        ) {
          if (Date.now() - syncStartedAt > SYNC_WALL_CLOCK_LIMIT_MS) {
            const remaining = processingItemIds.slice(index);
            pendingIncrementalItemIdsForCompletion = [
              ...remaining,
              ...pendingIncrementalItemIdsForCompletion,
            ];
            pendingIncrementalWindowEndedAtForCompletion =
              incrementalWindow.windowEndedAt.toISOString();
            completionCursor = lastCursorValue ?? completionCursor;
            haltedIncrementalReason =
              `Sync reached the ${Math.round(SYNC_WALL_CLOCK_LIMIT_MS / 1000)}s wall-clock limit. ` +
              `${progress.itemsProcessed} items processed; ${remaining.length} remaining will continue on the next run.`;
            progress.errors.push({ sku: "_global", message: haltedIncrementalReason });
            break;
          }

          const batch = processingItemIds.slice(
            index,
            index + GETITEM_CONCURRENCY,
          );
          const directResults = new Map<
            string,
            { itemsProcessed: number; itemsUpdated: number }
          >();
          const itemIdsNeedingFetch: string[] = [];
          for (const itemId of batch) {
            const directResult = await withTimeout(
              tryApplyIncrementalQuantityFirstTtItem(
                incrementalEventItemsById?.[itemId],
                integration.id,
              ),
              UPSERT_TIMEOUT_MS,
              `tryApplyIncremental(${itemId})`,
            ).catch(() => null);
            if (directResult) {
              directResults.set(itemId, directResult);
            } else {
              itemIdsNeedingFetch.push(itemId);
            }
          }
          const fullItems = await Promise.allSettled(
            itemIdsNeedingFetch.map((itemId) =>
              fetchFullItem(integration.id, ebayConfig, itemId),
            ),
          );
          apiCalls.GetItem += itemIdsNeedingFetch.length;
          let fetchResultIndex = 0;

          for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
            const itemId = batch[batchIndex];

            try {
              const directResult = directResults.get(itemId);
              if (directResult) {
                progress.itemsProcessed += directResult.itemsProcessed;
                progress.itemsUpdated += directResult.itemsUpdated;
                continue;
              }

              const fetched = fullItems[fetchResultIndex];
              fetchResultIndex += 1;
              if (!fetched) {
                throw new Error("Missing GetItem result for changed eBay listing.");
              }
              if (fetched.status === "rejected") {
                throw fetched.reason;
              }

              const fullItem = fetched.value;

              if (!fullItem) {
                progress.errors.push({
                  sku: itemId,
                  message: "GetItem returned no item payload for this changed listing.",
                });
                continue;
              }

              await withTimeout(
                applyTtItem(fullItem, integration.id, ebayConfig, progress),
                UPSERT_TIMEOUT_MS,
                `applyTtItem(${itemId})`,
              );
            } catch (error) {
              if (isEbayUsageLimitError(error)) {
                apiCalls.GetItem = 50_000;
                const remainingCurrentBatch = batch.slice(batchIndex);
                const remainingProcessingItemIds = processingItemIds.slice(
                  index + GETITEM_CONCURRENCY,
                );
                pendingIncrementalItemIdsForCompletion = [
                  ...remainingCurrentBatch,
                  ...remainingProcessingItemIds,
                  ...pendingIncrementalItemIdsForCompletion,
                ];
                pendingIncrementalWindowEndedAtForCompletion =
                  incrementalWindow.windowEndedAt.toISOString();
                completionCursor = lastCursorValue ?? completionCursor;
                haltedIncrementalReason =
                  "eBay GetItem usage limit was reached during this incremental refresh. " +
                  "Processed listings were saved, and the remaining changed listings will retry " +
                  "on the next run.";
                progress.errors.push({
                  sku: "_global",
                  message: haltedIncrementalReason,
                });
                break;
              }

              progress.errors.push({
                sku: itemId,
                message: error instanceof Error ? error.message : "Unknown error",
              });
            }
          }

          await updateSyncJobProgress(syncJob.id, progress);
          if (haltedIncrementalReason) {
            break;
          }
          if (index + GETITEM_CONCURRENCY < processingItemIds.length) {
            await sleep(GETITEM_BATCH_DELAY_MS);
          }
        }

        if (
          processingItemIds.length > 0 &&
          progress.itemsProcessed === 0 &&
          progress.errors.length > 0
        ) {
          throw new EbayTradingApiError(
            "GetItem usage limit was reached before any changed eBay listings could be refreshed.",
            EBAY_USAGE_LIMIT_ERROR_CODE,
          );
        }

        if (haltedIncrementalReason) {
          throw new EbayTradingApiError(
            haltedIncrementalReason,
            EBAY_USAGE_LIMIT_ERROR_CODE,
          );
        }
      }
    }

    if (effectiveMode === "full") {
      const getSellerListRate = getEbayMethodRate(
        analyticsSnapshot,
        "GetSellerList",
      );
      if (getSellerListRate?.status === "exhausted") {
        throw new EbayTradingApiError(
          buildEbayQuotaExhaustedMessage("GetSellerList", analyticsSnapshot),
          EBAY_USAGE_LIMIT_ERROR_CODE,
        );
      }

      await runFullSync(integration, ebayConfig, syncJob.id, progress, analyticsSnapshot, apiCalls);
      const stalePrune = await removeMarketplaceListingsOlderThan(
        integration.id,
        syncJob.startedAt ?? new Date(0),
      );
      if (stalePrune.deletedListings > 0 || stalePrune.deletedMasterRows > 0) {
        console.log(
          `[ebay-tt-sync] Pruned ${stalePrune.deletedListings} stale TT listings and ${stalePrune.deletedMasterRows} orphaned master rows after full sync`,
        );
      }
      await db.unmatchedListing.deleteMany({
        where: {
          integrationId: integration.id,
          OR: [
            { lastSyncedAt: null },
            { lastSyncedAt: { lt: syncJob.startedAt ?? new Date(0) } },
          ],
        },
      });
    }

    progress.status = "COMPLETED";
    const completedAt = new Date();

    await db.syncJob.update({
      where: { id: syncJob.id },
      data: {
        status: "COMPLETED",
        completedAt,
        itemsProcessed: progress.itemsProcessed,
        itemsCreated: progress.itemsCreated,
        itemsUpdated: progress.itemsUpdated,
        errors: JSON.parse(JSON.stringify(progress.errors)),
      },
    });

    await db.integration.update({
      where: { id: integration.id },
      data: {
        lastSyncAt: completedAt,
        config: await buildCompletedSyncConfigFromLatest(
          integration,
          { ...options, effectiveMode, fallbackReason: fallbackReasonForCompletion },
          completedAt,
          {
            cursor: completionCursor,
            pendingIncrementalItemIds: pendingIncrementalItemIdsForCompletion,
            pendingIncrementalWindowEndedAt: pendingIncrementalWindowEndedAtForCompletion,
          },
        ) as unknown as Prisma.InputJsonValue,
      },
    });

    try {
      await repairVariationFamiliesForIntegration(integration.id);

      if (effectiveMode === "full") {
        const adRatesUpdated = await fetchAndStorePromotedListingRates(
          integration.id,
          ebayConfig,
        );
        if (adRatesUpdated > 0) {
          console.log(`[ebay-tt-sync] Refreshed ${adRatesUpdated} promoted listing rates`);
        }
      }
    } catch (postSyncErr) {
      console.error("[ebay-tt-sync] Post-sync reconcile step failed", postSyncErr);
    }
  } catch (error) {
    progress.status = "FAILED";
    if (isEbayUsageLimitError(error)) {
      apiCalls.GetItem = 50_000;
      await recordRateLimitState(
        integration.id,
        error instanceof Error ? error.message : "eBay API usage limit reached.",
        pendingIncrementalItemIdsForCompletion,
        pendingIncrementalWindowEndedAtForCompletion,
        analyticsSnapshot?.nextResetAt,
      );
    }
    const allErrors = [
      ...progress.errors,
      {
        sku: "_global",
        message: error instanceof Error ? error.message : "Sync failed",
      },
    ];

    await db.syncJob.update({
      where: { id: syncJob.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errors: JSON.parse(JSON.stringify(allErrors)),
      },
    });
  } finally {
    try {
      const latest = await db.integration.findUnique({ where: { id: integration.id } });
      if (latest) {
        const cfg = getIntegrationConfig(latest);
        const updatedUsage = mergeSyncCallsIntoLocalUsage(
          cfg.syncState?.localApiUsage as LocalEbayApiUsage | undefined,
          apiCalls,
        );

        let liveSnapshotSerialized: unknown = undefined;
        if (ebayConfig.accessToken) {
          try {
            const liveSnapshot = await fetchRateLimitSnapshotWithToken(ebayConfig.accessToken);
            if (liveSnapshot && !liveSnapshot.isDegradedEstimate) {
              liveSnapshotSerialized = serializeSnapshotForConfig(liveSnapshot);
            }
          } catch {
            // Non-fatal — quota bars won't update this cycle
          }
        }

        const updatedConfig = mergeIntegrationConfig(latest.platform, latest.config, {
          syncState: {
            localApiUsage: updatedUsage,
            ...(liveSnapshotSerialized ? { lastRateLimitSnapshot: liveSnapshotSerialized } : {}),
          },
        });
        await db.integration.update({
          where: { id: integration.id },
          data: { config: updatedConfig as unknown as Prisma.InputJsonValue },
        });

        if (liveSnapshotSerialized) {
          try {
            const siblings = await db.integration.findMany({
              where: {
                platform: { in: ["TPP_EBAY", "TT_EBAY"] as Platform[] },
                id: { not: integration.id },
                enabled: true,
              },
              select: { id: true, platform: true, config: true },
            });
            for (const sib of siblings) {
              const sibMerged = mergeIntegrationConfig(sib.platform, sib.config, {
                syncState: { lastRateLimitSnapshot: liveSnapshotSerialized },
              });
              await db.integration.update({
                where: { id: sib.id },
                data: { config: sibMerged as unknown as Prisma.InputJsonValue },
              });
            }
          } catch {
            // Non-fatal — sibling quota bars won't update
          }
        }
      }
    } catch (analyticsErr) {
      console.error("[ebay-tt-sync] Post-sync analytics persist failed:", analyticsErr);
    }
  }

  return progress;
}

async function runFullSync(
  integration: Pick<Integration, "id" | "config" | "platform">,
  ebayConfig: EbayConfig,
  syncJobId: string,
  progress: SyncProgress,
  analyticsSnapshot: EbayTradingRateLimitSnapshot | null,
  apiCalls: Record<MonitoredEbayMethod, number>,
) {
  const integrationId = integration.id;
  const integrationConfig = getIntegrationConfig(integration);
  const upcHydrationDisabled = integrationConfig.syncProfile.skipUpcHydration;
  const sharedStoreCount = await getSharedEbayQuotaStoreCount(integration);
  const getItemRate = getEbayMethodRate(analyticsSnapshot, "GetItem");
  let hydrateBudget =
    getItemRate && getItemRate.limit > 0
      ? getPerRunEbayGetItemBudget({
          remaining: getItemRate.remaining,
          limit: getItemRate.limit,
          now: new Date(),
          timeZone: integrationConfig.syncProfile.timezone,
          sharedStoreCount,
        })
      : getFallbackPerRunEbayGetItemBudget(
          new Date(),
          integrationConfig.syncProfile.timezone,
        );
  let hydrateCallsUsed = 0;
  let skipHydrateDueToLimit = false;
  let hydrateNoticePushed = false;

  let page = 1;
  const perPage = 100;
  let hasMore = true;

  while (hasMore) {
    const endTimeTo = new Date();
    endTimeTo.setDate(endTimeTo.getDate() + 120);
    const endTimeFrom = new Date();

    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <EndTimeFrom>${endTimeFrom.toISOString()}</EndTimeFrom>
  <EndTimeTo>${endTimeTo.toISOString()}</EndTimeTo>
  <IncludeVariations>true</IncludeVariations>
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination>
    <EntriesPerPage>${perPage}</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
</GetSellerListRequest>`;
    let forceRefresh = false;
    let retryAttempt = 0;
    let resp: Record<string, unknown> | null = null;

    while (!resp) {
      const accessToken = await getAccessToken(integrationId, ebayConfig, forceRefresh);
      const response = await fetchWithTimeout(TRADING_API, {
        method: "POST",
        headers: {
          "X-EBAY-API-IAF-TOKEN": accessToken,
          "X-EBAY-API-SITEID": SITE_ID,
          "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
          "X-EBAY-API-CALL-NAME": "GetSellerList",
          "Content-Type": "text/xml",
        },
        body,
      });

      const xml = response.body;
      if (!response.ok) {
        throw new Error(`GetSellerList HTTP ${response.status}: ${xml.slice(0, 500)}`);
      }

      const parsed = parser.parse(xml);
      const nextResponse = parsed?.GetSellerListResponse;
      if (!nextResponse) {
        throw new Error(
          `Missing GetSellerListResponse. Keys: ${Object.keys(parsed ?? {}).join(", ")}`,
        );
      }

      const ack = str(nextResponse, "Ack");
      const errors = normalizeTradingErrors(nextResponse.Errors);
      const errorCode = errors
        .map((entry) => str(entry, "ErrorCode"))
        .find(Boolean);
      const errorMessage = errors
        .map((entry) => str(entry, "LongMessage") ?? str(entry, "ShortMessage"))
        .find(Boolean);

      if (ack === "Failure") {
        if (errorCode === EBAY_INVALID_TOKEN_ERROR_CODE && !forceRefresh) {
          clearAccessTokenCache(ebayConfig);
          forceRefresh = true;
          continue;
        }

        if (
          errorCode === EBAY_USAGE_LIMIT_ERROR_CODE &&
          retryAttempt < GET_SELLER_EVENTS_RETRY_DELAYS_MS.length
        ) {
          const delayMs = GET_SELLER_EVENTS_RETRY_DELAYS_MS[retryAttempt];
          retryAttempt += 1;
          await sleep(delayMs);
          continue;
        }

        throw new EbayTradingApiError(
          `eBay API: ${errorMessage || "Unknown error"}`,
          errorCode,
        );
      }

      resp = nextResponse as Record<string, unknown>;
      apiCalls.GetSellerList++;
    }

    const items = arr(obj(resp, "ItemArray"), "Item");
    const totalPages = parseInt(
      str(obj(resp, "PaginationResult"), "TotalNumberOfPages") ?? "1",
      10,
    );
    hasMore = page < totalPages;
    page++;

    for (const item of items) {
      try {
        const itemId = str(item, "ItemID");
        let itemForApply = item;

        const varNode = obj(item, "Variations");
        const hasVariationsWithoutPictures =
          varNode && arr(varNode, "Variation").length > 0 && !obj(varNode, "Pictures");
        const needsUpcHydration = !upcHydrationDisabled && needsFullItemForUpc(item);
        if (itemId && (needsUpcHydration || hasVariationsWithoutPictures) && !skipHydrateDueToLimit) {
          if (hydrateCallsUsed >= hydrateBudget) {
            if (!hydrateNoticePushed) {
              hydrateNoticePushed = true;
              progress.errors.push({
                sku: "_global",
                message:
                  `UPC hydration paused for the rest of this run after ${hydrateBudget} GetItem calls (daily quota pacing). ` +
                  `Listings still save from GetSellerList; run another sync later to backfill UPCs.`,
              });
            }
          } else {
            try {
              itemForApply =
                (await fetchFullItem(integrationId, ebayConfig, itemId)) ?? item;
              hydrateCallsUsed += 1;
              apiCalls.GetItem++;
            } catch (error) {
              if (isEbayUsageLimitError(error)) {
                skipHydrateDueToLimit = true;
                apiCalls.GetItem = 50_000;
                await recordRateLimitState(
                  integrationId,
                  error instanceof Error ? error.message : "eBay GetItem usage limit reached.",
                  [],
                  null,
                  analyticsSnapshot?.nextResetAt,
                );
                if (!hydrateNoticePushed) {
                  hydrateNoticePushed = true;
                  progress.errors.push({
                    sku: "_global",
                    message:
                      "eBay blocked further GetItem calls (daily usage limit). Listings were saved from GetSellerList. " +
                      "Wait for the cooldown on Sync, then run another pull to continue UPC hydration.",
                  });
                }
              } else {
                progress.errors.push({
                  sku: itemId,
                  message:
                    error instanceof Error
                      ? `GetItem UPC hydrate failed: ${error.message}`
                      : "GetItem UPC hydrate failed.",
                });
              }
            }
          }
        }

        await withTimeout(
          applyTtItem(itemForApply, integrationId, ebayConfig, progress),
          UPSERT_TIMEOUT_MS,
          `applyTtItem(${str(item, "ItemID") ?? "unknown"})`,
        );
      } catch (error) {
        progress.errors.push({
          sku: str(item, "ItemID") ?? "_item",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    await updateSyncJobProgress(syncJobId, progress);

    if (hasMore) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function applyTtItem(
  item: unknown,
  integrationId: string,
  config: EbayConfig,
  progress: SyncProgress,
) {
  const itemId = str(item, "ItemID");
  if (itemId && !matchesConfiguredSeller(item, config)) {
    await removeForeignSellerListings(integrationId, itemId);
    progress.errors.push({
      sku: itemId,
      message: `Skipped foreign-seller eBay item ${itemId}. It does not belong to ${config.accountUserId ?? "the connected seller"}.`,
    });
    return;
  }

  const listings = extractListingsFromItem(item);
  if (listings.length === 0) {
    return;
  }

  const matchResult = await matchListings(listings, integrationId, false);
  const upserted = await upsertMarketplaceListings(matchResult.matched, integrationId);
  const unmatchedItemIds = await saveGroupedUnmatchedListings(
    matchResult.unmatched,
    integrationId,
  );

  const processedItemIds = [...new Set(listings.map((listing) => listing.platformItemId))];
  const resolvedItemIds = processedItemIds.filter(
    (itemId) => !unmatchedItemIds.has(itemId),
  );

  if (resolvedItemIds.length > 0) {
    await db.unmatchedListing.deleteMany({
      where: {
        integrationId,
        platformItemId: { in: resolvedItemIds },
      },
    });
  }

  progress.itemsProcessed += listings.length;
  progress.itemsCreated += upserted.created;
  progress.itemsUpdated += upserted.updated;
}

async function tryApplyIncrementalQuantityFirstTtItem(
  item: unknown,
  integrationId: string,
): Promise<{ itemsProcessed: number; itemsUpdated: number } | null> {
  if (!item || typeof item !== "object") {
    return null;
  }

  const itemId = str(item, "ItemID");
  if (!itemId) {
    return null;
  }

  // If the incremental event payload does not carry the UPC details, force the
  // slower GetItem path so the dashboard stays truthful after direct eBay edits.
  if (needsFullItemForUpc(item)) {
    return null;
  }

  const title = str(item, "Title");
  const now = new Date();
  const sellingStatus = obj(item, "SellingStatus");
  const variationsNode = obj(item, "Variations");
  const variationList = variationsNode ? arr(variationsNode, "Variation") : [];

  if (variationList.length === 0) {
    const existingListing = await db.marketplaceListing.findFirst({
      where: { integrationId, platformItemId: itemId, platformVariantId: null },
      select: { id: true },
    });
    if (!existingListing) {
      return null;
    }

    const quantity =
      num(item, "Quantity") ??
      (sellingStatus ? num(sellingStatus, "Quantity") : undefined) ??
      0;
    const quantitySold = sellingStatus ? num(sellingStatus, "QuantitySold") ?? 0 : 0;
    const available = Math.max(0, quantity - quantitySold);
    const salePrice =
      num(item, "StartPrice") ??
      (sellingStatus ? num(sellingStatus, "CurrentPrice") : undefined);

    const data: Prisma.MarketplaceListingUpdateInput = {
      inventory: available,
      status: available > 0 ? "ACTIVE" : "OUT_OF_STOCK",
      lastSyncedAt: now,
      rawData: JSON.parse(JSON.stringify(item)) as Prisma.InputJsonValue,
    };
    if (salePrice !== undefined) {
      data.salePrice = salePrice;
    }
    if (title) {
      data.title = title;
    }

    await db.marketplaceListing.update({
      where: { id: existingListing.id },
      data,
    });

    return { itemsProcessed: 1, itemsUpdated: 1 };
  }

  const existingChildren = await db.marketplaceListing.findMany({
    where: {
      integrationId,
      platformItemId: itemId,
      NOT: { platformVariantId: null },
    },
    select: { id: true, platformVariantId: true },
  });
  if (existingChildren.length !== variationList.length) {
    return null;
  }

  const childrenByVariantId = new Map(
    existingChildren
      .filter(
        (
          listing,
        ): listing is { id: string; platformVariantId: string } =>
          typeof listing.platformVariantId === "string" &&
          listing.platformVariantId.trim().length > 0,
      )
      .map((listing) => [listing.platformVariantId, listing]),
  );
  if (childrenByVariantId.size !== variationList.length) {
    return null;
  }

  const updates: Array<{ id: string; data: Prisma.MarketplaceListingUpdateInput }> =
    [];
  for (let index = 0; index < variationList.length; index += 1) {
    const variation = variationList[index];
    const variantId = str(variation, "SKU")?.trim() || `variation-${index + 1}`;
    const existingChild = childrenByVariantId.get(variantId);
    if (!existingChild) {
      return null;
    }

    const variationSellingStatus = obj(variation, "SellingStatus");
    const quantity =
      num(variation, "Quantity") ??
      (variationSellingStatus ? num(variationSellingStatus, "Quantity") : undefined) ??
      0;
    const quantitySold = variationSellingStatus
      ? num(variationSellingStatus, "QuantitySold") ?? 0
      : 0;
    const available = Math.max(0, quantity - quantitySold);
    const salePrice =
      num(variation, "StartPrice") ??
      (variationSellingStatus ? num(variationSellingStatus, "CurrentPrice") : undefined) ??
      (sellingStatus ? num(sellingStatus, "CurrentPrice") : undefined);

    const data: Prisma.MarketplaceListingUpdateInput = {
      inventory: available,
      status: available > 0 ? "ACTIVE" : "OUT_OF_STOCK",
      lastSyncedAt: now,
      rawData: JSON.parse(
        JSON.stringify({
          item,
          variation,
          parentItemId: itemId,
        }),
      ) as Prisma.InputJsonValue,
    };
    if (salePrice !== undefined) {
      data.salePrice = salePrice;
    }
    if (title) {
      data.title = title;
    }

    updates.push({ id: existingChild.id, data });
  }

  await db.$transaction(
    updates.map((update) =>
      db.marketplaceListing.update({
        where: { id: update.id },
        data: update.data,
      }),
    ),
  );

  return {
    itemsProcessed: variationList.length,
    itemsUpdated: variationList.length,
  };
}

function extractListingsFromItem(item: unknown): RawListing[] {
  const itemId = str(item, "ItemID");
  if (!itemId) {
    return [];
  }

  const title = str(item, "Title") ?? "";
  const imageUrl = extractImageUrl(item) ?? undefined;
  const sellingStatus = obj(item, "SellingStatus");
  const currentPrice = sellingStatus ? num(sellingStatus, "CurrentPrice") : undefined;
  const startPriceRoot = num(item, "StartPrice");
  const resolvedSingleSalePrice = startPriceRoot ?? currentPrice;
  const quantity =
    num(item, "Quantity") ??
    (sellingStatus ? num(sellingStatus, "Quantity") : undefined) ??
    0;
  const quantitySold = sellingStatus ? num(sellingStatus, "QuantitySold") ?? 0 : 0;
  const available = Math.max(0, quantity - quantitySold);
  const itemSku = str(item, "SKU")?.trim() ?? "";
  const variationsNode = obj(item, "Variations");
  const variationList = variationsNode ? arr(variationsNode, "Variation") : [];
  const variationPictures = variationsNode ? obj(variationsNode, "Pictures") : undefined;

  if (variationList.length === 0) {
    return [
      {
        platformItemId: itemId,
        sku: itemSku,
        title,
        imageUrl,
        salePrice: resolvedSingleSalePrice,
        inventory: available,
        status: available > 0 ? "active" : "out_of_stock",
        isVariation: false,
        upc: extractUpc(item) ?? undefined,
        rawData: JSON.parse(JSON.stringify(item)),
      },
    ];
  }

  const listings = variationList.map((variation, index) => {
    const sku = str(variation, "SKU")?.trim() ?? "";
    const variationSellingStatus = obj(variation, "SellingStatus");
    const variationQuantity = num(variation, "Quantity") ?? 0;
    const variationSold = variationSellingStatus
      ? num(variationSellingStatus, "QuantitySold") ?? 0
      : 0;
    const variationAvailable = Math.max(0, variationQuantity - variationSold);

    return {
      platformItemId: itemId,
      platformVariantId: sku || `variation-${index + 1}`,
      parentPlatformItemId: itemId,
      sku,
      title,
      imageUrl:
        extractVariationImageUrl(variation, variationPictures) ??
        undefined,
      salePrice:
        num(variation, "StartPrice") ??
        num(variationSellingStatus, "CurrentPrice") ??
        currentPrice,
      inventory: variationAvailable,
      status: variationAvailable > 0 ? ("active" as const) : ("out_of_stock" as const),
      isVariation: true,
      upc: extractVariationUpc(variation) ?? undefined,
      rawData: JSON.parse(
        JSON.stringify({
          item,
          variation,
          parentItemId: itemId,
        }),
      ) as Record<string, unknown>,
    } satisfies RawListing;
  });

  return listings;
}

async function saveGroupedUnmatchedListings(
  unmatched: RawListing[],
  integrationId: string,
): Promise<Set<string>> {
  const grouped = new Map<string, RawListing[]>();
  for (const listing of unmatched) {
    const existing = grouped.get(listing.platformItemId) ?? [];
    existing.push(listing);
    grouped.set(listing.platformItemId, existing);
  }

  for (const [platformItemId, listings] of grouped) {
    const first = listings[0];
    const rawData =
      listings.length === 1
        ? JSON.parse(JSON.stringify(first.rawData ?? {}))
        : JSON.parse(
            JSON.stringify({
              parentItemId: platformItemId,
              title: first.title,
              variations: listings.map((listing) => ({
                platformVariantId: listing.platformVariantId ?? null,
                sku: listing.sku || null,
                inventory: listing.inventory ?? null,
                status: listing.status,
                rawData: listing.rawData ?? {},
              })),
            }),
          );

    await db.unmatchedListing.upsert({
      where: {
        integrationId_platformItemId: {
          integrationId,
          platformItemId,
        },
      },
      create: {
        integrationId,
        platformItemId,
        sku: first.sku || null,
        title: first.title || null,
        rawData,
        lastSyncedAt: new Date(),
      },
      update: {
        sku: first.sku || null,
        title: first.title || null,
        rawData,
        lastSyncedAt: new Date(),
      },
    });
  }

  return new Set(grouped.keys());
}

async function updateSyncJobProgress(syncJobId: string, progress: SyncProgress) {
  await db.syncJob.update({
    where: { id: syncJobId },
    data: {
      itemsProcessed: progress.itemsProcessed,
      itemsCreated: progress.itemsCreated,
      itemsUpdated: progress.itemsUpdated,
      errors: JSON.parse(JSON.stringify(progress.errors)),
    },
  });
}

async function getAccessToken(
  integrationId: string,
  config: EbayConfig,
  forceRefresh = false,
): Promise<string> {
  if (
    !forceRefresh &&
    config.accessToken &&
    config.accessTokenExpiresAt &&
    config.accessTokenExpiresAt > Date.now() + 60_000
  ) {
    return config.accessToken;
  }

  const credentials = Buffer.from(`${config.appId}:${config.certId}`).toString("base64");
  const tokenResponse = await fetchWithTimeout("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`eBay token refresh failed: ${tokenResponse.status} ${tokenResponse.body}`);
  }

  const data = JSON.parse(tokenResponse.body);
  const accessToken = data.access_token;
  const expiresIn = data.expires_in ?? 7200;
  const refreshExpiresIn =
    data.refresh_token_expires_in ?? 18 * 30 * 24 * 60 * 60;
  const expiresAt = Date.now() + expiresIn * 1000;

  const current = await db.integration.findUnique({
    where: { id: integrationId },
    select: { config: true },
  });
  const fullConfig =
    current?.config && typeof current.config === "object" && !Array.isArray(current.config)
      ? (current.config as Record<string, unknown>)
      : {};

  await db.integration.update({
    where: { id: integrationId },
    data: {
      config: {
        ...fullConfig,
        appId: config.appId,
        certId: config.certId,
        refreshToken: config.refreshToken,
        accessToken,
        accessTokenExpiresAt: expiresAt,
        refreshTokenExpiresAt: Date.now() + refreshExpiresIn * 1000,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  config.accessToken = accessToken;
  config.accessTokenExpiresAt = expiresAt;
  return accessToken;
}

async function fetchIncrementalItemIds(
  integrationId: string,
  config: EbayConfig,
  lastCursor: string | null,
  apiCalls?: Record<string, number>,
): Promise<IncrementalWindow | null> {
  if (!lastCursor) return null;

  const cursorDate = new Date(lastCursor);
  if (Number.isNaN(cursorDate.getTime())) return null;
  // eBay GetSellerEvents enforces a max ~48-hour window between ModTimeFrom
  // and ModTimeTo.  Exceeding this causes hangs or incomplete pagination.
  if (Date.now() - cursorDate.getTime() > 48 * 60 * 60 * 1000) {
    return null;
  }

  const windowEndedAt = new Date();
  const windowStartedAt = new Date(cursorDate.getTime() - 2 * 60 * 1000);
  const itemIds = new Set<string>();
  const eventItemsById: Record<string, unknown> = {};
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetSellerEventsRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ModTimeFrom>${windowStartedAt.toISOString()}</ModTimeFrom>
  <ModTimeTo>${windowEndedAt.toISOString()}</ModTimeTo>
  <Pagination>
    <EntriesPerPage>200</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
</GetSellerEventsRequest>`;
    let forceRefresh = false;
    let retryAttempt = 0;
    let resp: Record<string, unknown> | null = null;

    while (!resp) {
      const accessToken = await getAccessToken(integrationId, config, forceRefresh);
      const response = await fetchWithTimeout(TRADING_API, {
        method: "POST",
        headers: {
          "X-EBAY-API-IAF-TOKEN": accessToken,
          "X-EBAY-API-SITEID": SITE_ID,
          "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
          "X-EBAY-API-CALL-NAME": "GetSellerEvents",
          "Content-Type": "text/xml",
        },
        body,
      });

      const xml = response.body;
      if (!response.ok) {
        throw new Error(`GetSellerEvents HTTP ${response.status}: ${xml.slice(0, 500)}`);
      }

      const parsed = parser.parse(xml);
      const nextResponse = parsed?.GetSellerEventsResponse;
      if (!nextResponse) {
        throw new Error(
          `Missing GetSellerEventsResponse. Keys: ${Object.keys(parsed ?? {}).join(", ")}`,
        );
      }

      const ack = str(nextResponse, "Ack");
      const errors = normalizeTradingErrors(nextResponse.Errors);
      const errorCode = errors
        .map((entry) => str(entry, "ErrorCode"))
        .find(Boolean);
      const errorMessage = errors
        .map((entry) => str(entry, "LongMessage") ?? str(entry, "ShortMessage"))
        .find(Boolean);

      if (ack === "Failure") {
        if (errorCode === EBAY_INVALID_TOKEN_ERROR_CODE && !forceRefresh) {
          clearAccessTokenCache(config);
          forceRefresh = true;
          continue;
        }

        if (
          errorCode === EBAY_USAGE_LIMIT_ERROR_CODE &&
          retryAttempt < GET_SELLER_EVENTS_RETRY_DELAYS_MS.length
        ) {
          const delayMs = GET_SELLER_EVENTS_RETRY_DELAYS_MS[retryAttempt];
          retryAttempt += 1;
          await sleep(delayMs);
          continue;
        }

        throw new EbayTradingApiError(
          `GetSellerEvents failed: ${errorMessage || "Unknown error"}`,
          errorCode,
        );
      }

      resp = nextResponse as Record<string, unknown>;
      if (apiCalls) apiCalls.GetSellerEvents = (apiCalls.GetSellerEvents ?? 0) + 1;
    }

    const items = arr(obj(resp, "ItemArray"), "Item");
    for (const item of items) {
      const itemId = str(item, "ItemID");
      if (itemId) {
        itemIds.add(itemId);
        eventItemsById[itemId] = item;
      }
    }

    const totalPages = parseInt(
      str(obj(resp, "PaginationResult"), "TotalNumberOfPages") ?? "1",
      10,
    );
    hasMore = page < totalPages;
    page++;
  }

  return { itemIds: [...itemIds], windowEndedAt, eventItemsById };
}

async function fetchFullItem(
  integrationId: string,
  config: EbayConfig,
  itemId: string,
): Promise<unknown | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`;
  let forceRefresh = false;
  let retryAttempt = 0;

  while (true) {
    const accessToken = await getAccessToken(integrationId, config, forceRefresh);
    const response = await fetchWithTimeout(TRADING_API, {
      method: "POST",
      headers: {
        "X-EBAY-API-IAF-TOKEN": accessToken,
        "X-EBAY-API-SITEID": SITE_ID,
        "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
        "X-EBAY-API-CALL-NAME": "GetItem",
        "Content-Type": "text/xml",
      },
      body,
    });

    const xml = response.body;
    if (!response.ok) {
      throw new Error(`GetItem failed for ${itemId}: ${response.status} ${xml.slice(0, 300)}`);
    }

    const parsed = parser.parse(xml);
    const getItemResponse = parsed?.GetItemResponse;
    const ack = str(getItemResponse, "Ack");
    const errors = normalizeTradingErrors(getItemResponse?.Errors);
    const errorCode = errors
      .map((entry) => str(entry, "ErrorCode"))
      .find(Boolean);
    const errorMessage =
      errors
        .map((entry) => str(entry, "LongMessage") ?? str(entry, "ShortMessage"))
        .find(Boolean) ??
      `GetItem returned no item payload for ${itemId}.`;

    if (errorCode === EBAY_INVALID_TOKEN_ERROR_CODE && !forceRefresh) {
      clearAccessTokenCache(config);
      forceRefresh = true;
      continue;
    }

    if (
      errorCode === EBAY_USAGE_LIMIT_ERROR_CODE &&
      retryAttempt < GET_ITEM_RETRY_DELAYS_MS.length
    ) {
      const delayMs = GET_ITEM_RETRY_DELAYS_MS[retryAttempt];
      retryAttempt += 1;
      await sleep(delayMs);
      continue;
    }

    if (ack === "Failure" || (ack === "Warning" && !getItemResponse?.Item)) {
      throw new EbayTradingApiError(
        `GetItem failed for ${itemId}: ${errorMessage}`,
        errorCode,
      );
    }

    const itemRaw = getItemResponse?.Item;
    const item = Array.isArray(itemRaw) ? itemRaw[0] : itemRaw;
    if (!item) {
      throw new EbayTradingApiError(
        `GetItem failed for ${itemId}: GetItem returned no item payload for this changed listing.`,
      );
    }

    return item;
  }
}

function isEbayUsageLimitError(error: unknown) {
  if (error instanceof EbayTradingApiError && error.code === EBAY_USAGE_LIMIT_ERROR_CODE) {
    return true;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  return message.toLowerCase().includes("usage limit");
}

async function fetchAndStorePromotedListingRates(
  integrationId: string,
  config: EbayConfig,
): Promise<number> {
  const accessToken = await getAccessToken(integrationId, config);
  const campaignResponse = await fetchWithTimeout(
    `${MARKETING_API_BASE}/ad_campaign?funding_strategy=COST_PER_SALE&limit=100`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!campaignResponse.ok) {
    return 0;
  }

  const campaignData = JSON.parse(campaignResponse.body) as {
    campaigns?: MarketingCampaign[];
  };
  const campaigns = campaignData.campaigns ?? [];
  const cpsCampaigns = campaigns.filter(
    (campaign) =>
      campaign.campaignId &&
      campaign.fundingStrategy?.fundingModel === "COST_PER_SALE" &&
      (campaign.campaignStatus === "RUNNING" ||
        campaign.campaignStatus === "SCHEDULED"),
  );

  const listingIdToBidPct = new Map<string, number>();
  for (const campaign of cpsCampaigns) {
    const campaignId = campaign.campaignId!;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const adsUrl = `${MARKETING_API_BASE}/ad_campaign/${campaignId}/ad?limit=${ADS_PAGE_SIZE}&offset=${offset}`;
      const adsResponse = await fetchWithTimeout(adsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!adsResponse.ok) {
        break;
      }

      const adsData = JSON.parse(adsResponse.body) as {
        ads?: MarketingAd[];
        total?: number;
      };
      const ads = adsData.ads ?? [];

      for (const ad of ads) {
        if (ad.listingId && ad.bidPercentage != null && ad.bidPercentage !== "") {
          const pct = parseFloat(ad.bidPercentage);
          if (!Number.isNaN(pct) && pct >= 0 && pct <= 100) {
            listingIdToBidPct.set(ad.listingId, pct / 100);
          }
        }
      }

      offset += ads.length;
      hasMore =
        ads.length === ADS_PAGE_SIZE &&
        (adsData.total == null || offset < adsData.total);
    }
  }

  let updated = 0;
  for (const [platformItemId, adRate] of listingIdToBidPct) {
    const result = await db.marketplaceListing.updateMany({
      where: { integrationId, platformItemId },
      data: { adRate },
    });
    updated += result.count;
  }

  return updated;
}

function str(value: unknown, key: string): string | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>)[key];
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const first = raw[0];
    return first != null ? String(first) : undefined;
  }
  if (typeof raw === "object") {
    const text = (raw as Record<string, unknown>)["#text"];
    return text != null ? String(text) : undefined;
  }
  return String(raw);
}

function num(value: unknown, key: string): number | undefined {
  const raw = str(value, key);
  if (raw == null) return undefined;
  const cleaned = raw.replace(/[^0-9.\-]/g, "");
  const parsed = parseFloat(cleaned);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function obj(
  parent: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (parent == null || typeof parent !== "object") return undefined;
  const raw = (parent as Record<string, unknown>)[key];
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return raw as Record<string, unknown>;
}

function arr(parent: unknown, key: string): unknown[] {
  if (parent == null || typeof parent !== "object") return [];
  const raw = (parent as Record<string, unknown>)[key];
  if (Array.isArray(raw)) return raw;
  // Treat any non-null scalar (string, number) or object as a single-element
  // array. This is necessary because fast-xml-parser returns a bare string
  // when there is only one child element (e.g. a single PictureURL), and we
  // must not lose that value.
  if (raw != null) return [raw];
  return [];
}

function extractImageUrl(item: unknown): string | null {
  const pictureDetails = obj(item, "PictureDetails");
  if (!pictureDetails) return null;

  const urls = arr(pictureDetails, "PictureURL");
  for (const url of urls) {
    if (typeof url === "string" && url.startsWith("http")) {
      return url;
    }
  }

  return str(pictureDetails, "GalleryURL") ?? null;
}

function extractUpc(item: unknown): string | null {
  const listingDetails = obj(item, "ProductListingDetails");
  if (listingDetails) {
    for (const key of ["UPC", "EAN"]) {
      const value = str(listingDetails, key);
      if (value && value !== "Does not apply" && value !== "N/A" && value.length > 3) {
        return value;
      }
    }
  }

  const specifics = obj(item, "ItemSpecifics");
  if (!specifics) return null;

  for (const nameValue of arr(specifics, "NameValueList")) {
    const name = str(nameValue, "Name");
    if (name === "UPC" || name === "EAN" || name === "GTIN") {
      const value = str(nameValue, "Value");
      if (value && value !== "Does not apply" && value !== "N/A" && value.length > 3) {
        return value;
      }
    }
  }

  return null;
}

function extractVariationUpc(variation: unknown): string | null {
  const listingDetails = obj(variation, "VariationProductListingDetails");
  if (!listingDetails) return null;

  for (const key of ["UPC", "EAN", "ISBN"]) {
    const value = str(listingDetails, key);
    if (value && value !== "Does not apply" && value !== "N/A" && value.length > 3) {
      return value;
    }
  }

  return null;
}

function extractVariationImageUrl(
  variation: unknown,
  variationPictures: unknown,
): string | null {
  const specifics = obj(variation, "VariationSpecifics");
  if (specifics && variationPictures) {
    const pictureSets = arr(variationPictures, "VariationSpecificPictureSet");
    const pictureDimension = str(variationPictures, "VariationSpecificName")?.trim().toLowerCase();
    const nameValueList = arr(specifics, "NameValueList");

    for (const nameValue of nameValueList) {
      const name = str(nameValue, "Name")?.trim().toLowerCase();
      if (pictureDimension && name && name !== pictureDimension) continue;

      const rawValue = (nameValue as Record<string, unknown>)?.Value;
      const values: string[] = [];
      if (Array.isArray(rawValue)) {
        for (const v of rawValue) if (v != null) values.push(String(v).trim().toLowerCase());
      } else if (rawValue != null) {
        values.push(String(rawValue).trim().toLowerCase());
      }
      if (values.length === 0) continue;

      for (const pictureSet of pictureSets) {
        const pictureValue = str(pictureSet, "VariationSpecificValue")?.trim().toLowerCase();
        if (!pictureValue || !values.includes(pictureValue)) continue;
        const urls = arr(pictureSet, "PictureURL");
        for (const url of urls) {
          if (typeof url === "string" && url.startsWith("http")) {
            return url;
          }
        }
      }
    }
  }

  return null;
}

function needsFullItemForUpc(item: unknown): boolean {
  const variationsNode = obj(item, "Variations");
  const variationList = variationsNode ? arr(variationsNode, "Variation") : [];

  if (variationList.length === 0) {
    return !extractUpc(item);
  }

  return variationList.some((variation) => !extractVariationUpc(variation));
}

/**
 * Lightweight single-item refresh — calls GetItem directly and upserts.
 * Bypasses the full sync pipeline (no sync job, no cursor, no quota bookkeeping).
 * Designed for the row-refresh button on the dashboard.
 */
export async function refreshEbayTtItemsDirect(
  integration: { id: string; platform: string; config: Record<string, unknown> },
  itemIds: string[],
): Promise<{ updated: number; errors: string[] }> {
  const config = integration.config;
  const appId = config.appId as string;
  const certId = config.certId as string;
  const refreshToken = config.refreshToken as string;
  if (!appId || !certId || !refreshToken) {
    return { updated: 0, errors: ["eBay credentials missing from integration config"] };
  }

  const ebayConfig: EbayConfig = {
    appId,
    certId,
    refreshToken,
    accessToken: config.accessToken as string | undefined,
    accountUserId:
      typeof config.accountUserId === "string" ? config.accountUserId : null,
    accessTokenExpiresAt: config.accessTokenExpiresAt as number | undefined,
  };

  const dummyProgress: SyncProgress = {
    jobId: "",
    status: "RUNNING",
    itemsProcessed: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    errors: [],
  };

  const errors: string[] = [];
  let updated = 0;
  const unique = [...new Set(itemIds)];

  for (const itemId of unique) {
    try {
      const item = await fetchFullItem(integration.id, ebayConfig, itemId);
      if (!item) {
        errors.push(`${itemId}: GetItem returned no data`);
        continue;
      }
      await applyTtItem(item, integration.id, ebayConfig, dummyProgress);
      updated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("usage limit") || msg.includes("518")) {
        errors.push(`Daily API limit reached`);
        break;
      }
      errors.push(`${itemId}: ${msg.slice(0, 120)}`);
    }
  }

  return { updated, errors };
}
