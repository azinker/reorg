import { db } from "@/lib/db";
import { checkWriteSafety } from "@/lib/safety";
import type { MarketplaceAdapter, PriceUpdate, AdRateUpdate } from "@/lib/integrations/types";
import type { Platform } from "@prisma/client";

export interface PushRequest {
  userId: string;
  changes: PushChangeItem[];
  dryRun: boolean;
}

export interface PushChangeItem {
  stagedChangeId: string;
  masterRowId: string;
  marketplaceListingId: string;
  platform: Platform;
  listingId: string;
  field: "salePrice" | "adRate";
  oldValue: number | null;
  newValue: number;
}

export interface PushExecutionResult {
  pushJobId: string;
  dryRun: boolean;
  status: "completed" | "failed" | "blocked";
  results: {
    platform: Platform;
    listingId: string;
    field: string;
    success: boolean;
    error?: string;
  }[];
  blockedReason?: string;
}

/**
 * Execute a push operation through the full safety chain:
 * 1. Check global write lock
 * 2. Check per-integration write lock
 * 3. Check environment
 * 4. If dryRun, validate only
 * 5. If live, push to marketplace and audit
 *
 * SAFETY: No push happens without explicit user request through this function.
 * SAFETY: No delete operations exist in this codebase.
 */
export async function executePush(
  request: PushRequest,
  adapters: Map<Platform, MarketplaceAdapter>
): Promise<PushExecutionResult> {
  const results: PushExecutionResult["results"] = [];

  // Group changes by platform
  const byPlatform = new Map<Platform, PushChangeItem[]>();
  for (const change of request.changes) {
    const existing = byPlatform.get(change.platform) ?? [];
    existing.push(change);
    byPlatform.set(change.platform, existing);
  }

  // Check write safety for each platform
  for (const platform of byPlatform.keys()) {
    const safety = await checkWriteSafety(platform);
    if (!safety.allowed) {
      return {
        pushJobId: "",
        dryRun: request.dryRun,
        status: "blocked",
        results: [],
        blockedReason: safety.reason,
      };
    }
  }

  // Create push job record
  const pushJob = await db.pushJob.create({
    data: {
      userId: request.userId,
      dryRun: request.dryRun,
      status: request.dryRun ? "DRY_RUN" : "EXECUTING",
      payload: request.changes as unknown as object[],
    },
  });

  // If dry run, validate and return without pushing
  if (request.dryRun) {
    for (const change of request.changes) {
      results.push({
        platform: change.platform,
        listingId: change.listingId,
        field: change.field,
        success: true,
      });
    }

    await db.pushJob.update({
      where: { id: pushJob.id },
      data: {
        status: "COMPLETED",
        result: { dryRun: true, results },
        completedAt: new Date(),
      },
    });

    return {
      pushJobId: pushJob.id,
      dryRun: true,
      status: "completed",
      results,
    };
  }

  // Execute live push per platform
  for (const [platform, changes] of byPlatform) {
    const adapter = adapters.get(platform);
    if (!adapter) {
      for (const change of changes) {
        results.push({
          platform,
          listingId: change.listingId,
          field: change.field,
          success: false,
          error: `No adapter configured for ${platform}`,
        });
      }
      continue;
    }

    // Separate price and ad rate updates
    const priceUpdates: PriceUpdate[] = changes
      .filter((c) => c.field === "salePrice")
      .map((c) => ({
        platformItemId: c.listingId,
        newPrice: c.newValue,
      }));

    const adRateUpdates: AdRateUpdate[] = changes
      .filter((c) => c.field === "adRate")
      .map((c) => ({
        platformItemId: c.listingId,
        newAdRate: c.newValue,
      }));

    if (priceUpdates.length > 0) {
      const priceResult = await adapter.pushPriceUpdates(priceUpdates);
      for (const update of priceUpdates) {
        const error = priceResult.errors.find(
          (e) => e.platformItemId === update.platformItemId
        );
        results.push({
          platform,
          listingId: update.platformItemId,
          field: "salePrice",
          success: !error,
          error: error?.message,
        });
      }
    }

    if (adRateUpdates.length > 0) {
      const adResult = await adapter.pushAdRateUpdates(adRateUpdates);
      for (const update of adRateUpdates) {
        const error = adResult.errors.find(
          (e) => e.platformItemId === update.platformItemId
        );
        results.push({
          platform,
          listingId: update.platformItemId,
          field: "adRate",
          success: !error,
          error: error?.message,
        });
      }
    }
  }

  // Update staged changes for successful pushes
  const successfulIds = results
    .filter((r) => r.success)
    .map((r) => r.listingId);

  for (const change of request.changes) {
    if (successfulIds.includes(change.listingId)) {
      await db.stagedChange.update({
        where: { id: change.stagedChangeId },
        data: { status: "PUSHED", pushedAt: new Date() },
      });
    }
  }

  const status = results.every((r) => r.success) ? "completed" : "failed";

  await db.pushJob.update({
    where: { id: pushJob.id },
    data: {
      status: status === "completed" ? "COMPLETED" : "FAILED",
      result: { results },
      completedAt: new Date(),
    },
  });

  // Audit log
  await db.auditLog.create({
    data: {
      userId: request.userId,
      action: "push_executed",
      entityType: "push_job",
      entityId: pushJob.id,
      details: {
        totalChanges: request.changes.length,
        successful: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
      },
    },
  });

  return {
    pushJobId: pushJob.id,
    dryRun: false,
    status,
    results,
  };
}
