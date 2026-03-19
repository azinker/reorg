import { db } from "@/lib/db";
import type { Integration, Platform } from "@prisma/client";
import {
  getIntegrationConfig,
  isIncrementalReady,
  type SyncMode,
} from "@/lib/integrations/runtime-config";
import { runBigCommerceSync } from "@/lib/services/bigcommerce-sync";
import { runEbayTtSync } from "@/lib/services/ebay-tt-sync";
import { runShopifySync } from "@/lib/services/shopify-sync";
import { runEbayTppSync } from "@/lib/services/ebay-tpp-sync";
import { failStaleRunningJob, isRunningJobStale } from "@/lib/services/sync-jobs";

export type SyncTriggerSource = "manual" | "scheduler" | "webhook" | "push";

export interface SyncExecutionOptions {
  requestedMode?: SyncMode;
  effectiveMode?: SyncMode;
  triggeredBy?: string;
  triggerSource?: SyncTriggerSource;
  fallbackReason?: string | null;
  targetedPlatformItemIds?: string[];
  preserveSyncState?: boolean;
}

export interface SyncDispatchResult {
  integrationId: string;
  platform: Platform;
  requestedMode: SyncMode;
  effectiveMode: SyncMode;
  fallbackReason: string | null;
  status: "STARTED" | "COMPLETED" | "FAILED" | "ALREADY_RUNNING" | "UNSUPPORTED";
  jobId: string | null;
  message: string;
}

export interface SyncCompletionOptions {
  cursor?: string | null;
  pendingIncrementalItemIds?: string[];
  pendingIncrementalWindowEndedAt?: string | null;
}

type SyncDispatchMode = "background" | "inline";

interface ExecutedSyncResult {
  jobId: string | null;
  status: "COMPLETED" | "FAILED";
}

function formatTriggeredBy(options: SyncExecutionOptions): string {
  if (options.triggeredBy) return options.triggeredBy;
  const source = options.triggerSource ?? "manual";
  const mode = options.effectiveMode ?? options.requestedMode ?? "full";
  return `${source}:${mode}`;
}

function resolveSyncModes(
  integration: Pick<Integration, "platform" | "config">,
  requestedMode?: SyncMode,
): {
  requestedMode: SyncMode;
  effectiveMode: SyncMode;
  fallbackReason: string | null;
} {
  const config = getIntegrationConfig(integration);
  const desiredMode = requestedMode ?? config.syncProfile.preferredMode;

  if (desiredMode === "incremental" && !isIncrementalReady(integration.platform)) {
    return {
      requestedMode: desiredMode,
      effectiveMode: "full",
      fallbackReason:
        "Incremental sync groundwork is configured for this store, but the live delta adapter is not enabled yet. Falling back to a full pull.",
    };
  }

  return {
    requestedMode: desiredMode,
    effectiveMode: desiredMode,
    fallbackReason: null,
  };
}

export function resolveIntegrationSyncModes(
  integration: Pick<Integration, "platform" | "config">,
  requestedMode?: SyncMode,
) {
  return resolveSyncModes(integration, requestedMode);
}

async function executeIntegrationSync(
  integration: Pick<Integration, "platform" | "label">,
  options: SyncExecutionOptions,
): Promise<ExecutedSyncResult | null> {
  switch (integration.platform) {
    case "SHOPIFY": {
      const result = await runShopifySync(options);
      return {
        jobId: result.jobId,
        status: result.status === "COMPLETED" ? "COMPLETED" : "FAILED",
      };
    }
    case "TPP_EBAY": {
      const result = await runEbayTppSync(options);
      return {
        jobId: result.jobId,
        status: result.status === "COMPLETED" ? "COMPLETED" : "FAILED",
      };
    }
    case "TT_EBAY": {
      const result = await runEbayTtSync(options);
      return {
        jobId: result.jobId,
        status: result.status === "COMPLETED" ? "COMPLETED" : "FAILED",
      };
    }
    case "BIGCOMMERCE": {
      const result = await runBigCommerceSync(options);
      return {
        jobId: result.syncJobId,
        status: result.status === "completed" ? "COMPLETED" : "FAILED",
      };
    }
    default:
      return null;
  }
}

export function buildCompletedSyncConfig(
  integration: Pick<Integration, "platform" | "config">,
  options: SyncExecutionOptions,
  completedAt: Date,
  completion: SyncCompletionOptions = {},
) {
  const config = getIntegrationConfig(integration);
  const effectiveMode = options.effectiveMode ?? options.requestedMode ?? "full";
  const shouldClearFallbackReason =
    !options.preserveSyncState &&
    options.fallbackReason == null &&
    effectiveMode === config.syncProfile.preferredMode;

  return {
    ...config,
    syncState: {
      ...config.syncState,
      lastRequestedMode: options.requestedMode ?? config.syncState.lastRequestedMode,
      lastEffectiveMode: effectiveMode,
      lastFullSyncAt:
        effectiveMode === "full"
          ? completedAt.toISOString()
          : config.syncState.lastFullSyncAt,
      lastIncrementalSyncAt:
        effectiveMode === "incremental"
          ? completedAt.toISOString()
          : config.syncState.lastIncrementalSyncAt,
      lastCursor:
        options.preserveSyncState
          ? config.syncState.lastCursor
          : completion.cursor !== undefined
          ? completion.cursor
          : config.syncState.lastCursor,
      pendingIncrementalItemIds: options.preserveSyncState
        ? config.syncState.pendingIncrementalItemIds
        : completion.pendingIncrementalItemIds ?? [],
      pendingIncrementalWindowEndedAt:
        options.preserveSyncState
          ? config.syncState.pendingIncrementalWindowEndedAt
          : completion.pendingIncrementalWindowEndedAt ?? null,
      lastFallbackReason:
        options.preserveSyncState
          ? config.syncState.lastFallbackReason
          : shouldClearFallbackReason
          ? null
          : options.fallbackReason === undefined
          ? config.syncState.lastFallbackReason
          : options.fallbackReason,
      lastRateLimitAt: null,
      lastRateLimitMessage: null,
    },
  };
}

