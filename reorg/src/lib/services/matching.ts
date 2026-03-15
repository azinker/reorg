import { db } from "@/lib/db";
import type { RawListing } from "@/lib/integrations/types";

export interface MatchResult {
  matched: { listing: RawListing; masterRowId: string }[];
  unmatched: RawListing[];
  stats: {
    total: number;
    matched: number;
    unmatched: number;
    created: number;
    updated: number;
  };
}

/**
 * Match fetched listings against MasterRow records by exact SKU.
 * Unmatched listings go to the UnmatchedListing table.
 *
 * When processing master-store listings, MasterRow records are created
 * if they don't exist. For non-master stores, only exact SKU matches
 * are linked — no fuzzy matching.
 */
export async function matchListings(
  listings: RawListing[],
  integrationId: string,
  isMaster: boolean
): Promise<MatchResult> {
  const result: MatchResult = {
    matched: [],
    unmatched: [],
    stats: { total: listings.length, matched: 0, unmatched: 0, created: 0, updated: 0 },
  };

  const skus = listings.map((l) => l.sku).filter(Boolean);
  const uniqueSkus = [...new Set(skus)];

  const existingRows = await db.masterRow.findMany({
    where: { sku: { in: uniqueSkus } },
    select: { id: true, sku: true },
  });

  const skuToMasterRowId = new Map(existingRows.map((r) => [r.sku, r.id]));

  for (const listing of listings) {
    if (!listing.sku) {
      result.unmatched.push(listing);
      result.stats.unmatched++;
      continue;
    }

    let masterRowId = skuToMasterRowId.get(listing.sku);

    if (!masterRowId && isMaster) {
      const newRow = await db.masterRow.create({
        data: {
          sku: listing.sku,
          title: listing.title || null,
          imageUrl: listing.imageUrl || null,
          imageSource: "master",
          upc: listing.upc || null,
        },
      });
      masterRowId = newRow.id;
      skuToMasterRowId.set(listing.sku, masterRowId);
      result.stats.created++;
    }

    if (masterRowId) {
      result.matched.push({ listing, masterRowId });
      result.stats.matched++;
    } else {
      result.unmatched.push(listing);
      result.stats.unmatched++;
    }
  }

  return result;
}

/**
 * Upsert matched listings into MarketplaceListing table.
 * Only updates live data fields — never touches StagedChange.
 */
export async function upsertMarketplaceListings(
  matched: MatchResult["matched"],
  integrationId: string
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (const { listing, masterRowId } of matched) {
    const existing = await db.marketplaceListing.findUnique({
      where: {
        integrationId_platformItemId_platformVariantId: {
          integrationId,
          platformItemId: listing.platformItemId,
          platformVariantId: listing.platformVariantId ?? "",
        },
      },
    });

    const data = {
      masterRowId,
      integrationId,
      platformItemId: listing.platformItemId,
      platformVariantId: listing.platformVariantId ?? "",
      sku: listing.sku,
      title: listing.title,
      imageUrl: listing.imageUrl,
      salePrice: listing.salePrice,
      adRate: listing.adRate,
      inventory: listing.inventory,
      status: listing.status === "active" ? "ACTIVE" as const : "OUT_OF_STOCK" as const,
      isVariation: listing.isVariation,
      rawData: listing.rawData as object,
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await db.marketplaceListing.update({
        where: { id: existing.id },
        data,
      });
      updated++;
    } else {
      await db.marketplaceListing.create({ data });
      created++;
    }
  }

  return { created, updated };
}

/**
 * Save unmatched listings to the UnmatchedListing table.
 */
export async function saveUnmatchedListings(
  unmatched: RawListing[],
  integrationId: string
): Promise<number> {
  let count = 0;

  for (const listing of unmatched) {
    await db.unmatchedListing.upsert({
      where: {
        integrationId_platformItemId: {
          integrationId,
          platformItemId: listing.platformItemId,
        },
      },
      create: {
        integrationId,
        platformItemId: listing.platformItemId,
        sku: listing.sku || null,
        title: listing.title || null,
        rawData: listing.rawData as object,
        lastSyncedAt: new Date(),
      },
      update: {
        sku: listing.sku || null,
        title: listing.title || null,
        rawData: listing.rawData as object,
        lastSyncedAt: new Date(),
      },
    });
    count++;
  }

  return count;
}
