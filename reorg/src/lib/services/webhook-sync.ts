import { Prisma, type Integration, Platform, SyncStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";
import { startIntegrationSync } from "@/lib/services/sync-control";
import { runBigCommerceWebhookReconcile } from "@/lib/services/bigcommerce-sync";
import { runShopifyWebhookReconcile } from "@/lib/services/shopify-sync";

const WEBHOOK_SYNC_COOLDOWN_MS = 5 * 60 * 1000;
const FRESH_SYNC_GRACE_MS = 2 * 60 * 1000;

export type WebhookPlatform = "SHOPIFY" | "BIGCOMMERCE";

export interface HandleMarketplaceWebhookOptions {
  platform: WebhookPlatform;
  topic: string | null;
  externalId: string | null;
  sourceLabel: string | null;
  changedIds?: string[];
  deletedIds?: string[];
}

export interface HandleMarketplaceWebhookResult {
  accepted: boolean;
  triggered: boolean;
  status: "ignored" | "debounced" | "running" | "started";
  message: string;
  jobId: string | null;
}

function buildTouchedWebhookConfig(
  integration: Pick<Integration, "platform" | "config">,
  receivedAt: Date,
) {
  const config = getIntegrationConfig(integration);
  return {
    ...config,
    syncState: {
      ...config.syncState,
      lastWebhookAt: receivedAt.toISOString(),
    },
  };
}

async function touchWebhookState(
  integration: Pick<Integration, "id" | "platform" | "config">,
  receivedAt: Date,
) {
  await db.integration.update({
    where: { id: integration.id },
    data: {
      config: buildTouchedWebhookConfig(
        integration,
        receivedAt,
      ) as unknown as Prisma.InputJsonValue,
    },
  });
}

async function logWebhookEvent(
  integrationId: string | null,
  options: HandleMarketplaceWebhookOptions,
  receivedAt: Date,
  result: Omit<HandleMarketplaceWebhookResult, "accepted"> & { accepted: boolean },
) {
  await db.auditLog.create({
    data: {
      action: "webhook_received",
      entityType: "integration",
      entityId: integrationId ?? options.platform,
      details: {
        platform: options.platform,
        topic: options.topic,
        externalId: options.externalId,
        sourceLabel: options.sourceLabel,
        receivedAt: receivedAt.toISOString(),
        accepted: result.accepted,
        triggered: result.triggered,
        status: result.status,
        message: result.message,
        jobId: result.jobId,
      },
    },
  });
}

async function findRecentRelevantJob(integrationId: string, since: Date) {
  return db.syncJob.findFirst({
    where: {
      integrationId,
      OR: [
        { status: SyncStatus.RUNNING },
        { createdAt: { gte: since } },
        { completedAt: { gte: since } },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
}

async function startTargetedWebhookSync(
  integration: Integration,
  options: HandleMarketplaceWebhookOptions,
) {
  const changedIds = [...new Set((options.changedIds ?? []).filter(Boolean))];
  const deletedIds = [...new Set((options.deletedIds ?? []).filter(Boolean))];

  if (changedIds.length === 0 && deletedIds.length === 0) {
    return null;
  }

  const triggeredBy = "webhook:incremental";

  switch (integration.platform) {
    case "SHOPIFY":
      runShopifyWebhookReconcile(
        {
          productIds: changedIds,
          deletedProductIds: deletedIds,
        },
        {
          requestedMode: "incremental",
          effectiveMode: "incremental",
          triggerSource: "webhook",
          triggeredBy,
          fallbackReason: null,
        },
      ).catch((error) =>
        console.error("[webhook-sync] SHOPIFY targeted reconcile failed:", error),
      );
      break;
    case "BIGCOMMERCE":
      runBigCommerceWebhookReconcile(
        {
          productIds: changedIds,
          deletedProductIds: deletedIds,
        },
        {
          requestedMode: "incremental",
          effectiveMode: "incremental",
          triggerSource: "webhook",
          triggeredBy,
          fallbackReason: null,
        },
      ).catch((error) =>
        console.error("[webhook-sync] BIGCOMMERCE targeted reconcile failed:", error),
      );
      break;
    default:
      return null;
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  const job = await db.syncJob.findFirst({
    where: {
      integrationId: integration.id,
      triggeredBy,
    },
    orderBy: { createdAt: "desc" },
  });

  return job;
}

export async function handleMarketplaceWebhook(
  options: HandleMarketplaceWebhookOptions,
): Promise<HandleMarketplaceWebhookResult> {
  const receivedAt = new Date();
  const integration = await db.integration.findUnique({
    where: { platform: options.platform as Platform },
  });

  if (!integration) {
    const result: HandleMarketplaceWebhookResult = {
      accepted: false,
      triggered: false,
      status: "ignored",
      message: `${options.platform} integration is not configured yet.`,
      jobId: null,
    };
    await logWebhookEvent(null, options, receivedAt, result);
    return result;
  }

  await touchWebhookState(integration, receivedAt);

  if (!integration.enabled) {
    const result: HandleMarketplaceWebhookResult = {
      accepted: true,
      triggered: false,
      status: "ignored",
      message: `${integration.label} is not connected, so the webhook was recorded but no pull was started.`,
      jobId: null,
    };
    await logWebhookEvent(integration.id, options, receivedAt, result);
    return result;
  }

  const config = getIntegrationConfig(integration);
  if (!config.syncProfile.autoSyncEnabled) {
    const result: HandleMarketplaceWebhookResult = {
      accepted: true,
      triggered: false,
      status: "ignored",
      message: `${integration.label} auto-pull is disabled, so the webhook was recorded but not dispatched.`,
      jobId: null,
    };
    await logWebhookEvent(integration.id, options, receivedAt, result);
    return result;
  }

  const freshSyncCutoff = new Date(receivedAt.getTime() - FRESH_SYNC_GRACE_MS);
  if (
    integration.lastSyncAt &&
    integration.lastSyncAt.getTime() >= freshSyncCutoff.getTime()
  ) {
    const result: HandleMarketplaceWebhookResult = {
      accepted: true,
      triggered: false,
      status: "debounced",
      message: `${integration.label} synced recently, so no extra pull was started.`,
      jobId: null,
    };
    await logWebhookEvent(integration.id, options, receivedAt, result);
    return result;
  }

  const recentJobCutoff = new Date(receivedAt.getTime() - WEBHOOK_SYNC_COOLDOWN_MS);
  const recentJob = await findRecentRelevantJob(integration.id, recentJobCutoff);

  if (recentJob?.status === SyncStatus.RUNNING) {
    const result: HandleMarketplaceWebhookResult = {
      accepted: true,
      triggered: false,
      status: "running",
      message: `${integration.label} already has a pull running, so this webhook will be covered by that job.`,
      jobId: recentJob.id,
    };
    await logWebhookEvent(integration.id, options, receivedAt, result);
    return result;
  }

  if (
    recentJob &&
    typeof recentJob.triggeredBy === "string" &&
    recentJob.triggeredBy.startsWith("webhook:")
  ) {
    const result: HandleMarketplaceWebhookResult = {
      accepted: true,
      triggered: false,
      status: "debounced",
      message: `${integration.label} already handled a recent webhook burst, so this event was merged into that pull window.`,
      jobId: recentJob.id,
    };
    await logWebhookEvent(integration.id, options, receivedAt, result);
    return result;
  }

  const targetedJob = await startTargetedWebhookSync(integration, options);

  if (targetedJob) {
    const result: HandleMarketplaceWebhookResult = {
      accepted: true,
      triggered: true,
      status: "started",
      message: `${integration.label} webhook triggered a targeted incremental refresh.`,
      jobId: targetedJob.id,
    };

    await logWebhookEvent(integration.id, options, receivedAt, result);

    return result;
  }

  const dispatch = await startIntegrationSync(integration, {
    requestedMode: "full",
    triggerSource: "webhook",
  });

  const result: HandleMarketplaceWebhookResult = {
    accepted: true,
    triggered: dispatch.status === "STARTED",
    status: dispatch.status === "STARTED" ? "started" : "running",
    message:
      dispatch.status === "STARTED"
        ? `${integration.label} webhook triggered a pull-only refresh.`
        : dispatch.message,
    jobId: dispatch.jobId,
  };

  await logWebhookEvent(integration.id, options, receivedAt, result);

  return result;
}
