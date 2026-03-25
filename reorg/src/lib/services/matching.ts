import { db } from "@/lib/db";
import type { RawListing } from "@/lib/integrations/types";
import {
  normalizePlatformVariantId,
  reconcileMarketplaceListingIdentity,
} from "@/lib/services/marketplace-listing-dedupe";
import { Platform, Prisma } from "@prisma/client";

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

function getVariationParentSku(platform: Platform, platformItemId: string) {
  switch (platform) {
    case Platform.TPP_EBAY:
      return `TPP-${platformItemId}`;
    case Platform.TT_EBAY:
      return `TT-${platformItemId}`;
    case Platform.BIGCOMMERCE:
      return `BC-${platformItemId}`;
    case Platform.SHOPIFY:
      return `SHPFY-${platformItemId}`;
    default:
      return `VAR-${platformItemId}`;
  }
}

async function resolveVariationParentMasterRowId(
  matchedFamily: MatchResult["matched"],
  integrationId: string,
  parentPlatformItemId: string,
  platform: Platform,
) {
  const childMasterRowIds = [...new Set(matchedFamily.map((entry) => entry.masterRowId))];

  const linkedParentListings = await db.marketplaceListing.findMany({
    where: {
      masterRowId: { in: childMasterRowIds },
      parentListingId: { not: null },
    },
    select: {
      parentListing: {
        select: {
          masterRowId: true,
        },
      },
    },
  });

  const candidateParentMasterRowIds = [
    ...new Set(
      linkedParentListings
        .map((entry) => entry.parentListing?.masterRowId ?? null)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
    ),
  ];

  if (candidateParentMasterRowIds.length === 1) {
    return candidateParentMasterRowIds[0];
  }

  const existingIntegrationParent = await db.marketplaceListing.findFirst({
    where: {
      integrationId,
      platformItemId: parentPlatformItemId,
      OR: [{ platformVariantId: null }, { platformVariantId: "" }],
    },
    select: {
      masterRowId: true,
    },
    orderBy: { createdAt: "asc" },
  });

  if (existingIntegrationParent?.masterRowId) {
    return existingIntegrationParent.masterRowId;
  }

  const parentSku = getVariationParentSku(platform, parentPlatformItemId);
  const parentTitle = matchedFamily[0]?.listing.title?.trim() || null;
  const parentImageUrl = matchedFamily[0]?.listing.imageUrl?.trim() || null;

  const existingParentMaster = await db.masterRow.findUnique({
    where: { sku: parentSku },
  });

  if (existingParentMaster) {
    const patch: Prisma.MasterRowUpdateInput = {};
    if (!existingParentMaster.title && parentTitle) patch.title = parentTitle;
    if (!existingParentMaster.imageUrl && parentImageUrl) {
      patch.imageUrl = parentImageUrl;
      patch.imageSource = platform;
    }
    if (Object.keys(patch).length > 0) {
      await db.masterRow.update({
        where: { id: existingParentMaster.id },
        data: patch,
      });
    }
    return existingParentMaster.id;
  }

  const createdParentMaster = await db.masterRow.create({
    data: {
      sku: parentSku,
      title: parentTitle,
      imageUrl: parentImageUrl,
      imageSource: platform,
    },
  });

  return createdParentMaster.id;
}

