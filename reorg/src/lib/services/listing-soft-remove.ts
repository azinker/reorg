import { ListingStatus } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Hide locally-tracked listings from catalog surfaces when the marketplace no
 * longer returns them. This is intentionally a local soft-removal: sync remains
 * pull-only and never sends a marketplace delete.
 */
export async function markMarketplaceListingsRemovedByPlatformItemId(
  integrationId: string,
  platformItemId: string,
) {
  if (!platformItemId.trim()) {
    return { markedListings: 0 };
  }

  const result = await db.marketplaceListing.updateMany({
    where: {
      integrationId,
      platformItemId,
      status: { not: ListingStatus.REMOVED },
    },
    data: {
      status: ListingStatus.REMOVED,
      inventory: 0,
      lastSyncedAt: new Date(),
    },
  });

  return { markedListings: result.count };
}

export async function markMarketplaceListingsOlderThanRemoved(
  integrationId: string,
  cutoff: Date,
) {
  const result = await db.marketplaceListing.updateMany({
    where: {
      integrationId,
      status: { not: ListingStatus.REMOVED },
      OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: cutoff } }],
    },
    data: {
      status: ListingStatus.REMOVED,
      inventory: 0,
      lastSyncedAt: new Date(),
    },
  });

  return { markedListings: result.count };
}
