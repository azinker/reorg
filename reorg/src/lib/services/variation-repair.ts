import { db } from "@/lib/db";
import { Platform, Prisma } from "@prisma/client";

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

type VariationListingRecord = {
  id: string;
  masterRowId: string;
  platformItemId: string;
  platformVariantId: string | null;
  parentListingId: string | null;
  sku: string;
  title: string | null;
  imageUrl: string | null;
  inventory: number | null;
  status: "ACTIVE" | "OUT_OF_STOCK";
  rawData: Prisma.JsonValue;
  createdAt: Date;
};

export interface VariationRepairResult {
  familiesChecked: number;
  familiesRepaired: number;
  parentsCreated: number;
  duplicateParentsRemoved: number;
  childrenRelinked: number;
}

function sanitizeJson(value: Prisma.JsonValue | null | undefined): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

async function resolveParentMasterRowId(args: {
  platform: Platform;
  integrationId: string;
  platformItemId: string;
  childMasterRowIds: string[];
  parentListings: VariationListingRecord[];
  childListings: VariationListingRecord[];
}) {
  const childMasterRowIdSet = new Set(args.childMasterRowIds);

  const validExistingParent = args.parentListings.find(
    (listing) => !childMasterRowIdSet.has(listing.masterRowId),
  );
  if (validExistingParent) {
    return validExistingParent.masterRowId;
  }

  const referencedParentIds = [
    ...new Set(
      args.childListings
        .map((listing) => listing.parentListingId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ];

  if (referencedParentIds.length > 0) {
    const referencedParents = await db.marketplaceListing.findMany({
      where: { id: { in: referencedParentIds } },
      select: {
        id: true,
        masterRowId: true,
      },
    });

    const candidateMasterRowIds = [
      ...new Set(
        referencedParents
          .map((listing) =>
            childMasterRowIdSet.has(listing.masterRowId) ? null : listing.masterRowId,
          )
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      ),
    ];

    if (candidateMasterRowIds.length === 1) {
      return candidateMasterRowIds[0];
    }
  }

  const syntheticSku = getVariationParentSku(args.platform, args.platformItemId);
  const existingMasterRow = await db.masterRow.findUnique({
    where: { sku: syntheticSku },
    select: {
      id: true,
      title: true,
      imageUrl: true,
    },
  });

  const firstChild = args.childListings[0] ?? null;
  if (existingMasterRow) {
    const patch: Prisma.MasterRowUpdateInput = {};
    if (!existingMasterRow.title && firstChild?.title) {
      patch.title = firstChild.title;
    }
    if (!existingMasterRow.imageUrl && firstChild?.imageUrl) {
      patch.imageUrl = firstChild.imageUrl;
      patch.imageSource = args.platform;
    }
    if (Object.keys(patch).length > 0) {
      await db.masterRow.update({
        where: { id: existingMasterRow.id },
        data: patch,
      });
    }
    return existingMasterRow.id;
  }

  const createdMasterRow = await db.masterRow.create({
    data: {
      sku: syntheticSku,
      title: firstChild?.title ?? null,
      imageUrl: firstChild?.imageUrl ?? null,
      imageSource: args.platform,
    },
    select: { id: true },
  });

  return createdMasterRow.id;
}

async function ensureParentListing(args: {
  integrationId: string;
  parentMasterRowId: string;
  parentMasterSku: string;
  platformItemId: string;
  childListings: VariationListingRecord[];
  parentListings: VariationListingRecord[];
}) {
  const childInventoryValues = args.childListings
    .map((listing) => listing.inventory)
    .filter((value): value is number => typeof value === "number");
  const firstChild = args.childListings[0] ?? null;

  const updateData: Prisma.MarketplaceListingUncheckedUpdateInput = {
    masterRowId: args.parentMasterRowId,
    integrationId: args.integrationId,
    platformItemId: args.platformItemId,
    platformVariantId: null,
    sku: args.parentMasterSku,
    title: firstChild?.title ?? null,
    imageUrl: firstChild?.imageUrl ?? null,
    salePrice: null,
    adRate: null,
    inventory:
      childInventoryValues.length > 0
        ? childInventoryValues.reduce((sum, value) => sum + value, 0)
        : null,
    status: args.childListings.some((listing) => listing.status === "ACTIVE")
      ? "ACTIVE"
      : "OUT_OF_STOCK",
    isVariation: true,
    parentListingId: null,
    rawData:
      firstChild?.rawData != null
        ? sanitizeJson(firstChild.rawData)
        : { variationFamily: true, parentPlatformItemId: args.platformItemId },
    lastSyncedAt: new Date(),
  };

  const createData: Prisma.MarketplaceListingUncheckedCreateInput = {
    masterRowId: args.parentMasterRowId,
    integrationId: args.integrationId,
    platformItemId: args.platformItemId,
    platformVariantId: null,
    sku: args.parentMasterSku,
    title: firstChild?.title ?? null,
    imageUrl: firstChild?.imageUrl ?? null,
    salePrice: null,
    adRate: null,
    inventory:
      childInventoryValues.length > 0
        ? childInventoryValues.reduce((sum, value) => sum + value, 0)
        : null,
    status: args.childListings.some((listing) => listing.status === "ACTIVE")
      ? "ACTIVE"
      : "OUT_OF_STOCK",
    isVariation: true,
    parentListingId: null,
    rawData:
      firstChild?.rawData != null
        ? sanitizeJson(firstChild.rawData)
        : { variationFamily: true, parentPlatformItemId: args.platformItemId },
    lastSyncedAt: new Date(),
  };

  const validParents = args.parentListings.filter(
    (listing) => listing.masterRowId === args.parentMasterRowId,
  );
  const parentListing = validParents[0] ?? args.parentListings[0] ?? null;

  if (parentListing) {
    await db.marketplaceListing.update({
      where: { id: parentListing.id },
      data: updateData,
    });
    return {
      parentListingId: parentListing.id,
      parentCreated: false,
      duplicateParentIds: args.parentListings
        .filter((listing) => listing.id !== parentListing.id)
        .map((listing) => listing.id),
    };
  }

  const createdParent = await db.marketplaceListing.create({
    data: createData,
    select: { id: true },
  });

  return {
    parentListingId: createdParent.id,
    parentCreated: true,
    duplicateParentIds: [] as string[],
  };
}

/**
 * Undo damage from prior runs that incorrectly treated single-variant
 * BC/Shopify listings as variation children. Steps:
 *  1. Unlink listings with isVariation=false that got a parentListingId.
 *  2. Remove now-orphaned synthetic parent listings.
 *  3. Deactivate synthetic MasterRows that lost all their listings.
 */
async function cleanupFalseVariationFamilies(integrationId: string) {
  const falseChildren = await db.marketplaceListing.findMany({
    where: {
      integrationId,
      isVariation: false,
      parentListingId: { not: null },
    },
    select: { id: true, parentListingId: true },
  });

  if (falseChildren.length === 0) return;

  const parentListingIds = [
    ...new Set(
      falseChildren
        .map((l) => l.parentListingId)
        .filter((v): v is string => v != null),
    ),
  ];

  await db.marketplaceListing.updateMany({
    where: { id: { in: falseChildren.map((l) => l.id) } },
    data: { parentListingId: null },
  });

  for (const parentId of parentListingIds) {
    const remainingChildren = await db.marketplaceListing.count({
      where: { parentListingId: parentId },
    });

    if (remainingChildren > 0) continue;

    const parentListing = await db.marketplaceListing.findUnique({
      where: { id: parentId },
      select: { id: true, masterRowId: true, isVariation: true },
    });

    if (!parentListing) continue;

    await db.marketplaceListing.delete({ where: { id: parentId } });

    if (parentListing.masterRowId) {
      const remainingListings = await db.marketplaceListing.count({
        where: { masterRowId: parentListing.masterRowId },
      });

      if (remainingListings === 0) {
        await db.masterRow.update({
          where: { id: parentListing.masterRowId },
          data: { isActive: false },
        });
      }
    }
  }
}

export async function repairVariationFamiliesForIntegration(
  integrationId: string,
): Promise<VariationRepairResult> {
  const integration = await db.integration.findUnique({
    where: { id: integrationId },
    select: { platform: true },
  });

  if (!integration) {
    throw new Error(`Integration ${integrationId} not found for variation repair`);
  }

  await cleanupFalseVariationFamilies(integrationId);

  // Only consider listings explicitly marked as variation children.
  // BC and Shopify always assign a platformVariantId even to single-variant
  // products, so filtering on platformVariantId alone would incorrectly
  // group those single-SKU listings into variation families.
  const possibleChildListings = await db.marketplaceListing.findMany({
    where: {
      integrationId,
      platformVariantId: { not: null },
      isVariation: true,
    },
    select: {
      id: true,
      masterRowId: true,
      platformItemId: true,
      platformVariantId: true,
      parentListingId: true,
      sku: true,
      title: true,
      imageUrl: true,
      inventory: true,
      status: true,
      rawData: true,
      createdAt: true,
    },
    orderBy: [{ platformItemId: "asc" }, { createdAt: "asc" }],
  });

  const familyPlatformItemIds = [
    ...new Set(
      possibleChildListings
        .filter((listing) => (listing.platformVariantId?.trim() ?? "").length > 0)
        .map((listing) => listing.platformItemId),
    ),
  ];

  const result: VariationRepairResult = {
    familiesChecked: 0,
    familiesRepaired: 0,
    parentsCreated: 0,
    duplicateParentsRemoved: 0,
    childrenRelinked: 0,
  };

  if (familyPlatformItemIds.length === 0) {
    return result;
  }

  const familyListings = await db.marketplaceListing.findMany({
    where: {
      integrationId,
      platformItemId: { in: familyPlatformItemIds },
    },
    select: {
      id: true,
      masterRowId: true,
      platformItemId: true,
      platformVariantId: true,
      parentListingId: true,
      sku: true,
      title: true,
      imageUrl: true,
      inventory: true,
      status: true,
      rawData: true,
      createdAt: true,
    },
    orderBy: [{ platformItemId: "asc" }, { createdAt: "asc" }],
  });

  const families = new Map<string, VariationListingRecord[]>();
  for (const listing of familyListings) {
    const family = families.get(listing.platformItemId);
    if (family) {
      family.push(listing);
    } else {
      families.set(listing.platformItemId, [listing]);
    }
  }

  for (const [platformItemId, familyListings] of families) {
    const childListings = familyListings.filter((listing) => {
      const variantId = listing.platformVariantId?.trim() ?? "";
      return variantId.length > 0;
    });

    if (childListings.length === 0) {
      continue;
    }

    result.familiesChecked += 1;

    const childMasterRowIds = [...new Set(childListings.map((listing) => listing.masterRowId))];
    const parentListings = familyListings.filter((listing) => {
      const variantId = listing.platformVariantId?.trim() ?? "";
      return variantId.length === 0;
    });
    const childParentIds = new Set(
      childListings
        .map((listing) => listing.parentListingId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    const validExistingParents = parentListings.filter(
      (listing) => !childMasterRowIds.includes(listing.masterRowId),
    );

    // Most families are already healthy by the time this repair runs. Skip the
    // expensive per-family master-row / parent-listing resolution when we
    // already have exactly one valid parent and all children point to it.
    if (
      validExistingParents.length === 1 &&
      parentListings.length === 1 &&
      childParentIds.size <= 1 &&
      (!childParentIds.size || childParentIds.has(validExistingParents[0].id))
    ) {
      continue;
    }

    const parentMasterRowId = await resolveParentMasterRowId({
      platform: integration.platform,
      integrationId,
      platformItemId,
      childMasterRowIds,
      parentListings,
      childListings,
    });

    const parentMasterRow = await db.masterRow.findUnique({
      where: { id: parentMasterRowId },
      select: { id: true, sku: true },
    });

    if (!parentMasterRow) {
      throw new Error(
        `Variation repair could not load parent master row ${parentMasterRowId} for ${platformItemId}`,
      );
    }

    const {
      parentListingId,
      parentCreated,
      duplicateParentIds,
    } = await ensureParentListing({
      integrationId,
      parentMasterRowId: parentMasterRow.id,
      parentMasterSku: parentMasterRow.sku,
      platformItemId,
      childListings,
      parentListings,
    });

    const relinkChildIds = childListings
      .filter((listing) => listing.parentListingId !== parentListingId)
      .map((listing) => listing.id);

    if (relinkChildIds.length > 0) {
      await db.marketplaceListing.updateMany({
        where: { id: { in: relinkChildIds } },
        data: { parentListingId },
      });
      result.childrenRelinked += relinkChildIds.length;
    }

    if (duplicateParentIds.length > 0) {
      await db.marketplaceListing.updateMany({
        where: { parentListingId: { in: duplicateParentIds } },
        data: { parentListingId },
      });
      await db.marketplaceListing.deleteMany({
        where: { id: { in: duplicateParentIds } },
      });
      result.duplicateParentsRemoved += duplicateParentIds.length;
    }

    if (parentCreated || relinkChildIds.length > 0 || duplicateParentIds.length > 0) {
      result.familiesRepaired += 1;
    }
    if (parentCreated) {
      result.parentsCreated += 1;
    }
  }

  return result;
}
