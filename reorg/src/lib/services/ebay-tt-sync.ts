import { db } from "@/lib/db";
import { Platform, Prisma, type SyncStatus } from "@prisma/client";
import { XMLParser } from "fast-xml-parser";
import type { RawListing } from "@/lib/integrations/types";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";
import {
  buildCompletedSyncConfig,
  type SyncExecutionOptions,
} from "@/lib/services/sync-control";
import {
  matchListings,
  upsertMarketplaceListings,
} from "@/lib/services/matching";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const MARKETING_API_BASE = "https://api.ebay.com/sell/marketing/v1";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const ADS_PAGE_SIZE = 500;

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

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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
    accessTokenExpiresAt:
      typeof config.accessTokenExpiresAt === "number"
        ? config.accessTokenExpiresAt
        : undefined,
  };

  const syncJob = await db.syncJob.create({
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

  try {
    let effectiveMode = options.effectiveMode ?? options.requestedMode ?? "full";
    let completionCursor = new Date().toISOString();

    if (effectiveMode === "incremental") {
      const integrationConfig = getIntegrationConfig(integration);
      const lastCursorValue =
        integrationConfig.syncState.lastCursor ??
        integrationConfig.syncState.lastIncrementalSyncAt ??
        integrationConfig.syncState.lastFullSyncAt ??
        integration.lastSyncAt?.toISOString() ??
        null;

      const incrementalWindow = await fetchIncrementalItemIds(
        integration.id,
        ebayConfig,
        lastCursorValue,
      );

      if (!incrementalWindow) {
        effectiveMode = "full";
      } else {
        completionCursor = incrementalWindow.windowEndedAt.toISOString();

        for (const itemId of incrementalWindow.itemIds) {
          try {
            const fullItem = await fetchFullItem(integration.id, ebayConfig, itemId);
            if (!fullItem) {
              progress.errors.push({
                sku: itemId,
                message: "GetItem returned no payload for this changed listing.",
              });
              continue;
            }

            await applyTtItem(fullItem, integration.id, progress);
          } catch (error) {
            progress.errors.push({
              sku: itemId,
              message: error instanceof Error ? error.message : "Unknown error",
            });
          }

          if (progress.itemsProcessed > 0 && progress.itemsProcessed % 25 === 0) {
            await updateSyncJobProgress(syncJob.id, progress);
          }
        }
      }
    }

    if (effectiveMode === "full") {
      await runFullSync(integration.id, ebayConfig, syncJob.id, progress);
      const adRatesUpdated = await fetchAndStorePromotedListingRates(
        integration.id,
        ebayConfig,
      );
      if (adRatesUpdated > 0) {
        console.log(`[ebay-tt-sync] Refreshed ${adRatesUpdated} promoted listing rates`);
      }
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
        config: buildCompletedSyncConfig(
          integration,
          { ...options, effectiveMode },
          completedAt,
          { cursor: completionCursor },
        ) as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    progress.status = "FAILED";
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
  }

  return progress;
}

async function runFullSync(
  integrationId: string,
  ebayConfig: EbayConfig,
  syncJobId: string,
  progress: SyncProgress,
) {
  let page = 1;
  const perPage = 100;
  let hasMore = true;

  while (hasMore) {
    const accessToken = await getAccessToken(integrationId, ebayConfig);
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

    const response = await fetch(TRADING_API, {
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

    const xml = await response.text();
    if (!response.ok) {
      throw new Error(`GetSellerList HTTP ${response.status}: ${xml.slice(0, 500)}`);
    }

    const parsed = parser.parse(xml);
    const resp = parsed?.GetSellerListResponse;
    if (!resp) {
      throw new Error(
        `Missing GetSellerListResponse. Keys: ${Object.keys(parsed ?? {}).join(", ")}`,
      );
    }

    const ack = resp.Ack;
    if (ack === "Failure") {
      const errors = Array.isArray(resp.Errors)
        ? resp.Errors
        : resp.Errors
          ? [resp.Errors]
          : [];
      const errorMessage = errors
        .map((entry: Record<string, unknown>) => entry.LongMessage ?? entry.ShortMessage)
        .join("; ");
      throw new Error(`eBay API: ${errorMessage || "Unknown error"}`);
    }

    const items = arr(obj(resp, "ItemArray"), "Item");
    const totalPages = parseInt(
      String(resp.PaginationResult?.TotalNumberOfPages ?? "1"),
      10,
    );
    hasMore = page < totalPages;
    page++;

    for (const item of items) {
      try {
        await applyTtItem(item, integrationId, progress);
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
  progress: SyncProgress,
) {
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

function extractListingsFromItem(item: unknown): RawListing[] {
  const itemId = str(item, "ItemID");
  if (!itemId) {
    return [];
  }

  const title = str(item, "Title") ?? "";
  const imageUrl = extractImageUrl(item) ?? undefined;
  const sellingStatus = obj(item, "SellingStatus");
  const currentPrice = sellingStatus ? num(sellingStatus, "CurrentPrice") : undefined;
  const quantity = sellingStatus ? num(sellingStatus, "Quantity") ?? 0 : 0;
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
        salePrice: currentPrice,
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
        extractVariationImageUrl(variation, variationPictures, imageUrl ?? null) ??
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
): Promise<string> {
  if (
    config.accessToken &&
    config.accessTokenExpiresAt &&
    config.accessTokenExpiresAt > Date.now() + 60_000
  ) {
    return config.accessToken;
  }

  const credentials = Buffer.from(`${config.appId}:${config.certId}`).toString("base64");
  const tokenResponse = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
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
    const text = await tokenResponse.text();
    throw new Error(`eBay token refresh failed: ${tokenResponse.status} ${text}`);
  }

  const data = await tokenResponse.json();
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
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const accessToken = await getAccessToken(integrationId, config);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetSellerEventsRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ModTimeFrom>${windowStartedAt.toISOString()}</ModTimeFrom>
  <ModTimeTo>${windowEndedAt.toISOString()}</ModTimeTo>
  <Pagination>
    <EntriesPerPage>200</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
</GetSellerEventsRequest>`;

    const response = await fetch(TRADING_API, {
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

    const xml = await response.text();
    if (!response.ok) {
      throw new Error(`GetSellerEvents HTTP ${response.status}: ${xml.slice(0, 500)}`);
    }

    const parsed = parser.parse(xml);
    const resp = parsed?.GetSellerEventsResponse;
    if (!resp) {
      throw new Error(
        `Missing GetSellerEventsResponse. Keys: ${Object.keys(parsed ?? {}).join(", ")}`,
      );
    }

    const ack = resp.Ack;
    if (ack === "Failure") {
      const errors = Array.isArray(resp.Errors)
        ? resp.Errors
        : resp.Errors
          ? [resp.Errors]
          : [];
      const errorMessage = errors
        .map((entry: Record<string, unknown>) => entry.LongMessage ?? entry.ShortMessage)
        .join("; ");
      throw new Error(`GetSellerEvents failed: ${errorMessage || "Unknown error"}`);
    }

    const items = arr(obj(resp, "ItemArray"), "Item");
    for (const item of items) {
      const itemId = str(item, "ItemID");
      if (itemId) {
        itemIds.add(itemId);
      }
    }

    const totalPages = parseInt(
      String(resp.PaginationResult?.TotalNumberOfPages ?? "1"),
      10,
    );
    hasMore = page < totalPages;
    page++;
  }

  return { itemIds: [...itemIds], windowEndedAt };
}

async function fetchFullItem(
  integrationId: string,
  config: EbayConfig,
  itemId: string,
): Promise<unknown | null> {
  const accessToken = await getAccessToken(integrationId, config);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`;

  const response = await fetch(TRADING_API, {
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

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GetItem failed for ${itemId}: ${response.status} ${text.slice(0, 300)}`);
  }

  const xml = await response.text();
  const parsed = parser.parse(xml);
  const itemRaw = parsed?.GetItemResponse?.Item;
  const item = Array.isArray(itemRaw) ? itemRaw[0] : itemRaw;
  return item ?? null;
}

async function fetchAndStorePromotedListingRates(
  integrationId: string,
  config: EbayConfig,
): Promise<number> {
  const accessToken = await getAccessToken(integrationId, config);
  const campaignResponse = await fetch(
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

  const campaignData = (await campaignResponse.json()) as {
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
      const adsResponse = await fetch(adsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!adsResponse.ok) {
        break;
      }

      const adsData = (await adsResponse.json()) as {
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
  if (raw != null && typeof raw === "object") return [raw];
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
  parentImageUrl: string | null,
): string | null {
  const specifics = obj(variation, "VariationSpecifics");
  if (specifics && variationPictures) {
    const pictureSets = arr(variationPictures, "VariationSpecificPictureSet");
    const nameValueList = arr(specifics, "NameValueList");

    for (const nameValue of nameValueList) {
      const value = str(nameValue, "Value");
      if (!value) continue;

      for (const pictureSet of pictureSets) {
        const pictureValue = str(pictureSet, "VariationSpecificValue");
        if (pictureValue === value) {
          const urls = arr(pictureSet, "PictureURL");
          for (const url of urls) {
            if (typeof url === "string" && url.startsWith("http")) {
              return url;
            }
          }
        }
      }
    }
  }

  return parentImageUrl;
}
