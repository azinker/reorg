import { db } from "@/lib/db";
import { Platform, Prisma } from "@prisma/client";
import type { MarketplaceAdapter } from "@/lib/integrations/types";
import {
  getIntegrationConfig,
  mergeIntegrationConfig,
  type CatalogPullResume,
} from "@/lib/integrations/runtime-config";
import { persistCatalogPullResume } from "@/lib/services/sync-resume-persist";
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
import { CATALOG_SYNC_CHUNK_BUDGET_MS } from "@/lib/services/sync-chunk-budget";
import { dispatchCatalogSyncContinuation } from "@/lib/services/sync-continuation";

export interface SyncResult {
  syncJobId: string;
  integrationId: string;
  status: "completed" | "failed" | "continuing";
  itemsProcessed: number;
  itemsCreated: number;
  itemsUpdated: number;
  unmatchedCount: number;
  errors: string[];
  durationMs: number;
}

const BC_LISTING_BATCH = 50;
const BC_PAGE_SIZE = 25;

function bigCommercePageKey(pageCursor: string | undefined): string {
  return pageCursor && pageCursor.trim() ? pageCursor : "1";
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
  options: SyncExecutionOptions = {},
): Promise<SyncResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  const resumeContinuation = options.resumeContinuation === true;

  let integration = await db.integration.findUnique({
    where: { id: integrationId },
  });

  if (!integration) {
    throw new Error(`Integration ${integrationId} not found`);
  }

  const integrationPlatform = integration.platform;

  const config = getIntegrationConfig(integration);
  const resumeState = config.syncState.catalogPullResume;

  let syncJob: { id: string };
  let pageCursor: string | undefined;
  let listingOffset: number;
  let priorProcessed = 0;
  let priorCreated = 0;
  let priorUpdated = 0;

  if (resumeContinuation) {
    if (!resumeState?.jobId) {
      throw new Error("BigCommerce catalog continuation requested but resume state is missing.");
    }
    const existing = await db.syncJob.findUnique({
      where: { id: resumeState.jobId },
    });
    if (
      !existing ||
      existing.status !== "RUNNING" ||
      existing.integrationId !== integrationId
    ) {
      throw new Error("BigCommerce catalog continuation job is not running or does not match.");
    }
    syncJob = { id: existing.id };
    pageCursor = resumeState.cursor ?? undefined;
    listingOffset = resumeState.listingOffset ?? 0;
    priorProcessed = existing.itemsProcessed;
    priorCreated = existing.itemsCreated;
    priorUpdated = existing.itemsUpdated;
  } else {
    await db.integration.update({
      where: { id: integrationId },
      data: {
        config: mergeIntegrationConfig(integrationPlatform, integration.config, {
          syncState: { catalogPullResume: null },
        }) as unknown as Prisma.InputJsonValue,
      },
    });

    pageCursor = undefined;
    listingOffset = 0;

    const createdJob = await db.syncJob.create({
      data: {
        integrationId,
        status: "RUNNING",
        triggeredBy: options.triggeredBy ?? "system",
        startedAt: new Date(),
      },
    });
    syncJob = { id: createdJob.id };
  }

  let totalProcessed = priorProcessed;
  let totalCreated = priorCreated;
  let totalUpdated = priorUpdated;
  let totalUnmatched = 0;

  const chunkStartedAt = Date.now();
  const overBudget = () => Date.now() - chunkStartedAt >= CATALOG_SYNC_CHUNK_BUDGET_MS;

  let hasMore = true;

  const scheduleContinuation = async (resume: CatalogPullResume) => {
    await persistCatalogPullResume(integrationId, integrationPlatform, resume);
    await dispatchCatalogSyncContinuation(integrationId);
  };

  const processBatch = async (batch: Awaited<ReturnType<MarketplaceAdapter["fetchListings"]>>["listings"]) => {
    const matchResult = await matchListings(
      batch,
      integrationId,
      integration!.isMaster,
    );

    const upsertResult = await upsertMarketplaceListings(
      matchResult.matched,
      integrationId,
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
  };

  try {
    if (adapter.platform !== "BIGCOMMERCE") {
      throw new Error(`Chunked runSync is only implemented for BigCommerce (got ${adapter.platform})`);
    }

    while (hasMore) {
      const result = await adapter.fetchListings({
        cursor: pageCursor,
        pageSize: BC_PAGE_SIZE,
      });

      const fullPage = result.listings;
      let pageListings =
        listingOffset > 0 ? fullPage.slice(listingOffset) : fullPage;
      const skippedOnPage = fullPage.length - pageListings.length;
      listingOffset = 0;

      const pageKey = bigCommercePageKey(pageCursor);

      for (let i = 0; i < pageListings.length; i += BC_LISTING_BATCH) {
        await throwIfSyncJobStopped(syncJob.id);

        if (overBudget()) {
          await scheduleContinuation({
            jobId: syncJob.id,
            cursor: pageKey,
            listingOffset: skippedOnPage + i,
            lastChunkAt: new Date().toISOString(),
          });
          return {
            syncJobId: syncJob.id,
            integrationId,
            status: "continuing",
            itemsProcessed: totalProcessed,
            itemsCreated: totalCreated,
            itemsUpdated: totalUpdated,
            unmatchedCount: totalUnmatched,
            errors,
            durationMs: Date.now() - startTime,
          };
        }

        const batch = pageListings.slice(i, i + BC_LISTING_BATCH);
        if (batch.length === 0) continue;
        await processBatch(batch);
      }

      pageCursor = result.nextCursor;
      hasMore = result.hasMore;

      if (hasMore && overBudget()) {
        const nextCursor = result.nextCursor;
        await scheduleContinuation({
          jobId: syncJob.id,
          cursor: nextCursor ?? null,
          listingOffset: undefined,
          lastChunkAt: new Date().toISOString(),
        });
        return {
          syncJobId: syncJob.id,
          integrationId,
          status: "continuing",
          itemsProcessed: totalProcessed,
          itemsCreated: totalCreated,
          itemsUpdated: totalUpdated,
          unmatchedCount: totalUnmatched,
          errors,
          durationMs: Date.now() - startTime,
        };
      }

      if (hasMore) {
        await new Promise((r) => setTimeout(r, 150));
      }
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

    await persistCatalogPullResume(integrationId, integrationPlatform, null);

    integration = await db.integration.findUnique({ where: { id: integrationId } });
    if (!integration) {
      throw new Error(`Integration ${integrationId} not found after sync`);
    }

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

      await persistCatalogPullResume(integrationId, integrationPlatform, null);

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
