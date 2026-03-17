import { db } from "@/lib/db";
import { Platform, type SyncStatus } from "@prisma/client";
import { XMLParser } from "fast-xml-parser";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";

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
  variationsFound: number;
  errors: Array<{ sku: string; message: string }>;
}

export async function runEbayTppSync(): Promise<SyncProgress> {
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
    accessTokenExpiresAt: config.accessTokenExpiresAt as number | undefined,
  };

  const syncJob = await db.syncJob.create({
    data: {
      integrationId: integration.id,
      status: "RUNNING",
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

  try {
    let page = 1;
    const perPage = 100;
    let hasMore = true;

    while (hasMore) {
      const accessToken = await getAccessToken(integration.id, ebayConfig);

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

      const res = await fetch(TRADING_API, {
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
      const resp = parsed?.GetSellerListResponse;

      if (!resp) {
        throw new Error(`Missing GetSellerListResponse. Keys: ${Object.keys(parsed ?? {}).join(", ")}`);
      }

      const ack = resp.Ack;
      if (ack === "Failure") {
        const errors = Array.isArray(resp.Errors) ? resp.Errors : resp.Errors ? [resp.Errors] : [];
        const errMsg = errors.map((e: Record<string, unknown>) => e.LongMessage ?? e.ShortMessage).join("; ");
        throw new Error(`eBay API: ${errMsg || "Unknown error"}`);
      }

      const itemArray = resp.ItemArray;
      const items: unknown[] = Array.isArray(itemArray?.Item)
        ? itemArray.Item
        : itemArray?.Item
          ? [itemArray.Item]
          : [];

      const totalPages = parseInt(String(resp.PaginationResult?.TotalNumberOfPages ?? "1"), 10);
      const totalEntries = parseInt(String(resp.PaginationResult?.TotalNumberOfEntries ?? "0"), 10);

      console.log(
        `[ebay-sync] Page ${page}/${totalPages} — ${items.length} items on this page, ${totalEntries} total entries`
      );

      hasMore = page < totalPages;
      page++;

      for (const item of items) {
        try {
          const result = await upsertEbayItem(item, integration.id);
          progress.itemsProcessed++;
          if (result === "created") progress.itemsCreated++;
          else if (result === "updated") progress.itemsUpdated++;
          if (result === "variation_parent") progress.variationsFound++;
        } catch (err) {
          const iid = str(item, "ItemID") ?? "?";
          const msg = err instanceof Error ? err.message : "Unknown error";
          console.error(`[ebay-sync] Error on item ${iid}:`, msg);
          progress.errors.push({ sku: String(iid), message: msg });
        }
      }

      await db.syncJob.update({
        where: { id: syncJob.id },
        data: {
          itemsProcessed: progress.itemsProcessed,
          itemsCreated: progress.itemsCreated,
          itemsUpdated: progress.itemsUpdated,
          errors: JSON.parse(JSON.stringify(progress.errors)),
        },
      });

      if (hasMore) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    progress.status = "COMPLETED";

    await db.syncJob.update({
      where: { id: syncJob.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        itemsProcessed: progress.itemsProcessed,
        itemsCreated: progress.itemsCreated,
        itemsUpdated: progress.itemsUpdated,
        errors: JSON.parse(JSON.stringify(progress.errors)),
      },
    });

    await db.integration.update({
      where: { id: integration.id },
      data: { lastSyncAt: new Date() },
    });

    console.log(
      `[ebay-sync] COMPLETED — ${progress.itemsProcessed} processed, ${progress.itemsCreated} created, ${progress.itemsUpdated} updated, ${progress.variationsFound} variation parents, ${progress.errors.length} errors`
    );

    // Post-sync: fetch UPC for single-SKU items missing it via GetItem
    try {
      const upcsFetched = await fetchMissingUpcs(integration.id, ebayConfig);
      console.log(`[ebay-sync] UPC backfill: ${upcsFetched} items updated`);
    } catch (upcErr) {
      console.error("[ebay-sync] UPC backfill error (non-fatal):", upcErr);
    }

    // Post-sync: fetch live promoted listing ad rates from Marketing API and store in DB
    try {
      const adRatesUpdated = await fetchAndStorePromotedListingRates(integration.id, ebayConfig);
      console.log(`[ebay-sync] Promoted listing ad rates: ${adRatesUpdated} listings updated`);
    } catch (adErr) {
      console.error("[ebay-sync] Promoted listing ad rate fetch error (non-fatal):", adErr);
    }
  } catch (err) {
    console.error("[ebay-sync] FATAL:", err);
    progress.status = "FAILED";
    const allErrors = [
      ...progress.errors,
      { sku: "_global", message: err instanceof Error ? err.message : "Sync failed" },
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

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

async function getAccessToken(
  integrationId: string,
  config: EbayConfig
): Promise<string> {
  if (config.accessToken && config.accessTokenExpiresAt && config.accessTokenExpiresAt > Date.now() + 60_000) {
    return config.accessToken;
  }

  const credentials = Buffer.from(`${config.appId}:${config.certId}`).toString("base64");

  const tokenRes = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
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
  const refreshExpiresIn = data.refresh_token_expires_in ?? 18 * 30 * 24 * 60 * 60;

  const expiresAt = Date.now() + expiresIn * 1000;
  await db.integration.update({
    where: { id: integrationId },
    data: {
      config: {
        ...config,
        accessToken,
        accessTokenExpiresAt: expiresAt,
        refreshTokenExpiresAt: Date.now() + refreshExpiresIn * 1000,
      },
    },
  });

  config.accessToken = accessToken;
  config.accessTokenExpiresAt = expiresAt;
  return accessToken;
}

// ---------------------------------------------------------------------------
// XML value helpers — parser uses ignoreAttributes:true so values are always
// strings/numbers, never objects with #text. These helpers are simple.
// ---------------------------------------------------------------------------

function str(obj: unknown, key: string): string | undefined {
  if (obj == null || typeof obj !== "object") return undefined;
  const v = (obj as Record<string, unknown>)[key];
  if (v == null) return undefined;
  if (typeof v === "object") {
    const text = (v as Record<string, unknown>)?.["#text"];
    if (text != null) return String(text);
    return undefined;
  }
  return String(v);
}

function num(obj: unknown, key: string): number | undefined {
  const s = str(obj, key);
  if (s == null) return undefined;
  const cleaned = s.replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? undefined : n;
}

function obj(parent: unknown, key: string): Record<string, unknown> | undefined {
  if (parent == null || typeof parent !== "object") return undefined;
  const v = (parent as Record<string, unknown>)[key];
  if (v == null || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

function arr(parent: unknown, key: string): unknown[] {
  if (parent == null || typeof parent !== "object") return [];
  const raw = (parent as Record<string, unknown>)[key];
  if (Array.isArray(raw)) return raw;
  if (raw != null && typeof raw === "object") return [raw];
  return [];
}

// ---------------------------------------------------------------------------
// Extract structured fields from parsed item
// ---------------------------------------------------------------------------

function extractImageUrl(item: unknown): string | null {
  const pd = obj(item, "PictureDetails");
  if (!pd) return null;

  const urls = arr(pd, "PictureURL");
  for (const u of urls) {
    if (typeof u === "string" && u.startsWith("http")) return u;
  }

  const gallery = str(pd, "GalleryURL");
  return gallery ?? null;
}

function extractUpc(item: unknown): string | null {
  const pld = obj(item, "ProductListingDetails");
  if (pld) {
    const upc = str(pld, "UPC");
    if (upc && upc !== "Does not apply" && upc !== "N/A" && upc.length > 3) return upc;

    const ean = str(pld, "EAN");
    if (ean && ean !== "Does not apply" && ean !== "N/A" && ean.length > 3) return ean;
  }

  const specifics = obj(item, "ItemSpecifics");
  if (specifics) {
    const nvList = arr(specifics, "NameValueList");
    for (const nv of nvList) {
      const name = str(nv, "Name");
      if (name === "UPC" || name === "EAN" || name === "GTIN") {
        const val = str(nv, "Value");
        if (val && val !== "Does not apply" && val !== "N/A" && val.length > 3) return val;
      }
    }
  }

  return null;
}

function extractVariationUpc(vari: unknown): string | null {
  const vpld = obj(vari, "VariationProductListingDetails");
  if (!vpld) return null;
  for (const key of ["UPC", "EAN", "ISBN"]) {
    const val = str(vpld, key);
    if (val && val !== "Does not apply" && val !== "N/A" && val.length > 3) return val;
  }
  return null;
}

function extractVariationImageUrl(
  vari: unknown,
  variationPictures: unknown,
  parentImageUrl: string | null
): string | null {
  const specifics = obj(vari, "VariationSpecifics");
  if (specifics && variationPictures) {
    const picSets = arr(variationPictures, "VariationSpecificPictureSet");
    const nvList = arr(specifics, "NameValueList");
    for (const nv of nvList) {
      const val = str(nv, "Value");
      if (!val) continue;
      for (const picSet of picSets) {
        const picVal = str(picSet, "VariationSpecificValue");
        if (picVal === val) {
          const urls = arr(picSet, "PictureURL");
          for (const u of urls) {
            if (typeof u === "string" && u.startsWith("http")) return u;
          }
        }
      }
    }
  }
  return parentImageUrl;
}

// ---------------------------------------------------------------------------
// Upsert a single eBay item into the database
// ---------------------------------------------------------------------------

type UpsertResult = "created" | "updated" | "variation_parent";

async function upsertEbayItem(
  item: unknown,
  integrationId: string
): Promise<UpsertResult> {
  const itemId = str(item, "ItemID");
  if (!itemId) throw new Error("Item has no ItemID");

  const title = str(item, "Title");
  const imageUrl = extractImageUrl(item);
  const upc = extractUpc(item);
  const itemSku = str(item, "SKU");

  const variationsNode = obj(item, "Variations");
  const variationList = variationsNode ? arr(variationsNode, "Variation") : [];
  const variationPictures = variationsNode ? obj(variationsNode, "Pictures") : undefined;

  const isVariationListing = variationList.length > 0;

  if (isVariationListing) {
    console.log(
      `[ebay-sync] Item ${itemId} "${title?.slice(0, 60)}" → VARIATION with ${variationList.length} children`
    );

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
    } else {
      const updates: Record<string, unknown> = {};
      if (title) updates.title = title;
      if (imageUrl && !parentMaster.imageUrl) updates.imageUrl = imageUrl;
      if (upc && !parentMaster.upc) updates.upc = upc;
      if (Object.keys(updates).length > 0) {
        parentMaster = await db.masterRow.update({
          where: { id: parentMaster.id },
          data: updates,
        });
      }
    }

    const existingParents = await db.marketplaceListing.findMany({
      where: { integrationId, platformItemId: itemId, platformVariantId: null },
      orderBy: { createdAt: "asc" },
    });

    let parentListing = existingParents[0] ?? null;

    if (existingParents.length > 1) {
      const dupeIds = existingParents.slice(1).map((d) => d.id);
      console.log(`[ebay-sync] Cleaning up ${dupeIds.length} duplicate parent listings for item ${itemId}`);
      await db.marketplaceListing.updateMany({
        where: { parentListingId: { in: dupeIds } },
        data: { parentListingId: existingParents[0].id },
      });
      await db.marketplaceListing.deleteMany({ where: { id: { in: dupeIds } } });
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
          isVariation: true,
          sku: parentSku,
          rawData: JSON.parse(JSON.stringify(item)),
          lastSyncedAt: new Date(),
        },
      });
    }

    for (const vari of variationList) {
      const sku = str(vari, "SKU");
      if (!sku?.trim()) {
        console.warn(`[ebay-sync] Item ${itemId} variation missing SKU, skipping`);
        continue;
      }

      const variImageUrl = extractVariationImageUrl(vari, variationPictures, imageUrl);
      const variUpc = extractVariationUpc(vari);

      let childMaster = await db.masterRow.findUnique({ where: { sku } });
      if (!childMaster) {
        childMaster = await db.masterRow.create({
          data: {
            sku,
            title: title ?? null,
            imageUrl: variImageUrl,
            imageSource: "TPP_EBAY",
            upc: variUpc,
          },
        });
      } else {
        const updates: Record<string, unknown> = {};
        if (!childMaster.title && title) updates.title = title;
        if (!childMaster.imageUrl && variImageUrl) updates.imageUrl = variImageUrl;
        if (!childMaster.upc && variUpc) updates.upc = variUpc;
        if (Object.keys(updates).length > 0) {
          childMaster = await db.masterRow.update({
            where: { id: childMaster.id },
            data: updates,
          });
        }
      }

      const startPrice = num(vari, "StartPrice");
      const sellingStatus = obj(vari, "SellingStatus");
      const quantity = num(vari, "Quantity") ?? 0;
      const quantitySold = sellingStatus
        ? (num(sellingStatus, "QuantitySold") ?? 0)
        : 0;
      const available = Math.max(0, quantity - quantitySold);

      const existingChild = await db.marketplaceListing.findFirst({
        where: { integrationId, platformItemId: itemId, platformVariantId: sku },
      });

      const listingData = {
        masterRowId: childMaster.id,
        integrationId,
        platformItemId: itemId,
        platformVariantId: sku,
        sku,
        title: title ?? null,
        imageUrl: variImageUrl,
        salePrice: startPrice ?? null,
        inventory: available,
        status: available > 0 ? "ACTIVE" as const : "OUT_OF_STOCK" as const,
        isVariation: true,
        parentListingId: parentListing.id,
        rawData: JSON.parse(JSON.stringify(vari)),
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

  // ---- Single-SKU listing ----
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
  } else {
    const updates: Record<string, unknown> = {};
    if (title) updates.title = title;
    if (imageUrl && !masterRow.imageUrl) updates.imageUrl = imageUrl;
    if (upc && !masterRow.upc) updates.upc = upc;
    if (Object.keys(updates).length > 0) {
      masterRow = await db.masterRow.update({
        where: { id: masterRow.id },
        data: updates,
      });
    }
  }

  const sellingStatus = obj(item, "SellingStatus");
  const currentPrice = sellingStatus ? num(sellingStatus, "CurrentPrice") : undefined;
  const quantity = sellingStatus ? (num(sellingStatus, "Quantity") ?? 0) : 0;
  const quantitySold = sellingStatus ? (num(sellingStatus, "QuantitySold") ?? 0) : 0;
  const available = Math.max(0, quantity - quantitySold);

  const existingSingles = await db.marketplaceListing.findMany({
    where: { integrationId, platformItemId: itemId, platformVariantId: null },
    orderBy: { createdAt: "asc" },
  });

  if (existingSingles.length > 1) {
    const dupeIds = existingSingles.slice(1).map((d) => d.id);
    await db.marketplaceListing.deleteMany({ where: { id: { in: dupeIds } } });
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
    status: available > 0 ? "ACTIVE" as const : "OUT_OF_STOCK" as const,
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

// ---------------------------------------------------------------------------
// Post-sync: backfill UPC for single-SKU items via GetItem
// GetSellerList does not return ItemSpecifics/ProductListingDetails, so we
// make individual GetItem calls for items missing UPC.
// ---------------------------------------------------------------------------

const GETITEM_CONCURRENCY = 5;

async function fetchMissingUpcs(
  integrationId: string,
  config: EbayConfig
): Promise<number> {
  const listings = await db.marketplaceListing.findMany({
    where: {
      integrationId,
      isVariation: false,
      parentListingId: null,
      masterRow: { upc: null },
    },
    select: { id: true, platformItemId: true, masterRowId: true },
  });

  if (listings.length === 0) return 0;
  console.log(`[ebay-sync] UPC backfill: ${listings.length} single-SKU items missing UPC`);

  let updated = 0;

  for (let i = 0; i < listings.length; i += GETITEM_CONCURRENCY) {
    const batch = listings.slice(i, i + GETITEM_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((l) => fetchItemUpc(integrationId, config, l.platformItemId))
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled" && result.value) {
        await db.masterRow.update({
          where: { id: batch[j].masterRowId },
          data: { upc: result.value },
        });
        updated++;
      } else if (result.status === "rejected") {
        console.warn(`[ebay-sync] UPC backfill failed for item ${batch[j].platformItemId}:`, result.reason);
      }
    }

    if ((i + GETITEM_CONCURRENCY) % 50 === 0 || i + GETITEM_CONCURRENCY >= listings.length) {
      console.log(`[ebay-sync] UPC backfill progress: ${Math.min(i + GETITEM_CONCURRENCY, listings.length)}/${listings.length} checked, ${updated} updated`);
    }

    if (i + GETITEM_CONCURRENCY < listings.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return updated;
}

async function fetchItemUpc(
  integrationId: string,
  config: EbayConfig,
  itemId: string
): Promise<string | null> {
  const accessToken = await getAccessToken(integrationId, config);

  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <OutputSelector>ItemSpecifics</OutputSelector>
  <OutputSelector>ProductListingDetails</OutputSelector>
</GetItemRequest>`;

  const res = await fetch(TRADING_API, {
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

  if (!res.ok) return null;

  const xml = await res.text();
  const parsed = parser.parse(xml);
  const itemRaw = parsed?.GetItemResponse?.Item;
  const item = Array.isArray(itemRaw) ? itemRaw[0] : itemRaw;
  if (!item) return null;

  return extractUpc(item);
}

// ---------------------------------------------------------------------------
// Post-sync: fetch live promoted listing ad rates from Sell Marketing API
// (Cost Per Sale campaigns only) and update marketplace_listings.adRate.
// ---------------------------------------------------------------------------

const MARKETING_API_BASE = "https://api.ebay.com/sell/marketing/v1";
const ADS_PAGE_SIZE = 500;

interface MarketingCampaign {
  campaignId?: string;
  campaignStatus?: string;
  fundingStrategy?: { fundingModel?: string };
}

interface MarketingAd {
  listingId?: string;
  bidPercentage?: string;
}

async function fetchAndStorePromotedListingRates(
  integrationId: string,
  config: EbayConfig
): Promise<number> {
  const accessToken = await getAccessToken(integrationId, config);

  // Fetch all CPS campaigns (no status filter), then keep RUNNING or SCHEDULED only
  const campaignRes = await fetch(
    `${MARKETING_API_BASE}/ad_campaign?funding_strategy=COST_PER_SALE&limit=100`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!campaignRes.ok) {
    const text = await campaignRes.text();
    throw new Error(`Marketing API getCampaigns failed: ${campaignRes.status} ${text.slice(0, 300)}`);
  }

  const campaignData = (await campaignRes.json()) as { campaigns?: MarketingCampaign[] };
  const campaigns = campaignData.campaigns ?? [];
  const cpsCampaigns = campaigns.filter(
    (c) =>
      c.campaignId &&
      c.fundingStrategy?.fundingModel === "COST_PER_SALE" &&
      (c.campaignStatus === "RUNNING" || c.campaignStatus === "SCHEDULED")
  );

  if (cpsCampaigns.length === 0) {
    console.log(
      "[ebay-sync] No RUNNING/SCHEDULED CPS campaigns found (CPS campaigns in response: " +
        campaigns.length +
        "). Ad rates will show N/A until you have an active Promoted Listings Standard campaign. If you use Promoted Listings, reconnect eBay in Integrations to ensure the sell.marketing scope is granted."
    );
    return 0;
  }

  console.log(`[ebay-sync] Found ${cpsCampaigns.length} RUNNING/SCHEDULED CPS campaign(s), fetching ads...`);

  const listingIdToBidPct = new Map<string, number>();

  for (const campaign of cpsCampaigns) {
    const campaignId = campaign.campaignId!;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const adsUrl = `${MARKETING_API_BASE}/ad_campaign/${campaignId}/ad?limit=${ADS_PAGE_SIZE}&offset=${offset}`;
      const adsRes = await fetch(adsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!adsRes.ok) {
        const text = await adsRes.text();
        console.warn(`[ebay-sync] getAds failed for campaign ${campaignId}: ${adsRes.status} ${text.slice(0, 200)}`);
        break;
      }

      const adsData = (await adsRes.json()) as {
        ads?: MarketingAd[];
        total?: number;
        limit?: number;
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
      hasMore = ads.length === ADS_PAGE_SIZE && (adsData.total == null || offset < adsData.total);

      if (hasMore) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }

  if (listingIdToBidPct.size === 0) {
    console.log("[ebay-sync] No ads returned from CPS campaigns; ad rates unchanged.");
    return 0;
  }

  console.log(`[ebay-sync] Updating ad rates for ${listingIdToBidPct.size} listing(s)...`);
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
