import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { Platform } from "@prisma/client";
import { z } from "zod";
import { startIntegrationSync } from "@/lib/services/sync-control";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";
import { assessIntegrationWebhookHealth } from "@/lib/webhook-health";
import {
  formatCooldownRetryAt,
  getEbayRateLimitCooldownUntil,
  isEbayPlatform,
} from "@/lib/services/ebay-rate-limit";
import {
  getEbayCooldownUntilFromSnapshot,
  getEbayMethodRate,
  getEbayTradingRateLimitSnapshotForIntegration,
} from "@/lib/services/ebay-analytics";
import { getSharedEbayQuotaStoreCount } from "@/lib/services/ebay-sync-budget";
import { getReservedEbayGetItemCalls } from "@/lib/services/ebay-sync-policy";

const postSchema = z
  .object({
    mode: z.enum(["full", "incremental"]).optional(),
  })
  .optional();

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

    const config = getIntegrationConfig(integration);
    const rateLimits = isEbayPlatform(integration.platform)
      ? await getEbayTradingRateLimitSnapshotForIntegration(integration).catch(() => null)
      : null;
    const sharedStoreCount = isEbayPlatform(integration.platform)
      ? await getSharedEbayQuotaStoreCount(integration)
      : 1;
    const getItemRate = rateLimits ? getEbayMethodRate(rateLimits, "GetItem") : null;
    const reservedGetItemCalls =
      getItemRate && getItemRate.limit > 0
        ? getReservedEbayGetItemCalls(getItemRate.limit, sharedStoreCount)
        : null;
    const cooldownUntil =
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
    if (cooldownUntil && isEbayPlatform(integration.platform)) {
      const retryAtLabel = formatCooldownRetryAt(cooldownUntil) ?? "the next retry window";
      const error =
        `eBay asked reorG to slow down after hitting its call-usage limit. ` +
        `Manual pulls are paused until ${retryAtLabel}.`;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((cooldownUntil.getTime() - Date.now()) / 1000),
      );

      return NextResponse.json(
        {
          error,
          data: {
            status: "COOLDOWN",
            cooldownUntil: cooldownUntil.toISOString(),
            cooldownMessage: config.syncState.lastRateLimitMessage,
            rateLimits,
            reservedGetItemCalls,
          },
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfterSeconds),
          },
        },
      );
    }

    const result = await startIntegrationSync(integration, {
      requestedMode: parsed.data?.mode,
      triggerSource: "manual",
    });

    if (result.status === "UNSUPPORTED") {
      return NextResponse.json({ error: result.message }, { status: 501 });
    }

    return NextResponse.json({ data: result });
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

    const lastJob = await db.syncJob.findFirst({
      where: { integrationId: integration.id },
      orderBy: { createdAt: "desc" },
    });

    const config = getIntegrationConfig(integration);
    const rateLimits = isEbayPlatform(integration.platform)
      ? await getEbayTradingRateLimitSnapshotForIntegration(integration).catch(() => null)
      : null;
    const sharedStoreCount = isEbayPlatform(integration.platform)
      ? await getSharedEbayQuotaStoreCount(integration)
      : 1;
    const getItemRate = rateLimits ? getEbayMethodRate(rateLimits, "GetItem") : null;
    const reservedGetItemCalls =
      getItemRate && getItemRate.limit > 0
        ? getReservedEbayGetItemCalls(getItemRate.limit, sharedStoreCount)
        : null;
    const cooldownUntil =
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
              errors: lastJob.errors,
              startedAt: lastJob.startedAt,
              completedAt: lastJob.completedAt,
            }
          : null,
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
