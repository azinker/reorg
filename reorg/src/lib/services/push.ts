import { db } from "@/lib/db";
import { checkWriteSafety } from "@/lib/safety";
import type { MarketplaceAdapter, PriceUpdate, AdRateUpdate } from "@/lib/integrations/types";
import type { Integration, Platform } from "@prisma/client";
import {
  getEbayCooldownUntilFromSnapshot,
  getEbayCredentialFingerprint,
  getEbayMethodRate,
  getEbayTradingRateLimitSnapshotForIntegration,
} from "@/lib/services/ebay-analytics";
import {
  getBaseEbayGetItemReserve,
  getTargetedRefreshReserve,
} from "@/lib/services/ebay-sync-policy";
import { getSharedEbayQuotaStoreCount } from "@/lib/services/ebay-sync-budget";
import { formatCooldownRetryAt } from "@/lib/services/ebay-rate-limit";
import { startIntegrationSync } from "@/lib/services/sync-control";

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
  postPushRefresh?: {
    status:
      | "not-needed"
      | "ready"
      | "warning"
      | "blocked"
      | "completed"
      | "failed";
    detail: string;
    retryAt?: string | null;
    requiredCalls?: number | null;
    availableCalls?: number | null;
    results?: Array<{
      platform: Platform;
      label: string;
      status:
        | "COMPLETED"
        | "FAILED"
        | "ALREADY_RUNNING"
        | "UNSUPPORTED"
        | "STARTED";
      jobId: string | null;
      message: string;
      targetedCount: number;
    }>;
  };
}

const EBAY_PUSH_PLATFORMS = new Set<Platform>(["TPP_EBAY", "TT_EBAY"]);

