import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import type { Platform } from "@prisma/client";

const PLATFORMS: Platform[] = ["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"];
const configSchema = z
  .object({
    storeHash: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
    storeDomain: z.string().min(1).optional(),
    apiVersion: z.string().min(1).optional(),
    appId: z.string().min(1).optional(),
    certId: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
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

    const nextConfig = {
      ...((current.config as Record<string, unknown>) ?? {}),
      ...(parsed.data.config ?? {}),
    };

    const integration = await db.integration.update({
      where: { platform: platform as Platform },
      data: {
        ...(parsed.data.writeLocked != null
          ? { writeLocked: parsed.data.writeLocked }
          : {}),
        ...(parsed.data.enabled != null
          ? { enabled: parsed.data.enabled }
          : {}),
        ...(parsed.data.config ? { config: nextConfig } : {}),
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
