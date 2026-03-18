import { db } from "@/lib/db";

async function removeMarketplaceListingsByIds(listingIds: string[]) {
  if (listingIds.length === 0) {
    return { deletedListings: 0, deletedMasterRows: 0 };
  }

  const listings = await db.marketplaceListing.findMany({
    where: {
      id: { in: listingIds },
    },
    select: {
      id: true,
      masterRowId: true,
    },
  });

  if (listings.length === 0) {
    return { deletedListings: 0, deletedMasterRows: 0 };
  }

  const candidateMasterRowIds = [...new Set(listings.map((listing) => listing.masterRowId))];

  await db.stagedChange.deleteMany({
    where: {
      marketplaceListingId: { in: listingIds },
    },
  });

  const deletedListings = await db.marketplaceListing.deleteMany({
    where: { id: { in: listingIds } },
  });

  const orphanedMasterRows = await db.masterRow.findMany({
    where: {
      id: { in: candidateMasterRowIds },
      isActive: true,
      listings: { none: {} },
    },
    select: { id: true },
  });

  const orphanedIds = orphanedMasterRows.map((row) => row.id);

  if (orphanedIds.length > 0) {
    await db.stagedChange.deleteMany({
      where: {
        masterRowId: { in: orphanedIds },
      },
    });

    await db.masterRow.deleteMany({
      where: { id: { in: orphanedIds } },
    });
  }

  return {
    deletedListings: deletedListings.count,
    deletedMasterRows: orphanedIds.length,
  };
}

export async function removeMarketplaceListingsByPlatformItemIds(
  integrationId: string,
  platformItemIds: string[],
) {
  if (platformItemIds.length === 0) {
    return { deletedListings: 0, deletedMasterRows: 0 };
  }

  const listings = await db.marketplaceListing.findMany({
    where: {
      integrationId,
      platformItemId: { in: platformItemIds },
    },
    select: {
      id: true,
      masterRowId: true,
    },
  });

  if (listings.length === 0) {
    return { deletedListings: 0, deletedMasterRows: 0 };
  }

  return removeMarketplaceListingsByIds(listings.map((listing) => listing.id));
}

export async function removeMarketplaceListingsMissingFromProductSet(
  integrationId: string,
  platformItemId: string,
  presentVariantIds: string[],
) {
  const listings = await db.marketplaceListing.findMany({
    where: {
      integrationId,
      platformItemId,
    },
    select: {
      id: true,
      platformVariantId: true,
    },
  });

  if (listings.length === 0) {
    return { deletedListings: 0, deletedMasterRows: 0 };
  }

  const presentKeys = new Set(
    presentVariantIds.map((variantId) => variantId.trim()),
  );
  const staleListingIds = listings
    .filter((listing) => {
      const variantKey = listing.platformVariantId?.trim() ?? "";
      return !presentKeys.has(variantKey);
    })
    .map((listing) => listing.id);

  return removeMarketplaceListingsByIds(staleListingIds);
}