async function evaluatePostPushRefreshHeadroom(
  byPlatform: Map<Platform, PushChangeItem[]>,
  dryRun: boolean,
): Promise<PushExecutionResult["postPushRefresh"]> {
  const ebayPlatforms = [...byPlatform.keys()].filter((platform) =>
    EBAY_PUSH_PLATFORMS.has(platform),
  );
  if (ebayPlatforms.length === 0) {
    return {
      status: "not-needed",
      detail: "No eBay targeted refresh headroom is needed for this push.",
      retryAt: null,
      requiredCalls: 0,
      availableCalls: null,
    };
  }

  const integrations = await db.integration.findMany({
    where: { platform: { in: ebayPlatforms } },
    select: {
      id: true,
      platform: true,
      label: true,
      config: true,
    },
  });

  const groupMap = new Map<
    string,
    {
      integration: (typeof integrations)[number];
      labels: string[];
      requiredCalls: number;
    }
  >();

  for (const integration of integrations) {
    const fingerprint =
      getEbayCredentialFingerprint(integration) ?? `platform:${integration.platform}`;
    const changes = byPlatform.get(integration.platform) ?? [];
    const requiredCalls = new Set(
      changes.map((change) => `${integration.platform}:${change.listingId}`),
    ).size;
    if (requiredCalls === 0) continue;

    const existing = groupMap.get(fingerprint);
    if (existing) {
      existing.labels.push(integration.label);
      existing.requiredCalls += requiredCalls;
      continue;
    }

    groupMap.set(fingerprint, {
      integration,
      labels: [integration.label],
      requiredCalls,
    });
  }

  if (groupMap.size === 0) {
    return {
      status: "not-needed",
      detail: "No eBay targeted refresh headroom is needed for this push.",
      retryAt: null,
      requiredCalls: 0,
      availableCalls: null,
    };
  }

  const warnings: string[] = [];
  let blockedReason: string | null = null;
  let retryAt: string | null = null;
  let totalRequiredCalls = 0;
  let totalAvailableCalls = 0;

  for (const group of groupMap.values()) {
    totalRequiredCalls += group.requiredCalls;

    const snapshot = await getEbayTradingRateLimitSnapshotForIntegration(
      group.integration,
    ).catch(() => null);

    if (!snapshot) {
      const detail = `${group.labels.join(" + ")} could not verify live eBay Trading API headroom for the post-push refresh.`;
      if (!dryRun) {
        blockedReason = `${detail} Wait for eBay quota visibility to recover before running a live push.`;
        break;
      }
      warnings.push(`${detail} The dry run can continue, but the live push should wait.`);
      continue;
    }

    const getItemRate = getEbayMethodRate(snapshot, "GetItem");
    if (!getItemRate || getItemRate.limit <= 0) {
      const detail = `${group.labels.join(" + ")} returned no usable GetItem quota data for the post-push refresh check.`;
      if (!dryRun) {
        blockedReason = `${detail} Wait for eBay quota visibility to recover before running a live push.`;
        break;
      }
      warnings.push(`${detail} The dry run can continue, but the live push should wait.`);
      continue;
    }

    const sharedStoreCount = await getSharedEbayQuotaStoreCount(group.integration);
    const cooldownUntil = getEbayCooldownUntilFromSnapshot(
      snapshot,
      "GetItem",
      new Date(),
    );
    const baseReserve = getBaseEbayGetItemReserve(getItemRate.limit);
    const targetedReserve = getTargetedRefreshReserve(
      getItemRate.limit,
      sharedStoreCount,
    );
    const availableForTargetedRefresh = Math.max(
      0,
      getItemRate.remaining - baseReserve,
    );
    totalAvailableCalls += availableForTargetedRefresh;

    if (cooldownUntil || getItemRate.remaining <= 0) {
      const cooldownLabel = formatCooldownRetryAt(cooldownUntil);
      blockedReason = cooldownLabel
        ? `${group.labels.join(" + ")} are still inside the eBay GetItem cooldown window. Wait until about ${cooldownLabel} before running a live push so the post-push refresh can complete.`
        : `${group.labels.join(" + ")} are still inside the eBay GetItem cooldown window. Wait for the next eBay reset before running a live push.`;
      retryAt = cooldownUntil?.toISOString() ?? null;
      break;
    }

    if (group.requiredCalls > targetedReserve) {
      blockedReason =
        `${group.labels.join(" + ")} would need about ${group.requiredCalls.toLocaleString()} ` +
        `targeted GetItem refreshes after this push, but the protected fast-refresh reserve for ` +
        `that shared eBay app is only ${targetedReserve.toLocaleString()} calls. Split the push ` +
        `into smaller batches so the post-push refresh can stay fast and safe.`;
      break;
    }

    if (availableForTargetedRefresh < group.requiredCalls) {
      blockedReason =
        `${group.labels.join(" + ")} only have about ${availableForTargetedRefresh.toLocaleString()} ` +
        `GetItem calls available above the protected base reserve, but this push would need about ` +
        `${group.requiredCalls.toLocaleString()} targeted refresh calls to reflect quickly afterward.`;
      retryAt = snapshot.nextResetAt;
      break;
    }
  }

  if (blockedReason) {
    return {
      status: dryRun ? "warning" : "blocked",
      detail: blockedReason,
      retryAt,
      requiredCalls: totalRequiredCalls,
      availableCalls: totalAvailableCalls || null,
    };
  }

  if (warnings.length > 0) {
    return {
      status: "warning",
      detail: warnings.join(" "),
      retryAt: null,
      requiredCalls: totalRequiredCalls,
      availableCalls: totalAvailableCalls || null,
    };
  }

  return {
    status: "ready",
    detail:
      totalRequiredCalls > 0
        ? `Protected eBay post-push refresh headroom is available for about ${totalRequiredCalls.toLocaleString()} targeted listing refreshes.`
        : "Protected eBay post-push refresh headroom is available.",
    retryAt: null,
    requiredCalls: totalRequiredCalls,
    availableCalls: totalAvailableCalls,
  };
}

