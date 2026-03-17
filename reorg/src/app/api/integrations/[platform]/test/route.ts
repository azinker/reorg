import { NextResponse, type NextRequest } from "next/server";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { EbayAdapter } from "@/lib/integrations/ebay";
import { BigCommerceAdapter } from "@/lib/integrations/bigcommerce";
import { ShopifyAdapter } from "@/lib/integrations/shopify";
import type { MarketplaceAdapter } from "@/lib/integrations/types";

const PLATFORMS: Platform[] = ["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"];

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getEnvConfig(platform: Platform) {
  switch (platform) {
    case "TPP_EBAY":
      return {
        appId: process.env.EBAY_TPP_APP_ID,
        certId: process.env.EBAY_TPP_CERT_ID,
        devId: process.env.EBAY_TPP_DEV_ID,
        refreshToken: process.env.EBAY_TPP_REFRESH_TOKEN,
        environment: process.env.EBAY_TPP_ENVIRONMENT ?? "PRODUCTION",
      };
    case "TT_EBAY":
      return {
        appId: process.env.EBAY_TT_APP_ID,
        certId: process.env.EBAY_TT_CERT_ID,
        devId: process.env.EBAY_TT_DEV_ID,
        refreshToken: process.env.EBAY_TT_REFRESH_TOKEN,
        environment: process.env.EBAY_TT_ENVIRONMENT ?? "PRODUCTION",
      };
    case "BIGCOMMERCE":
      return {
        storeHash: process.env.BIGCOMMERCE_STORE_HASH,
        accessToken: process.env.BIGCOMMERCE_ACCESS_TOKEN,
      };
    case "SHOPIFY":
      return {
        storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
        accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
        apiVersion: process.env.SHOPIFY_API_VERSION ?? "2026-01",
      };
  }
}

function buildAdapter(platform: Platform, config: Record<string, unknown>): MarketplaceAdapter {
  const envConfig = getEnvConfig(platform);

  switch (platform) {
    case "TPP_EBAY":
    case "TT_EBAY": {
      const appId = getString(config.appId) ?? getString(envConfig.appId);
      const certId = getString(config.certId) ?? getString(envConfig.certId);
      const devId = getString(config.devId) ?? getString(envConfig.devId) ?? "";
      const refreshToken = getString(config.refreshToken) ?? getString(envConfig.refreshToken);
      const environment = (getString(config.environment) ?? getString(envConfig.environment) ?? "PRODUCTION") as "SANDBOX" | "PRODUCTION";

      if (!appId || !certId || !refreshToken) {
        throw new Error("Missing eBay credentials. Add app ID, cert ID, and refresh token first.");
      }

      return new EbayAdapter(platform, platform === "TPP_EBAY" ? "The Perfect Part (eBay)" : "Telitetech (eBay)", {
        appId,
        certId,
        devId,
        refreshToken,
        environment,
      });
    }
    case "BIGCOMMERCE": {
      const storeHash = getString(config.storeHash) ?? getString(envConfig.storeHash);
      const accessToken = getString(config.accessToken) ?? getString(envConfig.accessToken);

      if (!storeHash || !accessToken) {
        throw new Error("Missing BigCommerce credentials. Add store hash and access token first.");
      }

      return new BigCommerceAdapter({ storeHash, accessToken });
    }
    case "SHOPIFY": {
      const storeDomain = getString(config.storeDomain) ?? getString(envConfig.storeDomain);
      const accessToken = getString(config.accessToken) ?? getString(envConfig.accessToken);
      const apiVersion = getString(config.apiVersion) ?? getString(envConfig.apiVersion) ?? "2026-01";

      if (!storeDomain || !accessToken) {
        throw new Error("Missing Shopify credentials. Connect Shopify or add store domain and access token first.");
      }

      return new ShopifyAdapter({ storeDomain, accessToken, apiVersion });
    }
  }
}

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

    const adapter = buildAdapter(platform as Platform, (integration.config as Record<string, unknown>) ?? {});
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
