import { XMLParser } from "fast-xml-parser";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const GETITEM_CONCURRENCY = 4;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  isArray: (tagName) => {
    const alwaysArray = new Set([
      "Item",
      "Variation",
      "NameValueList",
      "PictureURL",
      "VariationSpecificPictureSet",
      "ShippingServiceOptions",
      "Value",
    ]);
    return alwaysArray.has(tagName);
  },
});

interface EbayConfig {
  appId: string;
  certId: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
}

export interface EbayBackupDetailRecord {
  platform: "TPP_EBAY" | "TT_EBAY";
  integrationId: string;
  platformItemId: string;
  sku: string;
  fetchedAt: string;
  detailRaw: Record<string, unknown>;
}

function getString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function getAccessToken(
  integrationId: string,
  config: EbayConfig
): Promise<string> {
  if (
    config.accessToken &&
    config.accessTokenExpiresAt &&
    config.accessTokenExpiresAt > Date.now() + 60_000
  ) {
    return config.accessToken;
  }

  const credentials = Buffer.from(`${config.appId}:${config.certId}`).toString(
    "base64"
  );

  const tokenRes = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`eBay token refresh failed: ${tokenRes.status} ${text}`);
  }

  const data = (await tokenRes.json()) as {
    access_token: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
  };
  const accessToken = data.access_token;
  const expiresIn = data.expires_in ?? 7200;
  const refreshExpiresIn = data.refresh_token_expires_in ?? 18 * 30 * 24 * 60 * 60;
  const expiresAt = Date.now() + expiresIn * 1000;

  await db.integration.update({
    where: { id: integrationId },
    data: {
      config: {
        ...config,
        accessToken,
        accessTokenExpiresAt: expiresAt,
        refreshTokenExpiresAt: Date.now() + refreshExpiresIn * 1000,
      },
    },
  });

  config.accessToken = accessToken;
  config.accessTokenExpiresAt = expiresAt;
  return accessToken;
}

async function fetchItemDetail(
  integrationId: string,
  config: EbayConfig,
  itemId: string
): Promise<Record<string, unknown>> {
  const accessToken = await getAccessToken(integrationId, config);

  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <OutputSelector>Title</OutputSelector>
  <OutputSelector>SubTitle</OutputSelector>
  <OutputSelector>Description</OutputSelector>
  <OutputSelector>PictureDetails</OutputSelector>
  <OutputSelector>ItemSpecifics</OutputSelector>
  <OutputSelector>ProductListingDetails</OutputSelector>
  <OutputSelector>Variations</OutputSelector>
  <OutputSelector>ShippingDetails</OutputSelector>
  <OutputSelector>ReturnPolicy</OutputSelector>
  <OutputSelector>ListingDetails</OutputSelector>
  <OutputSelector>SellerProfiles</OutputSelector>
  <OutputSelector>PrimaryCategory</OutputSelector>
  <OutputSelector>ConditionID</OutputSelector>
  <OutputSelector>ConditionDisplayName</OutputSelector>
</GetItemRequest>`;

  const response = await fetch(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": accessToken,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-CALL-NAME": "GetItem",
      "Content-Type": "text/xml",
    },
    body,
  });

  const xml = await response.text();
  if (!response.ok) {
    throw new Error(`GetItem HTTP ${response.status}: ${xml.slice(0, 400)}`);
  }

  const parsed = parser.parse(xml);
  const resp = getObject(parsed?.GetItemResponse);
  const ack = getString(resp?.Ack);
  if (ack === "Failure") {
    const message = getString(resp?.Errors) ?? "Unknown eBay error";
    throw new Error(`GetItem failed: ${message}`);
  }

  const itemRaw = resp?.Item;
  const item = Array.isArray(itemRaw) ? itemRaw[0] : itemRaw;
  const record = getObject(item);
  if (!record) {
    throw new Error(`GetItem returned no Item payload for ${itemId}`);
  }

  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

export async function fetchFullEbayBackupDetails(): Promise<{
  records: EbayBackupDetailRecord[];
  errors: Array<{ platform: Platform; platformItemId: string; message: string }>;
}> {
  const integrations = await db.integration.findMany({
    where: {
      enabled: true,
      platform: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] },
    },
    orderBy: { platform: "asc" },
  });

  const records: EbayBackupDetailRecord[] = [];
  const errors: Array<{
    platform: Platform;
    platformItemId: string;
    message: string;
  }> = [];

  for (const integration of integrations) {
    const config = integration.config as Record<string, unknown>;
    const ebayConfig: EbayConfig = {
      appId: String(config.appId ?? ""),
      certId: String(config.certId ?? ""),
      refreshToken: String(config.refreshToken ?? ""),
      accessToken:
        typeof config.accessToken === "string" ? config.accessToken : undefined,
      accessTokenExpiresAt:
        typeof config.accessTokenExpiresAt === "number"
          ? config.accessTokenExpiresAt
          : undefined,
    };

    if (!ebayConfig.appId || !ebayConfig.certId || !ebayConfig.refreshToken) {
      errors.push({
        platform: integration.platform,
        platformItemId: "_integration",
        message: `Missing credentials for ${integration.label}`,
      });
      continue;
    }

    const listings = await db.marketplaceListing.findMany({
      where: {
        integrationId: integration.id,
        platformVariantId: null,
      },
      select: {
        platformItemId: true,
        sku: true,
      },
      orderBy: { platformItemId: "asc" },
    });

    for (let i = 0; i < listings.length; i += GETITEM_CONCURRENCY) {
      const batch = listings.slice(i, i + GETITEM_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((listing) =>
          fetchItemDetail(integration.id, ebayConfig, listing.platformItemId)
        )
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const listing = batch[j];

        if (result.status === "fulfilled") {
          records.push({
            platform: integration.platform as "TPP_EBAY" | "TT_EBAY",
            integrationId: integration.id,
            platformItemId: listing.platformItemId,
            sku: listing.sku,
            fetchedAt: new Date().toISOString(),
            detailRaw: result.value,
          });
        } else {
          errors.push({
            platform: integration.platform,
            platformItemId: listing.platformItemId,
            message:
              result.reason instanceof Error
                ? result.reason.message
                : "Unknown eBay detail fetch error",
          });
        }
      }

      if (i + GETITEM_CONCURRENCY < listings.length) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  return { records, errors };
}
