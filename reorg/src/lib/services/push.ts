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
import { createBackup } from "@/lib/services/backup";
import { getMissingR2EnvVars, isR2Configured } from "@/lib/r2";
import { runBigCommerceWebhookReconcile } from "@/lib/services/bigcommerce-sync";
import { runShopifyWebhookReconcile } from "@/lib/services/shopify-sync";

export interface PushRequest {
  userId: string;
  changes: PushChangeItem[];
  dryRun: boolean;
}

export interface PushChangeItem {
  stagedChangeId?: string | null;
  masterRowId: string;
  marketplaceListingId: string;
  platformVariantId?: string | null;
  platform: Platform;
  listingId: string;
  field: "salePrice" | "adRate";
  oldValue: number | null;
  newValue: number;
}

export interface PushExecutionResult {
  pushJobId: string;
  dryRun: boolean;
  status: "completed" | "partial" | "failed" | "blocked";
  summary: {
    totalChanges: number;
    distinctListings: number;
    successfulChanges: number;
    failedChanges: number;
    successfulListings: number;
    failedListings: number;
    affectedPlatforms: Platform[];
    byPlatform: Array<{
      platform: Platform;
      changes: number;
      distinctListings: number;
      fields: Array<"salePrice" | "adRate">;
    }>;
  };
  results: {
    stagedChangeId: string | null;
    masterRowId: string;
    marketplaceListingId: string;
    platformVariantId?: string | null;
    platform: Platform;
    listingId: string;
    field: string;
    oldValue: number | null;
    newValue: number;
    success: boolean;
    error?: string;
  }[];
  blockedReason?: string;
  batchSafety?: {
    status: "ready" | "warning" | "blocked";
    detail: string;
    recommendedListings: number;
    hardListings: number;
    recommendedChanges: number;
    hardChanges: number;
  };
  goLiveChecklist?: Array<{
    key: "write-safety" | "batch-size" | "pre-push-backup" | "confirmation" | "post-push-refresh";
    label: string;
    status: "ready" | "warning" | "blocked" | "completed";
    detail: string;
  }>;
  prePushBackup?: {
    status: "not-needed" | "ready" | "completed" | "warning" | "blocked" | "failed";
    detail: string;
    backupId?: string | null;
    missingEnvVars?: string[];
    required?: boolean;
  };
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
const TARGETED_READBACK_PLATFORMS = new Set<Platform>(["BIGCOMMERCE", "SHOPIFY"]);
const PRE_PUSH_BACKUP_LISTING_THRESHOLD = 10;
const RECOMMENDED_LIVE_PUSH_LISTINGS = 25;
const HARD_LIVE_PUSH_LISTINGS = 50;
const RECOMMENDED_LIVE_PUSH_CHANGES = 50;
const HARD_LIVE_PUSH_CHANGES = 100;

function matchesPushChange(
  change: PushChangeItem,
  field: PushChangeItem["field"],
  listingId: string,
  platformVariantId?: string | null,
) {
  if (change.field !== field || change.listingId !== listingId) {
    return false;
  }

  if (platformVariantId != null) {
    return (change.platformVariantId ?? null) === platformVariantId;
  }

  return true;
}

function buildPushSummary(byPlatform: Map<Platform, PushChangeItem[]>, results?: PushExecutionResult["results"]) {
  const listingKeys = new Set(
    [...byPlatform.values()].flatMap((changes) =>
      changes.map((change) => `${change.platform}:${change.listingId}`),
    ),
  );
  const successfulListingKeys = results
    ? new Set(
        results
          .filter((result) => result.success)
          .map((result) => `${result.platform}:${result.listingId}`),
      )
    : new Set<string>();
  const failedListingKeys = results
    ? new Set(
        results
          .filter((result) => !result.success)
          .map((result) => `${result.platform}:${result.listingId}`),
      )
    : new Set<string>();
  const byPlatformSummary = [...byPlatform.entries()].map(([platform, changes]) => ({
    platform,
    changes: changes.length,
    distinctListings: new Set(changes.map((change) => change.marketplaceListingId)).size,
    fields: [...new Set(changes.map((change) => change.field))],
  }));

  return {
    totalChanges: [...byPlatform.values()].reduce((sum, changes) => sum + changes.length, 0),
    distinctListings: listingKeys.size,
    successfulChanges: results ? results.filter((result) => result.success).length : 0,
    failedChanges: results ? results.filter((result) => !result.success).length : 0,
    successfulListings: successfulListingKeys.size,
    failedListings: failedListingKeys.size,
    affectedPlatforms: [...byPlatform.keys()],
    byPlatform: byPlatformSummary,
  } satisfies PushExecutionResult["summary"];
}

function evaluateBatchSafety(
  summary: PushExecutionResult["summary"],
  dryRun: boolean,
): NonNullable<PushExecutionResult["batchSafety"]> {
  const tooManyListings = summary.distinctListings > HARD_LIVE_PUSH_LISTINGS;
  const tooManyChanges = summary.totalChanges > HARD_LIVE_PUSH_CHANGES;
  if (tooManyListings || tooManyChanges) {
    return {
      status: dryRun ? "warning" : "blocked",
      detail:
        `This push touches ${summary.distinctListings.toLocaleString()} listings across ${summary.totalChanges.toLocaleString()} changes. ` +
        `Live pushes are capped at ${HARD_LIVE_PUSH_LISTINGS.toLocaleString()} listings or ${HARD_LIVE_PUSH_CHANGES.toLocaleString()} changes per batch. ` +
        "Split this into smaller batches before pushing live.",
      recommendedListings: RECOMMENDED_LIVE_PUSH_LISTINGS,
      hardListings: HARD_LIVE_PUSH_LISTINGS,
      recommendedChanges: RECOMMENDED_LIVE_PUSH_CHANGES,
      hardChanges: HARD_LIVE_PUSH_CHANGES,
    };
  }

  const largeListings = summary.distinctListings > RECOMMENDED_LIVE_PUSH_LISTINGS;
  const largeChanges = summary.totalChanges > RECOMMENDED_LIVE_PUSH_CHANGES;
  if (largeListings || largeChanges) {
    return {
      status: "warning",
      detail:
        `This push is larger than the recommended safe batch size of ${RECOMMENDED_LIVE_PUSH_LISTINGS.toLocaleString()} listings or ${RECOMMENDED_LIVE_PUSH_CHANGES.toLocaleString()} changes. ` +
        "It can still run, but smaller batches are safer for first live pushes and cleaner to recover if anything fails.",
      recommendedListings: RECOMMENDED_LIVE_PUSH_LISTINGS,
      hardListings: HARD_LIVE_PUSH_LISTINGS,
      recommendedChanges: RECOMMENDED_LIVE_PUSH_CHANGES,
      hardChanges: HARD_LIVE_PUSH_CHANGES,
    };
  }

  return {
    status: "ready",
    detail:
      `This push stays within the recommended batch size (${RECOMMENDED_LIVE_PUSH_LISTINGS.toLocaleString()} listings / ${RECOMMENDED_LIVE_PUSH_CHANGES.toLocaleString()} changes).`,
    recommendedListings: RECOMMENDED_LIVE_PUSH_LISTINGS,
    hardListings: HARD_LIVE_PUSH_LISTINGS,
    recommendedChanges: RECOMMENDED_LIVE_PUSH_CHANGES,
    hardChanges: HARD_LIVE_PUSH_CHANGES,
  };
}

function buildGoLiveChecklist(args: {
  dryRun: boolean;
  writeSafetyDetail: string;
  writeSafetyStatus: "ready" | "blocked";
  batchSafety: NonNullable<PushExecutionResult["batchSafety"]>;
  prePushBackup: NonNullable<PushExecutionResult["prePushBackup"]>;
  confirmationStatus: "ready" | "completed";
  postPushRefresh: NonNullable<PushExecutionResult["postPushRefresh"]>;
}): NonNullable<PushExecutionResult["goLiveChecklist"]> {
  return [
    {
      key: "write-safety",
      label: "Write safety checks",
      status: args.writeSafetyStatus,
      detail: args.writeSafetyDetail,
    },
    {
      key: "batch-size",
      label: "Batch size",
      status: args.batchSafety.status,
      detail: args.batchSafety.detail,
    },
    {
      key: "pre-push-backup",
      label: "Pre-push backup",
      status:
        args.prePushBackup.status === "blocked" || args.prePushBackup.status === "failed"
          ? "blocked"
          : args.prePushBackup.status === "warning"
            ? "warning"
            : args.prePushBackup.status === "completed"
              ? "completed"
              : "ready",
      detail: args.prePushBackup.detail,
    },
    {
      key: "confirmation",
      label: "Explicit confirmation",
      status: args.confirmationStatus,
      detail: args.dryRun
        ? "Dry run completed. A separate explicit confirmation is still required before any live push."
        : "Live push was run only after explicit confirmation.",
    },
    {
      key: "post-push-refresh",
      label: "Post-push live readback",
      status:
        args.postPushRefresh.status === "blocked" || args.postPushRefresh.status === "failed"
          ? "blocked"
          : args.postPushRefresh.status === "warning"
            ? "warning"
            : args.postPushRefresh.status === "completed"
              ? "completed"
              : "ready",
      detail: args.postPushRefresh.detail,
    },
  ];
}

function evaluatePrePushBackupNeed(
  summary: PushExecutionResult["summary"],
  dryRun: boolean,
): NonNullable<PushExecutionResult["prePushBackup"]> {
  if (summary.distinctListings < PRE_PUSH_BACKUP_LISTING_THRESHOLD) {
    return {
      status: "not-needed",
      detail:
        `This push touches ${summary.distinctListings.toLocaleString()} listing` +
        `${summary.distinctListings === 1 ? "" : "s"}, so it stays below the automatic pre-push backup threshold.`,
      required: false,
      backupId: null,
    };
  }

  if (!isR2Configured()) {
    return {
      status: dryRun ? "warning" : "blocked",
      detail:
        `This push touches ${summary.distinctListings.toLocaleString()} listings, so a pre-push backup is required before a live write can run. ` +
        "Cloudflare R2 is not configured yet, so the live push would be blocked.",
      backupId: null,
      required: true,
      missingEnvVars: getMissingR2EnvVars(),
    };
  }

  return {
    status: dryRun ? "ready" : "not-needed",
    detail:
      `This push touches ${summary.distinctListings.toLocaleString()} listings, so reorG will create a pre-push backup automatically before the live write starts.`,
    backupId: null,
    required: true,
  };
}

async function evaluatePostPushRefreshHeadroom(
  byPlatform: Map<Platform, PushChangeItem[]>,
  dryRun: boolean,
): Promise<PushExecutionResult["postPushRefresh"]> {
  const targetedReadbackPlatforms = [...byPlatform.keys()].filter((platform) =>
    TARGETED_READBACK_PLATFORMS.has(platform),
  );
  const ebayPlatforms = [...byPlatform.keys()].filter((platform) =>
    EBAY_PUSH_PLATFORMS.has(platform),
  );
  if (ebayPlatforms.length === 0) {
    if (targetedReadbackPlatforms.length > 0) {
      const labels = targetedReadbackPlatforms.map((platform) =>
        platform === "BIGCOMMERCE" ? "BigCommerce" : "Shopify",
      );
      return {
        status: "ready",
        detail:
          labels.length === 1
            ? `Post-push targeted readback is ready for ${labels[0]}.`
            : `Post-push targeted readback is ready for ${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}.`,
        retryAt: null,
        requiredCalls: 0,
        availableCalls: null,
      };
    }
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
  const targetedReadbackByPlatform = new Map<
    Platform,
    { productIds: Set<string>; variantIds: Set<string> }
  >();

  for (const result of args.results) {
    if (!result.success) {
      continue;
    }

    if (EBAY_PUSH_PLATFORMS.has(result.platform)) {
      const existing = targetedByPlatform.get(result.platform) ?? new Set<string>();
      existing.add(result.listingId);
      targetedByPlatform.set(result.platform, existing);
      continue;
    }

    if (TARGETED_READBACK_PLATFORMS.has(result.platform)) {
      const existing = targetedReadbackByPlatform.get(result.platform) ?? {
        productIds: new Set<string>(),
        variantIds: new Set<string>(),
      };
      existing.productIds.add(result.listingId);
      if (result.platformVariantId) {
        existing.variantIds.add(result.platformVariantId);
      }
      targetedReadbackByPlatform.set(result.platform, existing);
    }
  }

  if (targetedByPlatform.size === 0 && targetedReadbackByPlatform.size === 0) {
    return {
      status: "not-needed",
      detail: "No successful marketplace listing updates needed a post-push targeted readback.",
      retryAt: null,
      requiredCalls: 0,
      availableCalls: null,
      results: [],
    };
  }

  const integrations = await db.integration.findMany({
    where: {
      platform: {
        in: [...new Set([...targetedByPlatform.keys(), ...targetedReadbackByPlatform.keys()])],
      },
    },
    orderBy: { platform: "asc" },
  });

  const refreshResults: NonNullable<PushExecutionResult["postPushRefresh"]>["results"] =
    [];
  let completedCount = 0;
  let failedCount = 0;
  let runningCount = 0;

  for (const integration of integrations) {
    if (EBAY_PUSH_PLATFORMS.has(integration.platform)) {
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
      continue;
    }

    if (TARGETED_READBACK_PLATFORMS.has(integration.platform)) {
      const targetedReadback = targetedReadbackByPlatform.get(integration.platform);
      if (!targetedReadback || targetedReadback.productIds.size === 0) {
        continue;
      }

      const productIds = [...targetedReadback.productIds];
      const changedVariantIds = [...targetedReadback.variantIds];

      if (integration.platform === "BIGCOMMERCE") {
        const reconcile = await runBigCommerceWebhookReconcile(
          {
            productIds,
            changedVariantIds,
          },
          {
            requestedMode: "incremental",
            effectiveMode: "incremental",
            triggerSource: "push",
            triggeredBy: `push:targeted_refresh:${args.pushJobId}`,
            fallbackReason: null,
            preserveSyncState: true,
          },
        );

        refreshResults.push({
          platform: integration.platform,
          label: integration.label,
          status: reconcile.status === "completed" ? "COMPLETED" : "FAILED",
          jobId: reconcile.syncJobId,
          message:
            reconcile.status === "completed"
              ? `Post-push targeted readback refreshed ${productIds.length.toLocaleString()} BigCommerce product${productIds.length === 1 ? "" : "s"}.`
              : reconcile.errors[0] ?? "BigCommerce targeted readback failed.",
          targetedCount: productIds.length,
        });

        if (reconcile.status === "completed") {
          completedCount += 1;
        } else {
          failedCount += 1;
        }
        continue;
      }

      if (integration.platform === "SHOPIFY") {
        const reconcile = await runShopifyWebhookReconcile(
          {
            productIds,
            changedVariantIds,
          },
          {
            requestedMode: "incremental",
            effectiveMode: "incremental",
            triggerSource: "push",
            triggeredBy: `push:targeted_refresh:${args.pushJobId}`,
            fallbackReason: null,
            preserveSyncState: true,
          },
        );

        refreshResults.push({
          platform: integration.platform,
          label: integration.label,
          status: reconcile.status === "COMPLETED" ? "COMPLETED" : "FAILED",
          jobId: reconcile.jobId,
          message:
            reconcile.status === "COMPLETED"
              ? `Post-push targeted readback refreshed ${productIds.length.toLocaleString()} Shopify product${productIds.length === 1 ? "" : "s"}.`
              : reconcile.errors[0]?.message ?? "Shopify targeted readback failed.",
          targetedCount: productIds.length,
        });

        if (reconcile.status === "COMPLETED") {
          completedCount += 1;
        } else {
          failedCount += 1;
        }
      }
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
        ? `Post-push targeted readback completed for ${detailBase}.`
        : "No successful marketplace listing updates needed a post-push targeted readback.",
      retryAt: null,
      results: refreshResults,
  };
}

function buildBlockedResult(args: {
  dryRun: boolean;
  blockedReason: string;
  summary: PushExecutionResult["summary"];
  batchSafety?: PushExecutionResult["batchSafety"];
  goLiveChecklist?: PushExecutionResult["goLiveChecklist"];
  prePushBackup?: PushExecutionResult["prePushBackup"];
  postPushRefresh?: PushExecutionResult["postPushRefresh"];
}): PushExecutionResult {
  return {
    pushJobId: "",
    dryRun: args.dryRun,
    status: "blocked",
    summary: args.summary,
    results: [],
    blockedReason: args.blockedReason,
    batchSafety: args.batchSafety,
    goLiveChecklist: args.goLiveChecklist,
    prePushBackup: args.prePushBackup,
    postPushRefresh: args.postPushRefresh,
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
  const summary = buildPushSummary(byPlatform);
  const writeSafetyMessages: string[] = [];
  let writeSafetyStatus: "ready" | "blocked" = "ready";

  // Check write safety for each platform
  for (const platform of byPlatform.keys()) {
    const safety = await checkWriteSafety(platform);
    if (!safety.allowed) {
      if (request.dryRun) {
        writeSafetyStatus = "blocked";
        writeSafetyMessages.push(
          safety.reason ??
            `${platform} is currently blocked for live writes. Dry run can continue, but confirmation would still be blocked.`,
        );
        continue;
      }
      return buildBlockedResult({
        dryRun: request.dryRun,
        blockedReason: safety.reason ?? "Push blocked by write safety settings.",
        summary,
        batchSafety: evaluateBatchSafety(summary, request.dryRun),
      });
    }
    writeSafetyMessages.push(
      safety.reason ?? `${platform} passed the current write lock and environment checks.`,
    );
  }

  const batchSafety = evaluateBatchSafety(summary, request.dryRun);
  const prePushBackupPlan = evaluatePrePushBackupNeed(summary, request.dryRun);
  if (!request.dryRun && prePushBackupPlan.status === "blocked") {
    const goLiveChecklist = buildGoLiveChecklist({
      dryRun: false,
      writeSafetyDetail: writeSafetyMessages.join(" "),
      writeSafetyStatus: "ready",
      batchSafety,
      prePushBackup: prePushBackupPlan,
      confirmationStatus: "completed",
      postPushRefresh: {
        status: "ready",
        detail: "Post-push refresh was not evaluated because the backup requirement blocked the live push first.",
        retryAt: null,
        requiredCalls: null,
        availableCalls: null,
      },
    });
    return buildBlockedResult({
      dryRun: false,
      blockedReason: prePushBackupPlan.detail,
      summary,
      batchSafety,
      goLiveChecklist,
      prePushBackup: prePushBackupPlan,
    });
  }

  if (!request.dryRun && batchSafety.status === "blocked") {
    const goLiveChecklist = buildGoLiveChecklist({
      dryRun: false,
      writeSafetyDetail: writeSafetyMessages.join(" "),
      writeSafetyStatus: "ready",
      batchSafety,
      prePushBackup: prePushBackupPlan,
      confirmationStatus: "completed",
      postPushRefresh: {
        status: "ready",
        detail: "Post-push refresh was not evaluated because the batch size must be split first.",
        retryAt: null,
        requiredCalls: null,
        availableCalls: null,
      },
    });
    return buildBlockedResult({
      dryRun: false,
      blockedReason: batchSafety.detail,
      summary,
      batchSafety,
      goLiveChecklist,
      prePushBackup: prePushBackupPlan,
    });
  }

  const postPushRefresh = await evaluatePostPushRefreshHeadroom(
    byPlatform,
    request.dryRun,
  );
  const dryRunChecklist = buildGoLiveChecklist({
    dryRun: request.dryRun,
    writeSafetyDetail: writeSafetyMessages.join(" "),
    writeSafetyStatus,
    batchSafety,
    prePushBackup: prePushBackupPlan,
    confirmationStatus: request.dryRun ? "ready" : "completed",
    postPushRefresh: postPushRefresh ?? {
      status: "not-needed",
      detail: "No post-push refresh requirement was detected for this push.",
      retryAt: null,
      requiredCalls: null,
      availableCalls: null,
    },
  });
  if (!request.dryRun && postPushRefresh?.status === "blocked") {
    return buildBlockedResult({
      dryRun: false,
      blockedReason: postPushRefresh.detail,
      summary,
      batchSafety,
      goLiveChecklist: dryRunChecklist,
      prePushBackup: prePushBackupPlan,
      postPushRefresh,
    });
  }

  // Create push job record
  const pushJob = await db.pushJob.create({
    data: {
      userId: request.userId,
      dryRun: request.dryRun,
      status: request.dryRun ? "DRY_RUN" : "EXECUTING",
      payload: {
        changes: request.changes,
        summary,
      } as unknown as object,
    },
  });

  // If dry run, validate and return without pushing
  if (request.dryRun) {
    for (const change of request.changes) {
      results.push({
        platform: change.platform,
        listingId: change.listingId,
        platformVariantId: change.platformVariantId ?? null,
        field: change.field,
          stagedChangeId: change.stagedChangeId ?? null,
          masterRowId: change.masterRowId,
          marketplaceListingId: change.marketplaceListingId,
          oldValue: change.oldValue,
          newValue: change.newValue,
          success: true,
      });
    }

    await db.pushJob.update({
      where: { id: pushJob.id },
      data: {
        status: "COMPLETED",
        result: {
          dryRun: true,
          summary,
          results,
          batchSafety,
          goLiveChecklist: dryRunChecklist,
          prePushBackup: prePushBackupPlan,
          postPushRefresh,
        },
        completedAt: new Date(),
      },
    });

    return {
      pushJobId: pushJob.id,
      dryRun: true,
      status: "completed",
      summary,
      results,
      batchSafety,
      goLiveChecklist: dryRunChecklist,
      prePushBackup: prePushBackupPlan,
      postPushRefresh,
    };
  }

  let completedPrePushBackup: PushExecutionResult["prePushBackup"] = prePushBackupPlan;
  const normalizedChanges = await Promise.all(
    request.changes.map(async (change) => {
      if (change.stagedChangeId) return change;

      const created = await db.stagedChange.create({
        data: {
          masterRowId: change.masterRowId,
          marketplaceListingId: change.marketplaceListingId,
          field: change.field,
          stagedValue: String(change.newValue),
          liveValue: change.oldValue != null ? String(change.oldValue) : null,
          changedById: request.userId,
        },
      });

      return {
        ...change,
        stagedChangeId: created.id,
      };
    }),
  );
  request = {
    ...request,
    changes: normalizedChanges,
  };
  byPlatform.clear();
  for (const change of request.changes) {
    const existing = byPlatform.get(change.platform) ?? [];
    existing.push(change);
    byPlatform.set(change.platform, existing);
  }
  if (prePushBackupPlan.required) {
    try {
      const backup = await createBackup({
        type: "PRE_PUSH",
        triggeredById: request.userId,
      });
      completedPrePushBackup = {
        status: "completed",
        detail: "Pre-push backup completed successfully before the live marketplace write started.",
        backupId: backup.id,
        required: true,
      };
    } catch (error) {
      const detail =
        error instanceof Error
          ? `Pre-push backup failed, so the live push was blocked: ${error.message}`
          : "Pre-push backup failed, so the live push was blocked.";
      await db.pushJob.update({
        where: { id: pushJob.id },
        data: {
          status: "FAILED",
          result: {
            summary,
            results: [],
            batchSafety,
            goLiveChecklist: buildGoLiveChecklist({
              dryRun: false,
              writeSafetyDetail: writeSafetyMessages.join(" "),
              writeSafetyStatus: "ready",
              batchSafety,
              prePushBackup: {
                status: "failed",
                detail,
                required: true,
              },
              confirmationStatus: "completed",
              postPushRefresh: postPushRefresh ?? {
                status: "not-needed",
                detail: "No post-push refresh requirement was detected for this push.",
                retryAt: null,
                requiredCalls: null,
                availableCalls: null,
              },
            }),
            prePushBackup: {
              status: "failed",
              detail,
              required: true,
            },
            postPushRefresh,
          },
          completedAt: new Date(),
        },
      });

      return buildBlockedResult({
        dryRun: false,
        blockedReason: detail,
        summary,
        batchSafety,
        goLiveChecklist: buildGoLiveChecklist({
          dryRun: false,
          writeSafetyDetail: writeSafetyMessages.join(" "),
          writeSafetyStatus: "ready",
          batchSafety,
          prePushBackup: {
            status: "failed",
            detail,
            required: true,
          },
          confirmationStatus: "completed",
          postPushRefresh: postPushRefresh ?? {
            status: "not-needed",
            detail: "No post-push refresh requirement was detected for this push.",
            retryAt: null,
            requiredCalls: null,
            availableCalls: null,
          },
        }),
        prePushBackup: {
          status: "failed",
          detail,
          required: true,
        },
        postPushRefresh,
      });
    }
  }

  // Execute live push per platform
  for (const [platform, changes] of byPlatform) {
    const adapter = adapters.get(platform);
    if (!adapter) {
      for (const change of changes) {
        results.push({
          stagedChangeId: change.stagedChangeId ?? null,
          masterRowId: change.masterRowId,
          marketplaceListingId: change.marketplaceListingId,
          platform,
          listingId: change.listingId,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
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
        platformVariantId: c.platformVariantId ?? undefined,
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
        const change = changes.find(
          (entry) =>
            matchesPushChange(
              entry,
              "salePrice",
              update.platformItemId,
              update.platformVariantId ?? null,
            ),
        );
        const error = priceResult.errors.find(
          (e) => e.platformItemId === update.platformItemId
        );
        results.push({
          platform,
          listingId: update.platformItemId,
          platformVariantId: change?.platformVariantId ?? update.platformVariantId ?? null,
          field: "salePrice",
          stagedChangeId: change?.stagedChangeId ?? null,
          masterRowId: change?.masterRowId ?? "",
          marketplaceListingId: change?.marketplaceListingId ?? "",
          oldValue: change?.oldValue ?? null,
          newValue: change?.newValue ?? update.newPrice,
          success: !error,
          error: error?.message,
        });
      }
    }

    if (adRateUpdates.length > 0) {
      const adResult = await adapter.pushAdRateUpdates(adRateUpdates);
      for (const update of adRateUpdates) {
        const change = changes.find(
          (entry) => matchesPushChange(entry, "adRate", update.platformItemId),
        );
        const error = adResult.errors.find(
          (e) => e.platformItemId === update.platformItemId
        );
        results.push({
          platform,
          listingId: update.platformItemId,
          platformVariantId: change?.platformVariantId ?? null,
          field: "adRate",
          stagedChangeId: change?.stagedChangeId ?? null,
          masterRowId: change?.masterRowId ?? "",
          marketplaceListingId: change?.marketplaceListingId ?? "",
          oldValue: change?.oldValue ?? null,
          newValue: change?.newValue ?? update.newAdRate,
          success: !error,
          error: error?.message,
        });
      }
    }
  }

  // Update staged changes for successful pushes
  const successfulStagedIds = results
    .filter((r) => r.success)
    .map((r) => r.stagedChangeId)
    .filter((value): value is string => Boolean(value));

  if (successfulStagedIds.length > 0) {
    await db.stagedChange.updateMany({
      where: { id: { in: successfulStagedIds } },
      data: { status: "PUSHED", pushedAt: new Date() },
    });
  }

  const status = results.every((r) => r.success)
    ? "completed"
    : results.some((r) => r.success)
      ? "partial"
      : "failed";
  const finalSummary = buildPushSummary(byPlatform, results);
  const completedPostPushRefresh =
    status === "completed" || status === "partial"
      ? await executePostPushTargetedRefresh({
          pushJobId: pushJob.id,
          results,
        })
      : postPushRefresh;

  await db.pushJob.update({
    where: { id: pushJob.id },
    data: {
      status: status === "completed" ? "COMPLETED" : "FAILED",
      result: {
        summary: finalSummary,
        results,
        batchSafety,
        goLiveChecklist: buildGoLiveChecklist({
          dryRun: false,
          writeSafetyDetail: writeSafetyMessages.join(" "),
          writeSafetyStatus: "ready",
          batchSafety,
          prePushBackup: completedPrePushBackup ?? prePushBackupPlan,
          confirmationStatus: "completed",
          postPushRefresh: completedPostPushRefresh ?? {
            status: "not-needed",
            detail: "No successful eBay listing updates needed a post-push targeted refresh.",
            retryAt: null,
            requiredCalls: null,
            availableCalls: null,
          },
        }),
        prePushBackup: completedPrePushBackup,
        postPushRefresh: completedPostPushRefresh,
      },
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
        summary: finalSummary,
        batchSafety,
        prePushBackup: completedPrePushBackup ?? null,
        postPushRefresh: completedPostPushRefresh ?? null,
      },
    },
  });

  return {
    pushJobId: pushJob.id,
    dryRun: false,
    status,
    summary: finalSummary,
    results,
    batchSafety,
    goLiveChecklist: buildGoLiveChecklist({
      dryRun: false,
      writeSafetyDetail: writeSafetyMessages.join(" "),
      writeSafetyStatus: "ready",
      batchSafety,
      prePushBackup: completedPrePushBackup ?? prePushBackupPlan,
      confirmationStatus: "completed",
      postPushRefresh: completedPostPushRefresh ?? {
        status: "not-needed",
        detail: "No successful eBay listing updates needed a post-push targeted refresh.",
        retryAt: null,
        requiredCalls: null,
        availableCalls: null,
      },
    }),
    prePushBackup: completedPrePushBackup,
    postPushRefresh: completedPostPushRefresh,
  };
}