async function executePostPushTargetedRefresh(args: {
  pushJobId: string;
  results: PushExecutionResult["results"];
}): Promise<PushExecutionResult["postPushRefresh"]> {
  const targetedByPlatform = new Map<Platform, Set<string>>();

  for (const result of args.results) {
    if (!result.success || !EBAY_PUSH_PLATFORMS.has(result.platform)) {
      continue;
    }

    const existing = targetedByPlatform.get(result.platform) ?? new Set<string>();
    existing.add(result.listingId);
    targetedByPlatform.set(result.platform, existing);
  }

  if (targetedByPlatform.size === 0) {
    return {
      status: "not-needed",
      detail: "No successful eBay listing updates needed a post-push targeted refresh.",
      retryAt: null,
      requiredCalls: 0,
      availableCalls: null,
      results: [],
    };
  }

  const integrations = await db.integration.findMany({
    where: { platform: { in: [...targetedByPlatform.keys()] } },
    orderBy: { platform: "asc" },
  });

  const refreshResults: NonNullable<PushExecutionResult["postPushRefresh"]>["results"] =
    [];
  let completedCount = 0;
  let failedCount = 0;
  let runningCount = 0;

  for (const integration of integrations) {
    const targetedItemIds = [...(targetedByPlatform.get(integration.platform) ?? new Set())];
    if (targetedItemIds.length === 0) {
      continue;
    }

    const dispatch = await startIntegrationSync(
      integration as Integration,
      {
        requestedMode: "incremental",
        effectiveMode: "incremental",
        triggerSource: "push",
        triggeredBy: `push:targeted_refresh:${args.pushJobId}`,
        fallbackReason:
          `Post-push targeted refresh requested for ${targetedItemIds.length.toLocaleString()} ` +
          `eBay listing${targetedItemIds.length === 1 ? "" : "s"}.`,
        targetedPlatformItemIds: targetedItemIds,
        preserveSyncState: true,
      },
      "inline",
    );

    refreshResults.push({
      platform: integration.platform,
      label: integration.label,
      status: dispatch.status,
      jobId: dispatch.jobId,
      message: dispatch.message,
      targetedCount: targetedItemIds.length,
    });

    if (dispatch.status === "COMPLETED") {
      completedCount += 1;
    } else if (dispatch.status === "ALREADY_RUNNING") {
      runningCount += 1;
    } else {
      failedCount += 1;
    }
  }

  const labels = refreshResults.map((result) => result.label);
  const detailBase =
    labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;

  if (failedCount > 0) {
    return {
      status: "failed",
      detail: `Post-push targeted refresh failed for ${detailBase}. Review Sync or Engine Room before trusting the live readback.`,
      retryAt: null,
      results: refreshResults,
    };
  }

  if (runningCount > 0) {
    return {
      status: "warning",
      detail: `A sync was already running for ${detailBase}, so reorG relied on that in-flight pull to refresh the pushed eBay listings.`,
      retryAt: null,
      results: refreshResults,
    };
  }

  return {
    status: completedCount > 0 ? "completed" : "not-needed",
    detail:
      completedCount > 0
        ? `Post-push targeted refresh completed for ${detailBase}.`
        : "No successful eBay listing updates needed a post-push targeted refresh.",
    retryAt: null,
    results: refreshResults,
  };
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

  const postPushRefresh = await evaluatePostPushRefreshHeadroom(
    byPlatform,
    request.dryRun,
  );
  if (!request.dryRun && postPushRefresh?.status === "blocked") {
    return {
      pushJobId: "",
      dryRun: false,
      status: "blocked",
      results: [],
      blockedReason: postPushRefresh.detail,
      postPushRefresh,
    };
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
        result: { dryRun: true, results, postPushRefresh },
        completedAt: new Date(),
      },
    });

    return {
      pushJobId: pushJob.id,
      dryRun: true,
      status: "completed",
      results,
      postPushRefresh,
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
  const completedPostPushRefresh =
    status === "completed" || results.some((result) => result.success)
      ? await executePostPushTargetedRefresh({
          pushJobId: pushJob.id,
          results,
        })
      : postPushRefresh;

  await db.pushJob.update({
    where: { id: pushJob.id },
    data: {
      status: status === "completed" ? "COMPLETED" : "FAILED",
      result: { results, postPushRefresh: completedPostPushRefresh },
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
        postPushRefresh: completedPostPushRefresh ?? null,
      },
    },
  });

  return {
    pushJobId: pushJob.id,
    dryRun: false,
    status,
    results,
    postPushRefresh: completedPostPushRefresh,
  };
}
