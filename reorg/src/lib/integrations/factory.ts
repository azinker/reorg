import { Platform } from "@prisma/client";
import { EbayAdapter } from "@/lib/integrations/ebay";
import { BigCommerceAdapter } from "@/lib/integrations/bigcommerce";
import { ShopifyAdapter } from "@/lib/integrations/shopify";
import type { MarketplaceAdapter } from "@/lib/integrations/types";

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

export function hasConnectedCredentials(
  platform: Platform,
  rawConfig: Record<string, unknown>,
): boolean {
  const envConfig = getEnvConfig(platform);

  switch (platform) {
    case "TPP_EBAY":
    case "TT_EBAY":
      return !!(
        getString(rawConfig.refreshToken) ?? getString(envConfig.refreshToken)
      );
    case "BIGCOMMERCE":
      return !!(
        (getString(rawConfig.storeHash) ?? getString(envConfig.storeHash)) &&
        (getString(rawConfig.accessToken) ?? getString(envConfig.accessToken))
      );
    case "SHOPIFY":
      return !!(
        (getString(rawConfig.storeDomain) ?? getString(envConfig.storeDomain)) &&
        (getString(rawConfig.accessToken) ?? getString(envConfig.accessToken))
      );
  }
}

export function buildAdapter(
  platform: Platform,
  rawConfig: Record<string, unknown>,
): MarketplaceAdapter {
  const envConfig = getEnvConfig(platform);

  switch (platform) {
    case "TPP_EBAY":
    case "TT_EBAY": {
      const appId = getString(rawConfig.appId) ?? getString(envConfig.appId);
      const certId =
        getString(rawConfig.certId) ?? getString(envConfig.certId);
      const devId = getString(rawConfig.devId) ?? getString(envConfig.devId) ?? "";
      const refreshToken =
        getString(rawConfig.refreshToken) ?? getString(envConfig.refreshToken);
      const environment = (
        getString(rawConfig.environment) ??
        getString(envConfig.environment) ??
        "PRODUCTION"
      ) as "SANDBOX" | "PRODUCTION";

      if (!appId || !certId || !refreshToken) {
        throw new Error(
          "Missing eBay credentials. Add app ID, cert ID, and refresh token first.",
        );
      }

      return new EbayAdapter(
        platform,
        platform === "TPP_EBAY"
          ? "The Perfect Part (eBay)"
          : "Telitetech (eBay)",
        {
          appId,
          certId,
          devId,
          refreshToken,
          environment,
        },
      );
    }
    case "BIGCOMMERCE": {
      const storeHash =
        getString(rawConfig.storeHash) ?? getString(envConfig.storeHash);
      const accessToken =
        getString(rawConfig.accessToken) ?? getString(envConfig.accessToken);

      if (!storeHash || !accessToken) {
        throw new Error(
          "Missing BigCommerce credentials. Add store hash and access token first.",
        );
      }

      return new BigCommerceAdapter({ storeHash, accessToken });
    }
    case "SHOPIFY": {
      const storeDomain =
        getString(rawConfig.storeDomain) ?? getString(envConfig.storeDomain);
      const accessToken =
        getString(rawConfig.accessToken) ?? getString(envConfig.accessToken);
      const apiVersion =
        getString(rawConfig.apiVersion) ??
        getString(envConfig.apiVersion) ??
        "2026-01";

      if (!storeDomain || !accessToken) {
        throw new Error(
          "Missing Shopify credentials. Connect Shopify or add store domain and access token first.",
        );
      }

      return new ShopifyAdapter({ storeDomain, accessToken, apiVersion });
    }
  }
}