export async function buildCompletedSyncConfigFromLatest(
  integration: Pick<Integration, "id" | "platform" | "config">,
  options: SyncExecutionOptions,
  completedAt: Date,
  completion: SyncCompletionOptions = {},
) {
  const latest = await db.integration.findUnique({
    where: { id: integration.id },
    select: {
      platform: true,
      config: true,
    },
  });

  return buildCompletedSyncConfig(
    latest ?? integration,
    options,
    completedAt,
    completion,
  );
}

export async function startIntegrationSync(
  integration: Integration,
  options: SyncExecutionOptions = {},
  dispatchMode: SyncDispatchMode = "background",
): Promise<SyncDispatchResult> {
  const runningJob = await db.syncJob.findFirst({
    where: { integrationId: integration.id, status: "RUNNING" },
    orderBy: { createdAt: "desc" },
  });

  if (runningJob) {
    if (isRunningJobStale(runningJob)) {
      await failStaleRunningJob(
        runningJob,
        "Marked failed automatically because the sync job exceeded the stale running threshold.",
      );
    } else {
      const modes = resolveSyncModes(integration, options.requestedMode);
      return {
        integrationId: integration.id,
        platform: integration.platform,
        requestedMode: modes.requestedMode,
        effectiveMode: modes.effectiveMode,
        fallbackReason: modes.fallbackReason,
        status: "ALREADY_RUNNING",
        jobId: runningJob.id,
        message: `${integration.label} sync is already running.`,
      };
    }
  }

  const modes = resolveSyncModes(integration, options.requestedMode);
  const nextOptions: SyncExecutionOptions = {
    ...options,
    requestedMode: modes.requestedMode,
    effectiveMode: modes.effectiveMode,
    fallbackReason: modes.fallbackReason,
    triggeredBy: formatTriggeredBy({
      ...options,
      requestedMode: modes.requestedMode,
      effectiveMode: modes.effectiveMode,
    }),
  };

  if (dispatchMode === "inline") {
    const result = await executeIntegrationSync(integration, nextOptions);
    if (!result) {
      return {
        integrationId: integration.id,
        platform: integration.platform,
        requestedMode: modes.requestedMode,
        effectiveMode: modes.effectiveMode,
        fallbackReason: modes.fallbackReason,
        status: "UNSUPPORTED",
        jobId: null,
        message: `Sync for ${integration.platform} is not implemented yet.`,
      };
    }

    return {
      integrationId: integration.id,
      platform: integration.platform,
      requestedMode: modes.requestedMode,
      effectiveMode: modes.effectiveMode,
      fallbackReason: modes.fallbackReason,
      status: result.status,
      jobId: result.jobId,
      message:
        result.status === "COMPLETED"
          ? `${integration.label} ${
              modes.effectiveMode === "incremental" ? "incremental" : "full"
            } sync completed.`
          : `${integration.label} ${
              modes.effectiveMode === "incremental" ? "incremental" : "full"
            } sync failed.`,
    };
  }

  const executor = executeIntegrationSync(integration, nextOptions);
  executor.catch((err) => {
    console.error(
      `[sync-control] ${integration.platform} background error:`,
      err,
    );
  });

  const supportedPlatforms: Platform[] = [
    "SHOPIFY",
    "TPP_EBAY",
    "TT_EBAY",
    "BIGCOMMERCE",
  ];

  if (!supportedPlatforms.includes(integration.platform)) {
    return {
      integrationId: integration.id,
      platform: integration.platform,
      requestedMode: modes.requestedMode,
      effectiveMode: modes.effectiveMode,
      fallbackReason: modes.fallbackReason,
      status: "UNSUPPORTED",
      jobId: null,
      message: `Sync for ${integration.platform} is not implemented yet.`,
    };
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  const newJob = await db.syncJob.findFirst({
    where: { integrationId: integration.id },
    orderBy: { createdAt: "desc" },
  });

  return {
    integrationId: integration.id,
    platform: integration.platform,
    requestedMode: modes.requestedMode,
    effectiveMode: modes.effectiveMode,
    fallbackReason: modes.fallbackReason,
    status: "STARTED",
    jobId: newJob?.id ?? null,
    message:
      modes.effectiveMode === "incremental"
        ? `${integration.label} incremental sync started.`
        : `${integration.label} full sync started.`,
  };
}
