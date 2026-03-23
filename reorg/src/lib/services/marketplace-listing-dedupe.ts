import { db } from "@/lib/db";

type ListingIdentityArgs = {
  integrationId: string;
  platformItemId: string;
  platformVariantId?: string | null;
};

type CanonicalListingArgs = ListingIdentityArgs & {
  preferredMasterRowId?: string | null;
};

type CanonicalListingRecord = {
  id: string;
  masterRowId: string;
  createdAt: Date;
};

type ReconcileMarketplaceListingIdentityResult = {
  canonical: CanonicalListingRecord | null;
  removedDuplicateIds: string[];
};

let singletonRepairPromise: Promise<number> | null = null;
let singletonRepairLastRunAt = 0;

const SINGLETON_REPAIR_COOLDOWN_MS = 5 * 60 * 1000;

export function normalizePlatformVariantId(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function buildListingIdentityWhere({
  integrationId,
  platformItemId,
  platformVariantId,
}: ListingIdentityArgs) {
  const normalizedVariantId = normalizePlatformVariantId(platformVariantId);

  return {
    integrationId,
    platformItemId,
    ...(normalizedVariantId
      ? { platformVariantId: normalizedVariantId }
      : { OR: [{ platformVariantId: null }, { platformVariantId: "" }] }),
  };
}

async function cleanupOrphanedMasterRows(candidateMasterRowIds: string[]) {
  if (candidateMasterRowIds.length === 0) {
    return 0;
  }

  const orphanedMasterRows = await db.masterRow.findMany({
    where: {
      id: { in: candidateMasterRowIds },
      isActive: true,
      listings: { none: {} },
    },
    select: { id: true },
  });

  const orphanedIds = orphanedMasterRows.map((row) => row.id);
  if (orphanedIds.length === 0) {
    return 0;
  }

  await db.stagedChange.deleteMany({
    where: { masterRowId: { in: orphanedIds } },
  });

  await db.masterRow.deleteMany({
    where: { id: { in: orphanedIds } },
  });

  return orphanedIds.length;
}

export async function reconcileMarketplaceListingIdentity({
  integrationId,
  platformItemId,
  platformVariantId,
  preferredMasterRowId,
}: CanonicalListingArgs): Promise<ReconcileMarketplaceListingIdentityResult> {
  const matches = await db.marketplaceListing.findMany({
    where: buildListingIdentityWhere({
      integrationId,
      platformItemId,
      platformVariantId,
    }),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      masterRowId: true,
      createdAt: true,
    },
  });

  if (matches.length === 0) {
    return { canonical: null, removedDuplicateIds: [] };
  }

  const canonical =
    (preferredMasterRowId
      ? matches.find((listing) => listing.masterRowId === preferredMasterRowId)
      : null) ?? matches[0];

  const duplicateListings = matches.filter((listing) => listing.id !== canonical.id);
  if (duplicateListings.length === 0) {
    return { canonical, removedDuplicateIds: [] };
  }

  const duplicateIds = duplicateListings.map((listing) => listing.id);
  const duplicateMasterRowIds = [
    ...new Set(
      duplicateListings
        .map((listing) => listing.masterRowId)
        .filter((masterRowId) => masterRowId !== canonical.masterRowId),
    ),
  ];

  await db.marketplaceListing.updateMany({
    where: { parentListingId: { in: duplicateIds } },
    data: { parentListingId: canonical.id },
  });

  await db.stagedChange.updateMany({
    where: { marketplaceListingId: { in: duplicateIds } },
    data: {
      marketplaceListingId: canonical.id,
      masterRowId: canonical.masterRowId,
    },
  });

  await db.marketplaceListing.deleteMany({
    where: { id: { in: duplicateIds } },
  });

  await cleanupOrphanedMasterRows(duplicateMasterRowIds);

  return { canonical, removedDuplicateIds: duplicateIds };
}

export async function repairDuplicateSingletonMarketplaceListings() {
  const singletonListings = await db.marketplaceListing.findMany({
    where: {
      parentListingId: null,
      OR: [{ platformVariantId: null }, { platformVariantId: "" }],
    },
    select: {
      integrationId: true,
      platformItemId: true,
      platformVariantId: true,
    },
    orderBy: [{ integrationId: "asc" }, { platformItemId: "asc" }],
  });

  const identities = new Map<
    string,
    { integrationId: string; platformItemId: string; platformVariantId: string | null; count: number }
  >();
  let repairedCount = 0;

  for (const listing of singletonListings) {
    const normalizedVariantId = normalizePlatformVariantId(listing.platformVariantId);
    const identityKey = [
      listing.integrationId,
      listing.platformItemId,
      normalizedVariantId ?? "",
    ].join(":");

    const existing = identities.get(identityKey);
    if (existing) {
      existing.count += 1;
    } else {
      identities.set(identityKey, {
        integrationId: listing.integrationId,
        platformItemId: listing.platformItemId,
        platformVariantId: normalizedVariantId,
        count: 1,
      });
    }
  }

  for (const identity of identities.values()) {
    if (identity.count < 2) {
      continue;
    }

    const result = await reconcileMarketplaceListingIdentity({
      integrationId: identity.integrationId,
      platformItemId: identity.platformItemId,
      platformVariantId: identity.platformVariantId,
    });

    if (result.removedDuplicateIds.length > 0) {
      repairedCount += 1;
    }
  }

  return repairedCount;
}

export async function maybeRepairDuplicateSingletonMarketplaceListings() {
  const now = Date.now();
  if (
    singletonRepairPromise == null &&
    now - singletonRepairLastRunAt < SINGLETON_REPAIR_COOLDOWN_MS
  ) {
    return 0;
  }

  if (singletonRepairPromise) {
    return singletonRepairPromise;
  }

  singletonRepairPromise = repairDuplicateSingletonMarketplaceListings()
    .then((count) => {
      singletonRepairLastRunAt = Date.now();
      return count;
    })
    .finally(() => {
      singletonRepairPromise = null;
    });

  return singletonRepairPromise;
}
