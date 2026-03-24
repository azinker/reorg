import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import type { MarketplaceAdapter } from "@/lib/integrations/types";
import {
  matchListings,
  upsertMarketplaceListings,
  saveUnmatchedListings,
} from "@/lib/services/matching";
import {
  buildCompletedSyncConfigFromLatest,
  type SyncExecutionOptions,
} from "@/lib/services/sync-control";
import { repairVariationFamiliesForIntegration } from "@/lib/services/variation-repair";
import {
  SYNC_CANCELLED_ERROR,
  throwIfSyncJobStopped,
} from "@/lib/services/sync-jobs";

export interface SyncResult {
  syncJobId: string;
  integrationId: string;
  status: "completed" | "failed";
  itemsProcessed: number;
  itemsCreated: number;
  itemsUpdated: number;
  unmatchedCount: number;
  errors: string[];
  durationMs: number;
}

/**
 * Execute a pull-only sync for a single integration.
 * 
 * SAFETY: This function NEVER writes to marketplaces.
 * It ONLY reads from the marketplace API and writes to the local database.
 * It NEVER touches StagedChange records.
 */
export async function runSync(
  adapter: MarketplaceAdapter,
  integrationId: string,
  options: SyncExecutionOptions = {}
): Promise<SyncResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  const syncJob = await db.syncJob.create({
    data: {
      integrationId,
      status: "RUNNING",
      triggeredBy: options.triggeredBy ?? "system",
      startedAt: new Date(),
    },
  });

  const integration = await db.integration.findUnique({
    where: { id: integrationId },
  });

  if (!integration) {
    throw new Error(`Integration ${integrationId} not found`);
  }

  let totalProcessed = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalUnmatched = 0;

  try {
    for await (const batch of adapter.fetchAllListings()) {
      await throwIfSyncJobStopped(syncJob.id);

      const matchResult = await matchListings(
        batch,
        integrationId,
        integration.isMaster
      );

      const upsertResult = await upsertMarketplaceListings(
        matchResult.matched,
        integrationId
      );

      if (matchResult.unmatched.length > 0) {
        await saveUnmatchedListings(matchResult.unmatched, integrationId);
      }

      totalProcessed += batch.length;
      totalCreated += upsertResult.created;
      totalUpdated += upsertResult.updated;
      totalUnmatched += matchResult.stats.unmatched;

      await db.syncJob.update({
        where: { id: syncJob.id },
        data: {
          itemsProcessed: totalProcessed,
          itemsCreated: totalCreated,
          itemsUpdated: totalUpdated,
        },
      });
    }

    const completedAt = new Date();
    await throwIfSyncJobStopped(syncJob.id);
    await db.syncJob.update({
      where: { id: syncJob.id },
      data: {
        status: "COMPLETED",
        itemsProcessed: totalProcessed,
        itemsCreated: totalCreated,
        itemsUpdated: totalUpdated,
        completedAt,
        errors: errors,
      },
    });

    await db.integration.update({
      where: { id: integrationId },
      data: {
        lastSyncAt: completedAt,
        config: await buildCompletedSyncConfigFromLatest(
          integration,
          options,
          completedAt,
        ) as unknown as Prisma.InputJsonValue,
      },
    });

    await db.auditLog.create({
      data: {
        action: "sync_completed",
        entityType: "integration",
        entityId: integrationId,
        details: {
          syncJobId: syncJob.id,
          itemsProcessed: totalProcessed,
          itemsCreated: totalCreated,
          itemsUpdated: totalUpdated,
          unmatchedCount: totalUnmatched,
          durationMs: Date.now() - startTime,
        },
      },
    });

    try {
      await repairVariationFamiliesForIntegration(integrationId);
    } catch (repairError) {
      await db.auditLog.create({
        data: {
          action: "variation_repair_failed",
          entityType: "integration",
          entityId: integrationId,
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

    return {
      syncJobId: syncJob.id,
      integrationId,
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
    const wasCancelled = errorMessage === SYNC_CANCELLED_ERROR;
    errors.push(errorMessage);

    if (!wasCancelled) {
      await db.syncJob.update({
        where: { id: syncJob.id },
        data: {
          status: "FAILED",
          itemsProcessed: totalProcessed,
          errors,
          completedAt: new Date(),
        },
      });

      await db.auditLog.create({
        data: {
          action: "sync_failed",
          entityType: "integration",
          entityId: integrationId,
          details: {
            syncJobId: syncJob.id,
            error: errorMessage,
            durationMs: Date.now() - startTime,
          },
        },
      });
    }

    return {
      syncJobId: syncJob.id,
      integrationId,
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
