import { db } from "@/lib/db";
import { Platform, Prisma, type Integration, type SyncStatus } from "@prisma/client";
import { XMLParser } from "fast-xml-parser";
import {
  buildCompletedSyncConfigFromLatest,
  type SyncExecutionOptions,
} from "@/lib/services/sync-control";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";
import {
  buildEbayQuotaExhaustedMessage,
  getEbayMethodRate,
  getEbayTradingRateLimitSnapshotForIntegration,
  type EbayTradingRateLimitSnapshot,
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
import { removeMarketplaceListingsOlderThan } from "@/lib/services/listing-prune";
import { repairVariationFamiliesForIntegration } from "@/lib/services/variation-repair";
import { propagateEbayRateLimitToAllSharedIntegrations } from "@/lib/services/ebay-rate-limit";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const GETITEM_CONCURRENCY = 3;
const GETITEM_BATCH_DELAY_MS = 250;
const EBAY_USAGE_LIMIT_ERROR_CODE = "518";
const EBAY_INVALID_TOKEN_ERROR_CODE = "21916984";
const GET_SELLER_EVENTS_RETRY_DELAYS_MS = [3_000, 8_000];
const GET_ITEM_RETRY_DELAYS_MS = [1_000, 3_000];
const MARKETING_API_BASE = "https://api.ebay.com/sell/marketing/v1";
const ADS_PAGE_SIZE = 500;
const REQUEST_TIMEOUT_MS = 30_000;

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
  variationsFound: number;
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

type UpsertResult = "created" | "updated" | "variation_parent" | "deleted";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
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
  const listings = await db.marketplaceListing.findMany({
    where: { integrationId },
    select: {
      id: true,
      platformItemId: true,
      rawData: true,
    },
  });

  const foreignItemIds = [
    ...new Set(
      listings
        .filter((listing) => {
          const rawData =
            listing.rawData && typeof listing.rawData === "object"
              ? (listing.rawData as Record<string, unknown>)
              : null;
          const item = rawData?.item ?? rawData;
          return item && !matchesConfiguredSeller(item, config);
        })
        .map((listing) => listing.platformItemId)
        .filter((itemId): itemId is string => Boolean(itemId)),
    ),
  ];

  if (foreignItemIds.length === 0) {
    return;
  }

  await Promise.all([
    db.marketplaceListing.deleteMany({
      where: {
        integrationId,
        platformItemId: { in: foreignItemIds },
      },
    }),
    db.unmatchedListing.deleteMany({
      where: {
        integrationId,
        platformItemId: { in: foreignItemIds },
      },
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

export async function runEbayTppSync(
  options: SyncExecutionOptions = {},
): Promise<SyncProgress> {
  const integration = await db.integration.findUnique({
    where: { platform: Platform.TPP_EBAY },
  });

  if (!integration?.enabled) {
    throw new Error("eBay TPP integration is not enabled");
  }

  const config = integration.config as Record<string, unknown>;
  const appId = config.appId as string;
  const certId = config.certId as string;
  const refreshToken = config.refreshToken as string;

  if (!appId || !certId || !refreshToken) {
    throw new Error("eBay TPP credentials missing from integration config");
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

  await purgeForeignSellerListingsForIntegration(integration.id, ebayConfig);

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
    variationsFound: 0,
    errors: [],
  };
  let pendingIncrementalItemIdsForCompletion: string[] = [];
  let pendingIncrementalWindowEndedAtForCompletion: string | null = null;
  let analyticsSnapshot: EbayTradingRateLimitSnapshot | null = null;

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

      const getItemRate = getEbayMethodRate(analyticsSnapshot, "GetItem");
      if (getItemRate?.status === "exhausted") {
        throw new EbayTradingApiError(
          buildEbayQuotaExhaustedMessage("GetItem", analyticsSnapshot),
          EBAY_USAGE_LIMIT_ERROR_CODE,
        );
      }

      const lastCursorValue =
        integrationConfig.syncState.lastCursor ??
        integrationConfig.syncState.lastIncrementalSyncAt ??
        integrationConfig.syncState.lastFullSyncAt ??
        integration.lastSyncAt?.toISOString() ??
        null;
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
        ));

      if (!incrementalWindow) {
        effectiveMode = "full";
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
            `will continue on the next scheduled pull.` +
            (budgetPlan.reservedGetItemCalls
              ? ` reorG kept about ${budgetPlan.reservedGetItemCalls} GetItem calls in reserve ` +
                `for later targeted refreshes.`
              : "");
        }

        if (
          targetedPlatformItemIds.length === 0 &&
          incrementalWindow.itemIds.length > 0 &&
          budgetPlan.itemIdsToProcess.length === 0
        ) {
          throw new EbayTradingApiError(
            buildEbayQuotaExhaustedMessage("GetItem", analyticsSnapshot),
            EBAY_USAGE_LIMIT_ERROR_CODE,
          );
        }

        let haltedIncrementalReason: string | null = null;

        for (
          let index = 0;
          index < processingItemIds.length;
          index += GETITEM_CONCURRENCY
        ) {
          const batch = processingItemIds.slice(
            index,
            index + GETITEM_CONCURRENCY,
          );
          const directResults = new Map<string, UpsertResult>();
          const itemIdsNeedingFetch: string[] = [];
          for (const itemId of batch) {
            const directResult = await tryApplyIncrementalQuantityFirstTppItem(
              incrementalEventItemsById?.[itemId],
              integration.id,
              ebayConfig,
            );
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
          let fetchResultIndex = 0;

          for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
            const itemId = batch[batchIndex];

            try {
              const directResult = directResults.get(itemId);
              if (directResult) {
                progress.itemsProcessed++;
                if (directResult === "created") progress.itemsCreated++;
                else if (directResult === "updated") progress.itemsUpdated++;
                if (directResult === "variation_parent") progress.variationsFound++;
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
              const result = fullItem
                ? await upsertEbayItem(fullItem, integration.id, ebayConfig)
                : null;

              if (!result) {
                progress.errors.push({
                  sku: itemId,
                  message: "GetItem returned no payload for this changed listing.",
                });
                continue;
              }

              progress.itemsProcessed++;
              if (result === "created") progress.itemsCreated++;
              else if (result === "updated") progress.itemsUpdated++;
              if (result === "variation_parent") progress.variationsFound++;
            } catch (err) {
              if (isEbayUsageLimitError(err)) {
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
                message: err instanceof Error ? err.message : "Unknown error",
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

      await runFullSync(integration, ebayConfig, syncJob.id, progress, analyticsSnapshot);
      const stalePrune = await removeMarketplaceListingsOlderThan(
        integration.id,
        syncJob.startedAt ?? new Date(0),
      );
      if (stalePrune.deletedListings > 0 || stalePrune.deletedMasterRows > 0) {
        console.log(
          `[ebay-tpp-sync] Pruned ${stalePrune.deletedListings} stale TPP listings and ${stalePrune.deletedMasterRows} orphaned master rows after full sync`,
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
        const upcsFetched = await fetchMissingUpcs(integration, ebayConfig);
        const adRatesUpdated = await fetchAndStorePromotedListingRates(
          integration.id,
          ebayConfig,
        );
        console.log(
          `[ebay-sync] Full reconcile complete - ${upcsFetched} UPCs updated, ${adRatesUpdated} ad rates refreshed`,
        );
      }
    } catch (postSyncErr) {
      console.error("[ebay-tpp-sync] Post-sync reconcile step failed", postSyncErr);
    }
  } catch (err) {
    progress.status = "FAILED";
    if (isEbayUsageLimitError(err)) {
      await recordRateLimitState(
        integration.id,
        err instanceof Error ? err.message : "eBay API usage limit reached.",
        pendingIncrementalItemIdsForCompletion,
        pendingIncrementalWindowEndedAtForCompletion,
        analyticsSnapshot?.nextResetAt,
      );
    }
    const allErrors = [
      ...progress.errors,
      {
        sku: "_global",
        message: err instanceof Error ? err.message : "Sync failed",
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
  }

  return progress;
}

async function runFullSync(
  integration: Pick<Integration, "id" | "config" | "platform">,
  ebayConfig: EbayConfig,
  syncJobId: string,
  progress: SyncProgress,
  analyticsSnapshot: EbayTradingRateLimitSnapshot | null,
) {
  const integrationId = integration.id;
  const integrationConfig = getIntegrationConfig(integration);
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
      const res = await fetchWithTimeout(TRADING_API, {
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

      const xml = await res.text();
      if (!res.ok) {
        throw new Error(`GetSellerList HTTP ${res.status}: ${xml.slice(0, 500)}`);
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
    }

    const items = arr(obj(resp, "ItemArray"), "Item");
    const totalPages = parseInt(
      str(obj(resp, "PaginationResult"), "TotalNumberOfPages") ?? "1",
      10,
    );
    hasMore = page < totalPages;
    page++;

    for (const item of items) {
      const itemId = str(item, "ItemID");
      let itemForUpsert = item;

      if (itemId && needsFullItemForUpc(item) && !skipHydrateDueToLimit) {
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
            itemForUpsert =
              (await fetchFullItem(integrationId, ebayConfig, itemId)) ?? item;
            hydrateCallsUsed += 1;
          } catch (error) {
            if (isEbayUsageLimitError(error)) {
              skipHydrateDueToLimit = true;
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

      const result = await upsertEbayItem(itemForUpsert, integrationId, ebayConfig);
      progress.itemsProcessed++;
      if (result === "created") progress.itemsCreated++;
      else if (result === "updated") progress.itemsUpdated++;
      if (result === "variation_parent") progress.variationsFound++;
    }

    await updateSyncJobProgress(syncJobId, progress);

    if (hasMore) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
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

  const credentials = Buffer.from(
    `${config.appId}:${config.certId}`,
  ).toString("base64");

  const tokenRes = await fetchWithTimeout("https://api.ebay.com/identity/v1/oauth2/token", {
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

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`eBay token refresh failed: ${tokenRes.status} ${text}`);
  }

  const data = await tokenRes.json();
  const accessToken = data.access_token;
  const expiresIn = data.expires_in ?? 7200;
  const refreshExpiresIn =
    data.refresh_token_expires_in ?? 18 * 30 * 24 * 60 * 60;
  const expiresAt = Date.now() + expiresIn * 1000;

  await db.integration.update({
    where: { id: integrationId },
    data: {
      config: {
        ...config,
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
): Promise<IncrementalWindow | null> {
  if (!lastCursor) return null;

  const cursorDate = new Date(lastCursor);
  if (Number.isNaN(cursorDate.getTime())) return null;

  if (Date.now() - cursorDate.getTime() > 36 * 60 * 60 * 1000) {
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
      const res = await fetchWithTimeout(TRADING_API, {
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

      const xml = await res.text();
      if (!res.ok) {
        throw new Error(`GetSellerEvents HTTP ${res.status}: ${xml.slice(0, 500)}`);
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

    const xml = await response.text();
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

function str(obj: unknown, key: string): string | undefined {
  if (obj == null || typeof obj !== "object") return undefined;
  const value = (obj as Record<string, unknown>)[key];
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const first = value[0];
    return first != null ? String(first) : undefined;
  }
  if (typeof value === "object") {
    const text = (value as Record<string, unknown>)["#text"];
    return text != null ? String(text) : undefined;
  }
  return String(value);
}

function num(obj: unknown, key: string): number | undefined {
  const value = str(obj, key);
  if (value == null) return undefined;
  const cleaned = value.replace(/[^0-9.\-]/g, "");
  const parsed = parseFloat(cleaned);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function obj(parent: unknown, key: string): Record<string, unknown> | undefined {
  if (parent == null || typeof parent !== "object") return undefined;
  const value = (parent as Record<string, unknown>)[key];
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function arr(parent: unknown, key: string): unknown[] {
  if (parent == null || typeof parent !== "object") return [];
  const raw = (parent as Record<string, unknown>)[key];
  if (Array.isArray(raw)) return raw;
  if (raw != null && typeof raw === "object") return [raw];
  return [];
}

function extractImageUrl(item: unknown): string | null {
  const pictureDetails = obj(item, "PictureDetails");
  if (!pictureDetails) return null;

  const urls = arr(pictureDetails, "PictureURL");
  for (const url of urls) {
    if (typeof url === "string" && url.startsWith("http")) return url;
  }

  return str(pictureDetails, "GalleryURL") ?? null;
}

function extractUpc(item: unknown): string | null {
  const listingDetails = obj(item, "ProductListingDetails");
  if (listingDetails) {
    const upc = str(listingDetails, "UPC");
    if (upc && upc !== "Does not apply" && upc !== "N/A" && upc.length > 3) {
      return upc;
    }

    const ean = str(listingDetails, "EAN");
    if (ean && ean !== "Does not apply" && ean !== "N/A" && ean.length > 3) {
      return ean;
    }
  }

  const specifics = obj(item, "ItemSpecifics");
  if (specifics) {
    const nameValueList = arr(specifics, "NameValueList");
    for (const nameValue of nameValueList) {
      const name = str(nameValue, "Name");
      if (name === "UPC" || name === "EAN" || name === "GTIN") {
        const value = str(nameValue, "Value");
        if (
          value &&
          value !== "Does not apply" &&
          value !== "N/A" &&
          value.length > 3
        ) {
          return value;
        }
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

function needsFullItemForUpc(item: unknown): boolean {
  const variationsNode = obj(item, "Variations");
  const variationList = variationsNode ? arr(variationsNode, "Variation") : [];

  if (variationList.length === 0) {
    return !extractUpc(item);
  }

  return variationList.some((variation) => !extractVariationUpc(variation));
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
          if (typeof url === "string" && url.startsWith("http")) return url;
        }
      }
    }
  }

  return null;
}

async function upsertEbayItem(
  item: unknown,
  integrationId: string,
  config: EbayConfig,
): Promise<UpsertResult> {
  const itemId = str(item, "ItemID");
  if (!itemId) throw new Error("Item has no ItemID");

  if (!matchesConfiguredSeller(item, config)) {
    await removeForeignSellerListings(integrationId, itemId);
    return "deleted";
  }

  const title = str(item, "Title");
  const imageUrl = extractImageUrl(item);
  const upc = extractUpc(item);
  const itemSku = str(item, "SKU");
  const variationsNode = obj(item, "Variations");
  const variationList = variationsNode ? arr(variationsNode, "Variation") : [];
  const variationPictures = variationsNode
    ? obj(variationsNode, "Pictures")
    : undefined;

  if (variationList.length > 0) {
    const parentSku = `TPP-${itemId}`;
    let parentMaster = await db.masterRow.findUnique({ where: { sku: parentSku } });
    if (!parentMaster) {
      parentMaster = await db.masterRow.create({
        data: {
          sku: parentSku,
          title: title ?? null,
          imageUrl,
          imageSource: "TPP_EBAY",
          upc,
        },
      });
    } else if (imageUrl && parentMaster.imageUrl !== imageUrl) {
      parentMaster = await db.masterRow.update({
        where: { id: parentMaster.id },
        data: { imageUrl, imageSource: "TPP_EBAY" },
      });
    }

    const existingParents = await db.marketplaceListing.findMany({
      where: { integrationId, platformItemId: itemId, platformVariantId: null },
      orderBy: { createdAt: "asc" },
    });
    let parentListing = existingParents[0] ?? null;

    if (existingParents.length > 1) {
      const duplicateIds = existingParents.slice(1).map((listing) => listing.id);
      await db.marketplaceListing.updateMany({
        where: { parentListingId: { in: duplicateIds } },
        data: { parentListingId: existingParents[0].id },
      });
      await db.marketplaceListing.deleteMany({
        where: { id: { in: duplicateIds } },
      });
    }

    if (!parentListing) {
      parentListing = await db.marketplaceListing.create({
        data: {
          masterRowId: parentMaster.id,
          integrationId,
          platformItemId: itemId,
          platformVariantId: null,
          sku: parentSku,
          title: title ?? null,
          imageUrl,
          isVariation: true,
          status: "ACTIVE",
          rawData: JSON.parse(JSON.stringify(item)),
          lastSyncedAt: new Date(),
        },
      });
    } else {
      await db.marketplaceListing.update({
        where: { id: parentListing.id },
        data: {
          masterRowId: parentMaster.id,
          title: title ?? null,
          imageUrl,
          rawData: JSON.parse(JSON.stringify(item)),
          lastSyncedAt: new Date(),
        },
      });
    }

    for (const variation of variationList) {
      const sku = str(variation, "SKU");
      if (!sku?.trim()) continue;

      const variationImageUrl = extractVariationImageUrl(
        variation,
        variationPictures,
      );
      const variationUpc = extractVariationUpc(variation);

      let childMaster = await db.masterRow.findUnique({ where: { sku } });
      if (!childMaster) {
        childMaster = await db.masterRow.create({
          data: {
            sku,
            title: title ?? null,
            imageUrl: variationImageUrl,
            imageSource: variationImageUrl ? "TPP_EBAY" : null,
            upc: variationUpc,
          },
        });
      } else if (childMaster.imageUrl !== variationImageUrl) {
        childMaster = await db.masterRow.update({
          where: { id: childMaster.id },
          data: {
            imageUrl: variationImageUrl,
            imageSource: variationImageUrl ? "TPP_EBAY" : null,
          },
        });
      }

      const startPrice = num(variation, "StartPrice");
      const sellingStatus = obj(variation, "SellingStatus");
      const quantity = num(variation, "Quantity") ?? 0;
      const quantitySold = sellingStatus
        ? (num(sellingStatus, "QuantitySold") ?? 0)
        : 0;
      const available = Math.max(0, quantity - quantitySold);

      const existingChild = await db.marketplaceListing.findFirst({
        where: {
          integrationId,
          platformItemId: itemId,
          platformVariantId: sku,
        },
      });

      const listingData = {
        masterRowId: childMaster.id,
        integrationId,
        platformItemId: itemId,
        platformVariantId: sku,
        sku,
        title: title ?? null,
        imageUrl: variationImageUrl,
        salePrice: startPrice ?? null,
        inventory: available,
        status: available > 0 ? ("ACTIVE" as const) : ("OUT_OF_STOCK" as const),
        isVariation: true,
        parentListingId: parentListing?.id ?? null,
        rawData: JSON.parse(JSON.stringify(variation)),
        lastSyncedAt: new Date(),
      };

      if (existingChild) {
        await db.marketplaceListing.update({
          where: { id: existingChild.id },
          data: listingData,
        });
      } else {
        await db.marketplaceListing.create({ data: listingData });
      }
    }

    return "variation_parent";
  }

  const sku = itemSku?.trim() || `TPP-${itemId}`;
  let masterRow = await db.masterRow.findUnique({ where: { sku } });
  if (!masterRow) {
    masterRow = await db.masterRow.create({
      data: {
        sku,
        title: title ?? null,
        imageUrl,
        imageSource: "TPP_EBAY",
        upc,
      },
    });
  } else if (imageUrl && masterRow.imageUrl !== imageUrl) {
    masterRow = await db.masterRow.update({
      where: { id: masterRow.id },
      data: { imageUrl, imageSource: "TPP_EBAY" },
    });
  }

  const sellingStatus = obj(item, "SellingStatus");
  const currentPrice = sellingStatus
    ? num(sellingStatus, "CurrentPrice")
    : undefined;
  const quantity =
    num(item, "Quantity") ??
    (sellingStatus ? num(sellingStatus, "Quantity") : undefined) ??
    0;
  const quantitySold = sellingStatus
    ? (num(sellingStatus, "QuantitySold") ?? 0)
    : 0;
  const available = Math.max(0, quantity - quantitySold);

  const existingSingles = await db.marketplaceListing.findMany({
    where: { integrationId, platformItemId: itemId, platformVariantId: null },
    orderBy: { createdAt: "asc" },
  });

  if (existingSingles.length > 1) {
    const duplicateIds = existingSingles.slice(1).map((listing) => listing.id);
    await db.marketplaceListing.deleteMany({ where: { id: { in: duplicateIds } } });
  }

  const existing = existingSingles[0] ?? null;
  const listingData = {
    masterRowId: masterRow.id,
    integrationId,
    platformItemId: itemId,
    platformVariantId: null,
    sku,
    title: title ?? null,
    imageUrl,
    salePrice: currentPrice ?? null,
    inventory: available,
    status: available > 0 ? ("ACTIVE" as const) : ("OUT_OF_STOCK" as const),
    isVariation: false,
    parentListingId: null,
    rawData: JSON.parse(JSON.stringify(item)),
    lastSyncedAt: new Date(),
  };

  if (existing) {
    await db.marketplaceListing.update({
      where: { id: existing.id },
      data: listingData,
    });
    return "updated";
  }

  await db.marketplaceListing.create({ data: listingData });
  return "created";
}

async function tryApplyIncrementalQuantityFirstTppItem(
  item: unknown,
  integrationId: string,
  config: EbayConfig,
): Promise<UpsertResult | null> {
  if (!item || typeof item !== "object") {
    return null;
  }

  const itemId = str(item, "ItemID");
  if (!itemId) {
    return null;
  }

  if (!matchesConfiguredSeller(item, config)) {
    await removeForeignSellerListings(integrationId, itemId);
    return "deleted";
  }

  const title = str(item, "Title");
  const now = new Date();
  const variationsNode = obj(item, "Variations");
  const variationList = variationsNode ? arr(variationsNode, "Variation") : [];

  if (variationList.length > 0) {
    const existingParent = await db.marketplaceListing.findFirst({
      where: { integrationId, platformItemId: itemId, platformVariantId: null },
      select: { id: true },
    });
    const existingChildren = await db.marketplaceListing.findMany({
      where: {
        integrationId,
        platformItemId: itemId,
        NOT: { platformVariantId: null },
      },
      select: { id: true, platformVariantId: true },
    });

    if (!existingParent || existingChildren.length !== variationList.length) {
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
    for (const variation of variationList) {
      const sku = str(variation, "SKU")?.trim();
      if (!sku) {
        return null;
      }

      const existingChild = childrenByVariantId.get(sku);
      if (!existingChild) {
        return null;
      }

      const variationSellingStatus = obj(variation, "SellingStatus");
      const variationQuantity =
        num(variation, "Quantity") ??
        (variationSellingStatus ? num(variationSellingStatus, "Quantity") : undefined) ??
        0;
      const variationSold = variationSellingStatus
        ? num(variationSellingStatus, "QuantitySold") ?? 0
        : 0;
      const available = Math.max(0, variationQuantity - variationSold);
      const salePrice =
        num(variation, "StartPrice") ??
        (variationSellingStatus ? num(variationSellingStatus, "CurrentPrice") : undefined);

      const data: Prisma.MarketplaceListingUpdateInput = {
        inventory: available,
        status: available > 0 ? "ACTIVE" : "OUT_OF_STOCK",
        lastSyncedAt: now,
        rawData: JSON.parse(JSON.stringify(variation)) as Prisma.InputJsonValue,
      };
      if (salePrice !== undefined) {
        data.salePrice = salePrice;
      }
      if (title) {
        data.title = title;
      }

      updates.push({ id: existingChild.id, data });
    }

    await db.$transaction([
      ...updates.map((update) =>
        db.marketplaceListing.update({
          where: { id: update.id },
          data: update.data,
        }),
      ),
      db.marketplaceListing.update({
        where: { id: existingParent.id },
        data: {
          lastSyncedAt: now,
          rawData: JSON.parse(JSON.stringify(item)) as Prisma.InputJsonValue,
          ...(title ? { title } : {}),
        },
      }),
    ]);

    return "variation_parent";
  }

  const existingListing = await db.marketplaceListing.findFirst({
    where: { integrationId, platformItemId: itemId, platformVariantId: null },
    select: { id: true },
  });
  if (!existingListing) {
    return null;
  }

  const sellingStatus = obj(item, "SellingStatus");
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

  return "updated";
}

async function fetchMissingUpcs(
  integration: Pick<Integration, "id" | "config" | "platform">,
  config: EbayConfig,
): Promise<number> {
  const integrationId = integration.id;
  const snap = await getEbayTradingRateLimitSnapshotForIntegration(integration).catch(
    () => null,
  );
  const getItemRate = getEbayMethodRate(snap, "GetItem");
  if (getItemRate?.status === "exhausted") {
    return 0;
  }
  if (getItemRate && getItemRate.limit > 0 && getItemRate.remaining < 15) {
    return 0;
  }

  const listings = await db.marketplaceListing.findMany({
    where: {
      integrationId,
      isVariation: false,
      parentListingId: null,
      masterRow: { upc: null },
    },
    select: { platformItemId: true, masterRowId: true },
  });

  if (listings.length === 0) return 0;
  let updated = 0;
  let haltedByLimit = false;

  for (let index = 0; index < listings.length && !haltedByLimit; index += GETITEM_CONCURRENCY) {
    const batch = listings.slice(index, index + GETITEM_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((listing) =>
        fetchItemUpc(integrationId, config, listing.platformItemId),
      ),
    );

    for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
      const result = results[resultIndex];
      if (result.status === "fulfilled" && result.value) {
        await db.masterRow.update({
          where: { id: batch[resultIndex].masterRowId },
          data: { upc: result.value },
        });
        updated++;
      } else if (result.status === "rejected" && isEbayUsageLimitError(result.reason)) {
        haltedByLimit = true;
        await recordRateLimitState(
          integrationId,
          result.reason instanceof Error
            ? result.reason.message
            : "eBay GetItem usage limit reached.",
          [],
          null,
          snap?.nextResetAt,
        );
        break;
      }
    }

    if (index + GETITEM_CONCURRENCY < listings.length && !haltedByLimit) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return updated;
}

async function fetchItemUpc(
  integrationId: string,
  config: EbayConfig,
  itemId: string,
): Promise<string | null> {
  const item = await fetchFullItem(integrationId, config, itemId);
  return item ? extractUpc(item) : null;
}

async function fetchAndStorePromotedListingRates(
  integrationId: string,
  config: EbayConfig,
): Promise<number> {
  const accessToken = await getAccessToken(integrationId, config);
  const campaignRes = await fetchWithTimeout(
    `${MARKETING_API_BASE}/ad_campaign?funding_strategy=COST_PER_SALE&limit=100`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!campaignRes.ok) return 0;

  const campaignData = (await campaignRes.json()) as {
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
      const adsRes = await fetchWithTimeout(adsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!adsRes.ok) break;

      const adsData = (await adsRes.json()) as {
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
