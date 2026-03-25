import { after, NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { Platform, Prisma } from "@prisma/client";
import { z } from "zod";
import { mergeIntegrationConfig } from "@/lib/integrations/runtime-config";
import {
  resolveIntegrationSyncModes,
  startIntegrationSync,
} from "@/lib/services/sync-control";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";
import { assessIntegrationWebhookHealth } from "@/lib/webhook-health";
import {
  formatCooldownRetryAt,
  getEbayRateLimitCooldownUntil,
  isEbayPlatform,
} from "@/lib/services/ebay-rate-limit";
import {
  buildGetItemCooldownRateLimitsSnapshot,
  deserializeSnapshotFromConfig,
  getEbayCooldownUntilFromSnapshot,
  getEbayMethodRate,
  getEbayTradingRateLimitSnapshotForIntegration,
  serializeSnapshotForConfig,
} from "@/lib/services/ebay-analytics";
import { getSharedEbayQuotaStoreCount } from "@/lib/services/ebay-sync-budget";
import { getReservedEbayGetItemCalls } from "@/lib/services/ebay-sync-policy";
import {
  cancelRunningSyncJob,
  failStaleRunningJob,
  isRunningJobStale,
} from "@/lib/services/sync-jobs";

export const runtime = "nodejs";
export const maxDuration = 800;
export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

  const postSchema = z
  .object({
    mode: z.enum(["full", "incremental"]).optional(),
  })
  .optional();

function normalizeSyncErrors(
  errors: unknown,
): Array<{ sku: string; message: string }> {
  if (!Array.isArray(errors)) return [];

  return errors.flatMap((entry) => {
    if (typeof entry === "string") {
      return [{ sku: "_global", message: entry }];
    }

    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const sku =
      typeof record.sku === "string" && record.sku.trim()
        ? record.sku
        : "_global";
    const message =
      typeof record.message === "string" && record.message.trim()
        ? record.message
        : JSON.stringify(entry);

    return [{ sku, message }];
  });
}

function getWebhookProofStatus(lastSyncAt: Date | null, receivedAt: Date | null) {
  if (!receivedAt) return "none";
  if (!lastSyncAt) return "after_last_pull";
  return receivedAt.getTime() > lastSyncAt.getTime()
    ? "after_last_pull"
    : "before_last_pull";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  const { integrationId } = await params;

  try {
    const integration = await db.integration.findFirst({
      where: {
        OR: [
          { id: integrationId },
          { platform: integrationId.toUpperCase() as Platform },
        ],
      },
    });

    if (!integration) {
      return NextResponse.json(
        { error: `Integration "${integrationId}" not found` },
        { status: 404 }
      );
    }

    if (!integration.enabled) {
      return NextResponse.json(
        { error: `Integration "${integration.label}" is not connected` },
        { status: 400 }
      );
    }

    const body =
      request.headers.get("content-length") &&
      request.headers.get("content-length") !== "0"
        ? await request.json()
        : undefined;
    const parsed = postSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const modes = resolveIntegrationSyncModes(integration, parsed.data?.mode);
    const triggerSource =
      request.headers.get("x-trigger-source") === "scheduler" ? "scheduler" : "manual";
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
        return NextResponse.json({
          data: {
            integrationId: integration.id,
            platform: integration.platform,
            requestedMode: modes.requestedMode,
            effectiveMode: modes.effectiveMode,
            fallbackReason: modes.fallbackReason,
            status: "ALREADY_RUNNING",
            jobId: runningJob.id,
            message: `${integration.label} sync is already running.`,
          },
        });
      }
    }

    const placeholderJob = await db.syncJob.create({
      data: {
        integrationId: integration.id,
        status: "RUNNING",
        triggeredBy: `${triggerSource}:${modes.effectiveMode}`,
        startedAt: new Date(),
      },
    });

    after(async () => {
      try {
        await startIntegrationSync(
          integration,
          {
            requestedMode: modes.requestedMode,
            effectiveMode: modes.effectiveMode,
            fallbackReason: modes.fallbackReason,
            triggerSource,
            existingJobId: placeholderJob.id,
          },
          "inline",
        );
      } catch (error) {
        console.error(`[sync] ${triggerSource} ${integration.platform} sync failed`, error);
        await db.syncJob.update({
          where: { id: placeholderJob.id },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            errors: [{ sku: "_global", message: error instanceof Error ? error.message : "Sync failed" }],
          },
        }).catch(() => {});
      }
    });

    return NextResponse.json({
      data: {
        integrationId: integration.id,
        platform: integration.platform,
        requestedMode: modes.requestedMode,
        effectiveMode: modes.effectiveMode,
        fallbackReason: modes.fallbackReason,
        status: "STARTED",
        jobId: placeholderJob.id,
        message:
          modes.effectiveMode === "incremental"
            ? `${integration.label} incremental sync started.`
            : `${integration.label} full sync started.`,
      },
    });
  } catch (error) {
    console.error(`[sync] ${integrationId} failed`, error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Sync failed",
      },
      { status: 500 }
    );
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  const { integrationId } = await params;

  try {
    const integration = await db.integration.findFirst({
      where: {
        OR: [
          { id: integrationId },
          { platform: integrationId.toUpperCase() as Platform },
        ],
      },
    });

    if (!integration) {
      return NextResponse.json(
        { error: `Integration "${integrationId}" not found` },
        { status: 404 }
      );
    }

    let lastJob = await db.syncJob.findFirst({
      where: { integrationId: integration.id },
      orderBy: { createdAt: "desc" },
    });
    if (lastJob?.status === "RUNNING" && isRunningJobStale(lastJob)) {
      await failStaleRunningJob(
        lastJob,
        "Marked failed automatically because the sync job exceeded the stale running threshold.",
      );
      lastJob = await db.syncJob.findFirst({
        where: { integrationId: integration.id },
        orderBy: { createdAt: "desc" },
      });
    }
    const recentWebhookEntries = await db.auditLog.findMany({
      where: { action: "webhook_received" },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        createdAt: true,
        details: true,
      },
    });

    const config = getIntegrationConfig(integration);
    const latestWebhook = recentWebhookEntries.find((entry) => {
      const details = (entry.details as Record<string, unknown>) ?? {};
      return details.platform === integration.platform;
    });
    const latestWebhookDetails = latestWebhook
      ? ((latestWebhook.details as Record<string, unknown>) ?? {})
      : null;
    const lastWebhookReceivedAt = latestWebhook?.createdAt ?? null;
    let rateLimits = isEbayPlatform(integration.platform)
      ? await getEbayTradingRateLimitSnapshotForIntegration(integration).catch((err) => {
          console.error(`[sync][GET][${integration.platform}] eBay rate limit fetch failed:`, err);
          return null;
        })
      : null;

    if (isEbayPlatform(integration.platform) && rateLimits && !rateLimits.isDegradedEstimate) {
      const updatedConfig = mergeIntegrationConfig(
        integration.platform,
        integration.config,
        { syncState: { lastRateLimitSnapshot: serializeSnapshotForConfig(rateLimits) } },
      );
      db.integration.update({
        where: { id: integration.id },
        data: { config: updatedConfig as unknown as Prisma.InputJsonValue },
      }).catch((err) =>
        console.error(`[sync][GET] Failed to persist rateLimits snapshot:`, err),
      );
    }

    if (isEbayPlatform(integration.platform) && !rateLimits) {
      const savedSnapshot = deserializeSnapshotFromConfig(config.syncState?.lastRateLimitSnapshot);
      if (savedSnapshot) {
        rateLimits = savedSnapshot;
      }
    }

    const sharedStoreCount = isEbayPlatform(integration.platform)
      ? await getSharedEbayQuotaStoreCount(integration)
      : 1;
    let cooldownUntil =
      getEbayCooldownUntilFromSnapshot(
        rateLimits,
        config.syncState.lastRateLimitMessage,
        new Date(),
      ) ??
      getEbayRateLimitCooldownUntil(
      integration.platform,
      config,
      new Date(),
      );

    // If this eBay integration has no recorded cooldown but another eBay
    // integration with the same appId does, inherit it — they share the same
    // developer app and quota pool.
    if (!cooldownUntil && isEbayPlatform(integration.platform)) {
      const appId =
        isRecord(integration.config) && typeof integration.config.appId === "string"
          ? integration.config.appId
          : null;
      if (appId) {
        const siblings = await db.integration.findMany({
          where: { platform: { in: ["TPP_EBAY", "TT_EBAY"] as Platform[] }, id: { not: integration.id } },
          select: { id: true, platform: true, config: true },
        });
        for (const sibling of siblings) {
          const sibCfg = getIntegrationConfig(sibling);
          const sibAppId =
            isRecord(sibling.config) && typeof sibling.config.appId === "string"
              ? sibling.config.appId
              : null;
          if (sibAppId !== appId) continue;
          const sibCooldown = getEbayRateLimitCooldownUntil(sibling.platform, sibCfg, new Date());
          if (sibCooldown && (!cooldownUntil || sibCooldown > cooldownUntil)) {
            cooldownUntil = sibCooldown;
          }
        }
      }
    }

    if (isEbayPlatform(integration.platform) && !rateLimits && cooldownUntil) {
      rateLimits = buildGetItemCooldownRateLimitsSnapshot(cooldownUntil);
    }

    // If we now have a cooldown but rateLimits is still just the generic healthy
    // placeholder, upgrade it to the exhausted cooldown snapshot.
    if (isEbayPlatform(integration.platform) && cooldownUntil && rateLimits?.isDegradedEstimate && rateLimits.exhaustedMethods.length === 0) {
      rateLimits = buildGetItemCooldownRateLimitsSnapshot(cooldownUntil);
    }

    const getItemRate = rateLimits ? getEbayMethodRate(rateLimits, "GetItem") : null;
    const reservedGetItemCalls =
      getItemRate && getItemRate.limit > 0 && !rateLimits?.isDegradedEstimate
        ? getReservedEbayGetItemCalls(getItemRate.limit, sharedStoreCount)
        : null;

    return NextResponse.json({
      data: {
        integrationId: integration.id,
        platform: integration.platform,
        label: integration.label,
        enabled: integration.enabled,
        lastSyncAt: integration.lastSyncAt,
        syncProfile: config.syncProfile,
        syncState: config.syncState,
        webhookState: config.webhookState,
        lastWebhookEvent: latestWebhook
          ? {
              topic:
                typeof latestWebhookDetails?.topic === "string"
                  ? latestWebhookDetails.topic
                  : null,
              status:
                typeof latestWebhookDetails?.status === "string"
                  ? latestWebhookDetails.status
                  : null,
              message:
                typeof latestWebhookDetails?.message === "string"
                  ? latestWebhookDetails.message
                  : null,
              receivedAt: lastWebhookReceivedAt?.toISOString() ?? null,
              relationToLastSync: getWebhookProofStatus(
                integration.lastSyncAt,
                lastWebhookReceivedAt,
              ),
            }
          : null,
        cooldown: {
          active: Boolean(cooldownUntil),
          until: cooldownUntil?.toISOString() ?? null,
          message: config.syncState.lastRateLimitMessage,
          retryLabel: formatCooldownRetryAt(cooldownUntil),
        },
        rateLimits,
        quotaPolicy: {
          reservedGetItemCalls,
        },
        webhookHealth: assessIntegrationWebhookHealth(integration),
        lastJob: lastJob
          ? {
              id: lastJob.id,
              status: lastJob.status,
              itemsProcessed: lastJob.itemsProcessed,
              itemsCreated: lastJob.itemsCreated,
              itemsUpdated: lastJob.itemsUpdated,
              errors: normalizeSyncErrors(lastJob.errors),
              startedAt: lastJob.startedAt,
              completedAt: lastJob.completedAt,
            }
          : null,
      },
    }, {
      headers: {
        "Cache-Control": "no-store, max-age=0, must-revalidate",
      },
    });
  } catch (error) {
    console.error(`[sync] GET ${integrationId} failed`, error);
    return NextResponse.json(
      { error: "Failed to fetch sync status" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  const { integrationId } = await params;

  try {
    const integration = await db.integration.findFirst({
      where: {
        OR: [
          { id: integrationId },
          { platform: integrationId.toUpperCase() as Platform },
        ],
      },
    });

    if (!integration) {
      return NextResponse.json(
        { error: `Integration "${integrationId}" not found` },
        { status: 404 },
      );
    }

    const runningJob = await db.syncJob.findFirst({
      where: { integrationId: integration.id, status: "RUNNING" },
      orderBy: { createdAt: "desc" },
    });

    if (!runningJob) {
      return NextResponse.json({
        data: {
          integrationId: integration.id,
          platform: integration.platform,
          status: "IDLE",
          message: `${integration.label} does not have a running sync to cancel.`,
        },
      });
    }

    await cancelRunningSyncJob(
      runningJob,
      "Cancelled by user from the Sync page.",
    );

    await db.integration.update({
      where: { id: integration.id },
      data: {
        config: mergeIntegrationConfig(
          integration.platform,
          integration.config,
          { syncState: { catalogPullResume: null } },
        ) as unknown as Prisma.InputJsonValue,
      },
    });

    return NextResponse.json({
      data: {
        integrationId: integration.id,
        platform: integration.platform,
        status: "CANCELLED",
        jobId: runningJob.id,
        message: `${integration.label} sync was cancelled.`,
      },
    });
  } catch (error) {
    console.error(`[sync] DELETE ${integrationId} failed`, error);
    return NextResponse.json(
      { error: "Failed to cancel sync" },
      { status: 500 },
    );
  }
}
