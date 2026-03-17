import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { Platform } from "@prisma/client";
import { mergeIntegrationConfig } from "@/lib/integrations/runtime-config";

const PLATFORMS: Platform[] = ["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"];
const syncProfileSchema = z
  .object({
    autoSyncEnabled: z.boolean().optional(),
    timezone: z.string().min(1).optional(),
    dayStartHour: z.number().int().min(0).max(23).optional(),
    dayEndHour: z.number().int().min(1).max(24).optional(),
    dayIntervalMinutes: z.number().int().positive().optional(),
    overnightIntervalMinutes: z.number().int().positive().optional(),
    preferredMode: z.enum(["full", "incremental"]).optional(),
    fullReconcileIntervalHours: z.number().int().positive().optional(),
    incrementalStrategy: z
      .enum([
        "full_only",
        "ebay_get_seller_events",
        "shopify_webhook_reconcile",
        "bigcommerce_webhook_reconcile",
      ])
      .optional(),
  })
  .partial();
const syncStateSchema = z
  .object({
    lastRequestedMode: z.enum(["full", "incremental"]).nullable().optional(),
    lastEffectiveMode: z.enum(["full", "incremental"]).nullable().optional(),
    lastScheduledSyncAt: z.string().datetime().nullable().optional(),
    lastFullSyncAt: z.string().datetime().nullable().optional(),
    lastIncrementalSyncAt: z.string().datetime().nullable().optional(),
    lastCursor: z.string().nullable().optional(),
    lastWebhookAt: z.string().datetime().nullable().optional(),
    lastFallbackReason: z.string().nullable().optional(),
  })
  .partial();
const configSchema = z
  .object({
    storeHash: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
    storeDomain: z.string().min(1).optional(),
    apiVersion: z.string().min(1).optional(),
    appId: z.string().min(1).optional(),
    certId: z.string().min(1).optional(),
    devId: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    environment: z.enum(["SANDBOX", "PRODUCTION"]).optional(),
    syncProfile: syncProfileSchema.optional(),
    syncState: syncStateSchema.optional(),
  })
  .partial();

const patchSchema = z.object({
  writeLocked: z.boolean().optional(),
  enabled: z.boolean().optional(),
  config: configSchema.optional(),
});

export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  try {
    const { platform } = await params;
    if (!PLATFORMS.includes(platform as Platform)) {
      return NextResponse.json({ error: "Invalid platform" }, { status: 400 });
    }

    const body = await _request.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const current = await db.integration.findUnique({
      where: { platform: platform as Platform },
    });

    if (!current) {
      return NextResponse.json(
        { error: "Integration not found" },
        { status: 404 }
      );
    }

    const nextConfig = parsed.data.config
      ? mergeIntegrationConfig(
          platform as Platform,
          current.config,
          parsed.data.config as Record<string, unknown>,
        )
      : current.config;

    const integration = await db.integration.update({
      where: { platform: platform as Platform },
      data: {
        ...(parsed.data.writeLocked != null
          ? { writeLocked: parsed.data.writeLocked }
          : {}),
        ...(parsed.data.enabled != null
          ? { enabled: parsed.data.enabled }
          : {}),
        ...(parsed.data.config
          ? { config: nextConfig as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });

    return NextResponse.json({
      data: {
        platform: integration.platform,
        writeLocked: integration.writeLocked,
        enabled: integration.enabled,
        config: integration.config,
      },
    });
  } catch (error) {
    console.error("[integrations] PATCH failed", error);
    return NextResponse.json(
      { error: "Failed to update integration" },
      { status: 500 }
    );
  }
}
