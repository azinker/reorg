import { db } from "@/lib/db";
import { Platform, Prisma, type SyncStatus } from "@prisma/client";
import { ShopifyAdapter } from "@/lib/integrations/shopify";
import type { RawListing } from "@/lib/integrations/types";
import {
  buildCompletedSyncConfigFromLatest,
  type SyncExecutionOptions,
} from "@/lib/services/sync-control";
import {
  removeMarketplaceListingsByPlatformItemIds,
  removeMarketplaceListingsMissingFromProductSet,
} from "@/lib/services/listing-prune";
import {
  recordWebhookReconcileCompleted,
  recordWebhookReconcileFailed,
} from "@/lib/services/webhook-reconcile-audit";

interface SyncProgress {
  jobId: string;
  status: SyncStatus;
  itemsProcessed: number;
  itemsCreated: number;
  itemsUpdated: number;
  errors: Array<{ sku: string; message: string }>;
}

interface ShopifySyncContext {
  integration: NonNullable<Awaited<ReturnType<typeof db.integration.findUnique>>>;
  adapter: ShopifyAdapter;
}

async function getShopifySyncContext(): Promise<ShopifySyncContext> {
  const integration = await db.integration.findUnique({
    where: { platform: Platform.SHOPIFY },
  });

  if (!integration?.enabled) {
    throw new Error("Shopify integration is not enabled");
  }

  const config = integration.config as Record<string, string>;
  if (!config.accessToken || !config.storeDomain) {
    throw new Error("Shopify credentials missing from integration config");
  }

  const adapter = new ShopifyAdapter({
    storeDomain: config.storeDomain,
    accessToken: config.accessToken,
    apiVersion: config.apiVersion || "2026-01",
  });

  return { integration, adapter };
}

function createSyncProgress(jobId: string): SyncProgress {
  return {
    jobId,
    status: "RUNNING",
    itemsProcessed: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    errors: [],
  };
}

