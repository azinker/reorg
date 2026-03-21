import { NextResponse, type NextRequest } from "next/server";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { buildAdapter } from "@/lib/integrations/factory";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";
import { fetchEbaySellerProfile, refreshEbayAccessToken } from "@/lib/ebay-account";

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
    const config = getIntegrationConfig(integration);
    const isEbay = platform === "TPP_EBAY" || platform === "TT_EBAY";
    let seller: { userId: string | null; storeName: string | null; sellerLevel: string | null } | null = null;

    if (
      result.ok &&
      isEbay &&
      typeof config.appId === "string" &&
      config.appId.length > 0 &&
      typeof config.certId === "string" &&
      config.certId.length > 0 &&
      typeof config.refreshToken === "string" &&
      config.refreshToken.length > 0
    ) {
      const refreshed = await refreshEbayAccessToken({
        appId: config.appId,
        certId: config.certId,
        refreshToken: config.refreshToken,
        environment: config.environment === "SANDBOX" ? "SANDBOX" : "PRODUCTION",
      }).catch(() => null);

      if (refreshed?.accessToken) {
      seller = await fetchEbaySellerProfile(
        refreshed.accessToken,
        (config.environment === "SANDBOX" ? "SANDBOX" : "PRODUCTION"),
      ).catch(() => null);
      }
    }

    return NextResponse.json({
      data: {
        platform: integration.platform,
        ok: result.ok,
        message: result.message,
        seller,
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
