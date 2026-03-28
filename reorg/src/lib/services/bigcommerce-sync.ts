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
import {
  recordWebhookReconcileCompleted,
  recordWebhookReconcileFailed,
} from "@/lib/services/webhook-reconcile-audit";
import { repairVariationFamiliesForIntegration } from "@/lib/services/variation-repair";

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
  const changedVariantIds = [
    ...new Set(
      (input.changedVariantIds ?? []).filter(Boolean).map((variantId) => String(variantId)),
    ),
  ];
  const changedVariantIdSet = new Set(changedVariantIds);
  const startTime = Date.now();
  const errors: string[] = [];
  let prunedListings = 0;

  const syncJob = options.existingJobId
    ? await db.syncJob.findUniqueOrThrow({ where: { id: options.existingJobId } })
    : await db.syncJob.create({
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
      const presentVariantIds = [
        ...(listings.some((listing) => listing.isVariation) ? [""] : []),
        ...listings.map((listing) => listing.platformVariantId ?? ""),
      ];
      const targetedListings =
        changedVariantIdSet.size > 0
          ? listings.filter((listing) => {
              const variantId = listing.platformVariantId ?? "";
              return changedVariantIdSet.has(variantId);
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

      totalProcessed++;
      totalCreated += upsertResult.created;
      totalUpdated += upsertResult.updated;
      totalUnmatched += matchResult.stats.unmatched;

      const pruned = await removeMarketplaceListingsMissingFromProductSet(
        integration.id,
        productId,
        presentVariantIds,
      );
      prunedListings += pruned.deletedListings;
      totalUpdated += pruned.deletedListings;
    }

    if (deletedProductIds.length > 0) {
      const deleted = await removeMarketplaceListingsByPlatformItemIds(
        integration.id,
        deletedProductIds,
      );
      prunedListings += deleted.deletedListings;
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

    if (!options.skipHeavyOperations) {
      try {
        await repairVariationFamiliesForIntegration(integration.id);
      } catch (repairError) {
        await db.auditLog.create({
          data: {
            action: "variation_repair_failed",
            entityType: "integration",
            entityId: integration.id,
            details: {
              syncJobId: syncJob.id,
              error:
                repairError instanceof Error
                  ? repairError.message
                  : "Unknown variation repair error",
            },
          },
        });
      }
    }

    const durationMs = Date.now() - startTime;
    await recordWebhookReconcileCompleted({
      platform: "BIGCOMMERCE",
      integrationId: integration.id,
      syncJobId: syncJob.id,
      productIds,
      deletedProductIds,
      changedVariantIds,
      prunedListings,
      itemsProcessed: totalProcessed,
      itemsCreated: totalCreated,
      itemsUpdated: totalUpdated,
      durationMs,
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
      durationMs,
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

    const durationMs = Date.now() - startTime;
    await recordWebhookReconcileFailed({
      platform: "BIGCOMMERCE",
      integrationId: integration.id,
      syncJobId: syncJob.id,
      productIds,
      deletedProductIds,
      changedVariantIds,
      prunedListings,
      itemsProcessed: totalProcessed,
      itemsCreated: totalCreated,
      itemsUpdated: totalUpdated,
      durationMs,
      error: errorMessage,
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
      durationMs,
    };
  }
}
