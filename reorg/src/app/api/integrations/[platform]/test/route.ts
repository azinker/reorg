import { NextResponse, type NextRequest } from "next/server";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { buildAdapter } from "@/lib/integrations/factory";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";

const PLATFORMS: Platform[] = ["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"];

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ platform: string }> },
) {
  try {
    const { platform } = await params;
    if (!PLATFORMS.includes(platform as Platform)) {
      return NextResponse.json({ error: "Invalid platform" }, { status: 400 });
    }

    const integration = await db.integration.findUnique({
      where: { platform: platform as Platform },
    });

    if (!integration) {
      return NextResponse.json({ error: "Integration not found" }, { status: 404 });
    }

    const adapter = buildAdapter(
      platform as Platform,
      getIntegrationConfig(integration),
    );
    const result = await adapter.testConnection();

    return NextResponse.json({
      data: {
        platform: integration.platform,
        ok: result.ok,
        message: result.message,
      },
    });
  } catch (error) {
    console.error("[integrations/test] POST failed", error);
    return NextResponse.json(
      {
        data: {
          ok: false,
          message: error instanceof Error ? error.message : "Connection test failed",
        },
      },
      { status: 200 },
    );
  }
}
