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

export type SyncTriggerSource = "manual" | "scheduler" | "webhook";

export interface SyncExecutionOptions {
  requestedMode?: SyncMode;
  effectiveMode?: SyncMode;
  triggeredBy?: string;
  triggerSource?: SyncTriggerSource;
  fallbackReason?: string | null;
}

export interface SyncDispatchResult {
  integrationId: string;
  platform: Platform;
  requestedMode: SyncMode;
  effectiveMode: SyncMode;
  fallbackReason: string | null;
  status: "STARTED" | "ALREADY_RUNNING" | "UNSUPPORTED";
  jobId: string | null;
  message: string;
}

export interface SyncCompletionOptions {
  cursor?: string | null;
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

export function buildCompletedSyncConfig(
  integration: Pick<Integration, "platform" | "config">,
  options: SyncExecutionOptions,
  completedAt: Date,
  completion: SyncCompletionOptions = {},
) {
  const config = getIntegrationConfig(integration);
  const effectiveMode = options.effectiveMode ?? options.requestedMode ?? "full";

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
        completion.cursor !== undefined
          ? completion.cursor
          : config.syncState.lastCursor,
      lastFallbackReason:
        options.fallbackReason === undefined
          ? config.syncState.lastFallbackReason
          : options.fallbackReason,
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
): Promise<SyncDispatchResult> {
  const runningJob = await db.syncJob.findFirst({
    where: { integrationId: integration.id, status: "RUNNING" },
    orderBy: { createdAt: "desc" },
  });

  if (runningJob) {
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

  switch (integration.platform) {
    case "SHOPIFY":
      runShopifySync(nextOptions).catch((err) =>
        console.error("[sync-control] SHOPIFY background error:", err),
      );
      break;
    case "TPP_EBAY":
      runEbayTppSync(nextOptions).catch((err) =>
        console.error("[sync-control] TPP_EBAY background error:", err),
      );
      break;
    case "TT_EBAY":
      runEbayTtSync(nextOptions).catch((err) =>
        console.error("[sync-control] TT_EBAY background error:", err),
      );
      break;
    case "BIGCOMMERCE":
      runBigCommerceSync(nextOptions).catch((err) =>
        console.error("[sync-control] BIGCOMMERCE background error:", err),
      );
      break;
    default:
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