async function ensureVariationParentListing(args: {
  integrationId: string;
  parentMasterRowId: string;
  parentMasterSku: string;
  parentPlatformItemId: string;
  title: string | null;
  imageUrl: string | null;
  rawData: Record<string, unknown>;
  hasActiveChildren: boolean;
  childInventoryTotal: number | null;
}) {
  const existingParents = await db.marketplaceListing.findMany({
    where: {
      integrationId: args.integrationId,
      platformItemId: args.parentPlatformItemId,
      OR: [{ platformVariantId: null }, { platformVariantId: "" }],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      masterRowId: true,
    },
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

  const listingData: Prisma.MarketplaceListingUncheckedUpdateInput = {
    masterRowId: args.parentMasterRowId,
    integrationId: args.integrationId,
    platformItemId: args.parentPlatformItemId,
    platformVariantId: null,
    sku: args.parentMasterSku,
    title: args.title,
    imageUrl: args.imageUrl,
    salePrice: null,
    adRate: null,
    inventory: args.childInventoryTotal,
    status: args.hasActiveChildren ? "ACTIVE" : "OUT_OF_STOCK",
    isVariation: true,
    parentListingId: null,
    rawData: JSON.parse(JSON.stringify(args.rawData)) as Prisma.InputJsonValue,
    lastSyncedAt: new Date(),
  };

  const createData: Prisma.MarketplaceListingUncheckedCreateInput = {
    masterRowId: args.parentMasterRowId,
    integrationId: args.integrationId,
    platformItemId: args.parentPlatformItemId,
    platformVariantId: null,
    sku: args.parentMasterSku,
    title: args.title,
    imageUrl: args.imageUrl,
    salePrice: null,
    adRate: null,
    inventory: args.childInventoryTotal,
    status: args.hasActiveChildren ? "ACTIVE" : "OUT_OF_STOCK",
    isVariation: true,
    parentListingId: null,
    rawData: JSON.parse(JSON.stringify(args.rawData)) as Prisma.InputJsonValue,
    lastSyncedAt: new Date(),
  };

  if (parentListing) {
    await db.marketplaceListing.update({
      where: { id: parentListing.id },
      data: listingData,
    });
    return parentListing.id;
  }

  const createdParentListing = await db.marketplaceListing.create({
    data: createData,
    select: { id: true },
  });

  return createdParentListing.id;
}

async function upsertVariationFamily(
  matchedFamily: MatchResult["matched"],
  integrationId: string,
  platform: Platform,
  parentPlatformItemId: string,
): Promise<{ created: number; updated: number }> {
  const parentMasterRowId = await resolveVariationParentMasterRowId(
    matchedFamily,
    integrationId,
    parentPlatformItemId,
    platform,
  );
  const parentMaster = await db.masterRow.findUnique({
    where: { id: parentMasterRowId },
    select: { id: true, sku: true },
  });

  if (!parentMaster) {
    throw new Error(`Parent master row ${parentMasterRowId} not found for variation family ${parentPlatformItemId}`);
  }

  const firstListing = matchedFamily[0]?.listing;
  const childInventoryValues = matchedFamily
    .map((entry) => entry.listing.inventory)
    .filter((value): value is number => typeof value === "number");
  const parentListingId = await ensureVariationParentListing({
    integrationId,
    parentMasterRowId: parentMaster.id,
    parentMasterSku: parentMaster.sku,
    parentPlatformItemId,
    title: firstListing?.title?.trim() || null,
    imageUrl: firstListing?.imageUrl?.trim() || null,
    rawData:
      firstListing?.rawData ?? {
        variationFamily: true,
        parentPlatformItemId,
      },
    hasActiveChildren: matchedFamily.some((entry) => entry.listing.status === "active"),
    childInventoryTotal:
      childInventoryValues.length > 0
        ? childInventoryValues.reduce((sum, value) => sum + value, 0)
        : null,
  });

  let created = 0;
  let updated = 0;

  for (const { listing, masterRowId } of matchedFamily) {
    const variantId = listing.platformVariantId ? String(listing.platformVariantId) : null;
    if (!variantId) {
      continue;
    }

    const existing = await db.marketplaceListing.findFirst({
      where: {
        integrationId,
        platformItemId: listing.platformItemId,
        platformVariantId: variantId,
      },
      select: { id: true },
    });

    const data: Prisma.MarketplaceListingUncheckedCreateInput = {
      masterRowId,
      integrationId,
      platformItemId: listing.platformItemId,
      platformVariantId: variantId,
      sku: listing.sku,
      title: listing.title,
      imageUrl: listing.imageUrl,
      salePrice: listing.salePrice ?? null,
      adRate: listing.adRate ?? null,
      inventory: listing.inventory ?? null,
      status: listing.status === "active" ? "ACTIVE" : "OUT_OF_STOCK",
      isVariation: true,
      parentListingId,
      rawData: JSON.parse(JSON.stringify(listing.rawData ?? {})) as Prisma.InputJsonValue,
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
    select: { id: true, sku: true, imageUrl: true },
  });

  const skuToMasterRow = new Map(existingRows.map((r) => [r.sku, r]));

  for (const listing of listings) {
    if (!listing.sku) {
      result.unmatched.push(listing);
      result.stats.unmatched++;
      continue;
    }

    const existingMaster = skuToMasterRow.get(listing.sku);
    let masterRowId = existingMaster?.id;

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
      skuToMasterRow.set(listing.sku, { id: newRow.id, sku: newRow.sku, imageUrl: newRow.imageUrl });
      result.stats.created++;
    } else if (masterRowId && isMaster && listing.imageUrl) {
      if (existingMaster && existingMaster.imageUrl !== listing.imageUrl) {
        await db.masterRow.update({
          where: { id: masterRowId },
          data: { imageUrl: listing.imageUrl, imageSource: "master" },
        });
      }
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
  const integration = await db.integration.findUnique({
    where: { id: integrationId },
    select: { platform: true },
  });

  if (!integration) {
    throw new Error(`Integration ${integrationId} not found`);
  }

  let created = 0;
  let updated = 0;

  const variationFamilies = new Map<string, MatchResult["matched"]>();
  const standaloneMatches: MatchResult["matched"] = [];

  for (const entry of matched) {
    if (entry.listing.isVariation && entry.listing.parentPlatformItemId) {
      const key = entry.listing.parentPlatformItemId;
      const family = variationFamilies.get(key);
      if (family) {
        family.push(entry);
      } else {
        variationFamilies.set(key, [entry]);
      }
      continue;
    }

    standaloneMatches.push(entry);
  }

  for (const [parentPlatformItemId, family] of variationFamilies) {
    const result = await upsertVariationFamily(
      family,
      integrationId,
      integration.platform,
      parentPlatformItemId,
    );
    created += result.created;
    updated += result.updated;
  }

  for (const { listing, masterRowId } of standaloneMatches) {
    const normalizedVariantId = normalizePlatformVariantId(listing.platformVariantId);
    const { canonical: existing } = await reconcileMarketplaceListingIdentity({
      integrationId,
      platformItemId: listing.platformItemId,
      platformVariantId: normalizedVariantId,
      preferredMasterRowId: masterRowId,
    });

    const data = {
      masterRowId,
      integrationId,
      platformItemId: listing.platformItemId,
      platformVariantId: normalizedVariantId,
      sku: listing.sku,
      title: listing.title,
      imageUrl: listing.imageUrl,
      salePrice: listing.salePrice,
      adRate: listing.adRate,
      inventory: listing.inventory,
      status: listing.status === "active" ? "ACTIVE" as const : "OUT_OF_STOCK" as const,
      isVariation: listing.isVariation,
      parentListingId: null,
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
