import { Platform, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { BigCommerceAdapter } from "@/lib/integrations/bigcommerce";
import { runSync, type SyncResult } from "@/lib/services/sync";
import type { SyncExecutionOptions } from "@/lib/services/sync-control";
import { buildCompletedSyncConfigFromLatest } from "@/lib/services/sync-control";
import {
  matchListings,
  saveUnmatchedListings,
  upsertMarketplaceListings,
} from "@/lib/services/matching";
import {
  removeMarketplaceListingsByPlatformItemIds,
  removeMarketplaceListingsMissingFromProductSet,
} from "@/lib/services/listing-prune";

function getStringConfig(
  config: Record<string, unknown>,
  key: string
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function getBigCommerceSyncContext() {
  const integration = await db.integration.findUnique({
    where: { platform: Platform.BIGCOMMERCE },
  });

  if (!integration?.enabled) {
    throw new Error("BigCommerce integration is not enabled");
  }

  const config = (integration.config as Record<string, unknown>) ?? {};
  const storeHash =
    getStringConfig(config, "storeHash") ?? process.env.BIGCOMMERCE_STORE_HASH;
  const accessToken =
    getStringConfig(config, "accessToken") ??
    process.env.BIGCOMMERCE_ACCESS_TOKEN;

  if (!storeHash || !accessToken) {
    throw new Error(
      "BigCommerce credentials missing. Add storeHash and accessToken before syncing."
    );
  }

  return {
    integration,
    adapter: new BigCommerceAdapter({
      storeHash,
      accessToken,
    }),
  };
}

export async function runBigCommerceSync(
  options: SyncExecutionOptions = {},
): Promise<SyncResult> {
  const { integration, adapter } = await getBigCommerceSyncContext();

  return runSync(adapter, integration.id, options);
}

export async function runBigCommerceWebhookReconcile(
  input: {
    productIds?: string[];
    deletedProductIds?: string[];
    changedVariantIds?: string[];
  },
  options: SyncExecutionOptions = {},
): Promise<SyncResult> {
  const { integration, adapter } = await getBigCommerceSyncContext();
  const productIds = [...new Set((input.productIds ?? []).filter(Boolean))];
  const deletedProductIds = [...new Set((input.deletedProductIds ?? []).filter(Boolean))];
  const changedVariantIds = new Set(
    (input.changedVariantIds ?? []).filter(Boolean).map((variantId) => String(variantId)),
  );
  const startTime = Date.now();
  const errors: string[] = [];

  const syncJob = await db.syncJob.create({
    data: {
      integrationId: integration.id,
      status: "RUNNING",
      triggeredBy: options.triggeredBy ?? "webhook:incremental",
      startedAt: new Date(),
    },
  });

  let totalProcessed = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalUnmatched = 0;

  try {
    for (const productId of productIds) {
      const listings = await adapter.fetchListingsByProductId(productId);
      const presentVariantIds = listings.map((listing) => listing.platformVariantId ?? "");
      const targetedListings =
        changedVariantIds.size > 0
          ? listings.filter((listing) => {
              const variantId = listing.platformVariantId ?? "";
              return changedVariantIds.has(variantId);
            })
          : listings;
      const matchResult = await matchListings(
        targetedListings,
        integration.id,
        integration.isMaster,
      );

      const upsertResult = await upsertMarketplaceListings(
        matchResult.matched,
        integration.id,
      );

      if (matchResult.unmatched.length > 0) {
        await saveUnmatchedListings(matchResult.unmatched, integration.id);
      }

      totalProcessed += targetedListings.length;
      totalCreated += upsertResult.created;
      totalUpdated += upsertResult.updated;
      totalUnmatched += matchResult.stats.unmatched;

      const pruned = await removeMarketplaceListingsMissingFromProductSet(
        integration.id,
        productId,
        presentVariantIds,
      );
      totalUpdated += pruned.deletedListings;
    }

    if (deletedProductIds.length > 0) {
      const deleted = await removeMarketplaceListingsByPlatformItemIds(
        integration.id,
        deletedProductIds,
      );
      totalProcessed += deleted.deletedListings;
      totalUpdated += deleted.deletedListings;
    }

    const completedAt = new Date();
    await db.syncJob.update({
      where: { id: syncJob.id },
      data: {
        status: "COMPLETED",
        itemsProcessed: totalProcessed,
        itemsCreated: totalCreated,
        itemsUpdated: totalUpdated,
        completedAt,
        errors,
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

    return {
      syncJobId: syncJob.id,
      integrationId: integration.id,
      status: "completed",
      itemsProcessed: totalProcessed,
      itemsCreated: totalCreated,
      itemsUpdated: totalUpdated,
      unmatchedCount: totalUnmatched,
      errors,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown sync error";
    errors.push(errorMessage);

    await db.syncJob.update({
      where: { id: syncJob.id },
      data: {
        status: "FAILED",
        itemsProcessed: totalProcessed,
        itemsCreated: totalCreated,
        itemsUpdated: totalUpdated,
        errors,
        completedAt: new Date(),
      },
    });

    return {
      syncJobId: syncJob.id,
      integrationId: integration.id,
      status: "failed",
      itemsProcessed: totalProcessed,
      itemsCreated: totalCreated,
      itemsUpdated: totalUpdated,
      unmatchedCount: totalUnmatched,
      errors,
      durationMs: Date.now() - startTime,
    };
  }
}