export async function runShopifySync(
  options: SyncExecutionOptions = {},
): Promise<SyncProgress> {
  const { integration, adapter } = await getShopifySyncContext();

  const syncJob = await db.syncJob.create({
    data: {
      integrationId: integration.id,
      status: "RUNNING",
      triggeredBy: options.triggeredBy ?? "system",
      startedAt: new Date(),
    },
  });

  const progress = createSyncProgress(syncJob.id);

  try {
    const seenListingIds = new Set<string>();

    for await (const batch of adapter.fetchAllListings()) {
      for (const listing of batch) {
        try {
          const result = await upsertListing(listing, integration.id);
          if (result) {
            seenListingIds.add(result.id);
            if (result.status === "created") progress.itemsCreated++;
            if (result.status === "updated") progress.itemsUpdated++;
          }
          progress.itemsProcessed++;
        } catch (err) {
          progress.errors.push({
            sku: listing.sku || listing.platformItemId,
            message: err instanceof Error ? err.message : "Unknown error",
          });
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
    }

    // Remove listings that were NOT seen during this sync (deleted/edited on marketplace)
    const staleCount = await removeStaleListings(integration.id, seenListingIds);
    if (staleCount > 0) {
      console.log(`[shopify-sync] Removed ${staleCount} stale listings no longer on Shopify`);
    }

    // Clean up orphaned MasterRows that have zero listings left
    const orphanCount = await removeOrphanedMasterRows();
    if (orphanCount > 0) {
      console.log(`[shopify-sync] Removed ${orphanCount} orphaned master rows with no listings`);
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
          options,
          completedAt,
        ) as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
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

export async function runShopifyWebhookReconcile(
  input: {
    productIds?: string[];
    deletedProductIds?: string[];
    changedVariantIds?: string[];
  },
  options: SyncExecutionOptions = {},
): Promise<SyncProgress> {
  const { integration, adapter } = await getShopifySyncContext();
  const productIds = [...new Set((input.productIds ?? []).filter(Boolean))];
  const deletedProductIds = [...new Set((input.deletedProductIds ?? []).filter(Boolean))];
  const changedVariantIds = [
    ...new Set(
      (input.changedVariantIds ?? []).filter(Boolean).map((variantId) => String(variantId)),
    ),
  ];
  const changedVariantIdSet = new Set(changedVariantIds);
  const startTime = Date.now();
  let prunedListings = 0;

  const syncJob = await db.syncJob.create({
    data: {
      integrationId: integration.id,
      status: "RUNNING",
      triggeredBy: options.triggeredBy ?? "webhook:incremental",
      startedAt: new Date(),
    },
  });

  const progress = createSyncProgress(syncJob.id);

  try {
    for (const productId of productIds) {
      const listings = await adapter.fetchListingsByProductId(productId);
      const presentVariantIds = listings.map((listing) => listing.platformVariantId ?? "");
      const targetedListings =
        changedVariantIdSet.size > 0
          ? listings.filter((listing) => {
              const variantId = listing.platformVariantId ?? "";
              return changedVariantIdSet.has(variantId);
            })
          : listings;

      for (const listing of targetedListings) {
        try {
          const result = await upsertListing(listing, integration.id);
          if (result?.status === "created") progress.itemsCreated++;
          if (result?.status === "updated") progress.itemsUpdated++;
          progress.itemsProcessed++;
        } catch (err) {
          progress.errors.push({
            sku: listing.sku || listing.platformItemId,
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }

      const pruned = await removeMarketplaceListingsMissingFromProductSet(
        integration.id,
        productId,
        presentVariantIds,
      );
      prunedListings += pruned.deletedListings;
      progress.itemsUpdated += pruned.deletedListings;
    }

    if (deletedProductIds.length > 0) {
      const deleted = await removeMarketplaceListingsByPlatformItemIds(
        integration.id,
        deletedProductIds,
      );
      prunedListings += deleted.deletedListings;
      progress.itemsProcessed += deleted.deletedListings;
      progress.itemsUpdated += deleted.deletedListings;
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
          {
            ...options,
            requestedMode: "incremental",
            effectiveMode: "incremental",
            fallbackReason: null,
          },
          completedAt,
        ) as unknown as Prisma.InputJsonValue,
      },
    });

    await recordWebhookReconcileCompleted({
      platform: "SHOPIFY",
      integrationId: integration.id,
      syncJobId: syncJob.id,
      productIds,
      deletedProductIds,
      changedVariantIds,
      prunedListings,
      itemsProcessed: progress.itemsProcessed,
      itemsCreated: progress.itemsCreated,
      itemsUpdated: progress.itemsUpdated,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    progress.status = "FAILED";
    const errorMessage = err instanceof Error ? err.message : "Sync failed";

    const allErrors = [
      ...progress.errors,
      { sku: "_global", message: errorMessage },
    ];

    await db.syncJob.update({
      where: { id: syncJob.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        itemsProcessed: progress.itemsProcessed,
        itemsCreated: progress.itemsCreated,
        itemsUpdated: progress.itemsUpdated,
        errors: JSON.parse(JSON.stringify(allErrors)),
      },
    });

    await recordWebhookReconcileFailed({
      platform: "SHOPIFY",
      integrationId: integration.id,
      syncJobId: syncJob.id,
      productIds,
      deletedProductIds,
      changedVariantIds,
      prunedListings,
      itemsProcessed: progress.itemsProcessed,
      itemsCreated: progress.itemsCreated,
      itemsUpdated: progress.itemsUpdated,
      durationMs: Date.now() - startTime,
      error: errorMessage,
    });
  }

  return progress;
}

async function upsertListing(
  listing: RawListing,
  integrationId: string,
): Promise<{ id: string; status: "created" | "updated" } | null> {
  const sku = listing.sku?.trim();
  if (!sku) return null;

  let masterRow = await db.masterRow.findUnique({ where: { sku } });

  if (!masterRow) {
    masterRow = await db.masterRow.create({
      data: {
        sku,
        title: listing.title || null,
        upc: listing.upc || null,
        imageUrl: listing.imageUrl || null,
        imageSource: "SHOPIFY",
      },
    });
  } else {
    const updates: Record<string, unknown> = {};
    if (!masterRow.title && listing.title) updates.title = listing.title;
    if (!masterRow.upc && listing.upc) updates.upc = listing.upc;
    if (!masterRow.imageUrl && listing.imageUrl) {
      updates.imageUrl = listing.imageUrl;
      updates.imageSource = "SHOPIFY";
    }
    if (Object.keys(updates).length > 0) {
      masterRow = await db.masterRow.update({
        where: { id: masterRow.id },
        data: updates,
      });
    }
  }

  const existing = await db.marketplaceListing.findFirst({
    where: {
      integrationId,
      platformItemId: String(listing.platformItemId),
      platformVariantId: listing.platformVariantId
        ? String(listing.platformVariantId)
        : null,
    },
  });

  const listingData = {
    masterRowId: masterRow.id,
    integrationId,
    platformItemId: String(listing.platformItemId),
    platformVariantId: listing.platformVariantId
      ? String(listing.platformVariantId)
      : null,
    sku,
    title: listing.title || null,
    imageUrl: listing.imageUrl || null,
    salePrice: listing.salePrice ?? null,
    adRate: listing.adRate ?? null,
    inventory: listing.inventory ?? null,
    status: listing.inventory && listing.inventory > 0 ? "ACTIVE" as const : "OUT_OF_STOCK" as const,
    isVariation: listing.isVariation,
    rawData: JSON.parse(JSON.stringify(listing.rawData ?? {})),
    lastSyncedAt: new Date(),
  };

  if (existing) {
    await db.marketplaceListing.update({
      where: { id: existing.id },
      data: listingData,
    });
    return { id: existing.id, status: "updated" };
  } else {
    const created = await db.marketplaceListing.create({
      data: listingData,
    });
    return { id: created.id, status: "created" };
  }
}

async function removeStaleListings(integrationId: string, seenIds: Set<string>): Promise<number> {
  const allListings = await db.marketplaceListing.findMany({
    where: { integrationId },
    select: { id: true },
  });

  const staleIds = allListings.filter((l) => !seenIds.has(l.id)).map((l) => l.id);
  if (staleIds.length === 0) return 0;

  // Delete staged changes tied to stale listings first
  await db.stagedChange.deleteMany({
    where: { marketplaceListingId: { in: staleIds } },
  });

  const { count } = await db.marketplaceListing.deleteMany({
    where: { id: { in: staleIds } },
  });

  return count;
}

async function removeOrphanedMasterRows(): Promise<number> {
  const orphans = await db.masterRow.findMany({
    where: {
      isActive: true,
      listings: { none: {} },
    },
    select: { id: true },
  });

  if (orphans.length === 0) return 0;

  const orphanIds = orphans.map((o) => o.id);

  await db.stagedChange.deleteMany({
    where: { masterRowId: { in: orphanIds } },
  });

  const { count } = await db.masterRow.deleteMany({
    where: { id: { in: orphanIds } },
  });

  return count;
}
