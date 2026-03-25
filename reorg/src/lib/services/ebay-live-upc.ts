import { db } from "@/lib/db";
import { normalizeIntegrationConfig } from "@/lib/integrations/runtime-config";
import { Platform, Prisma } from "@prisma/client";
import { XMLParser } from "fast-xml-parser";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";

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
    ]);
    return alwaysArray.has(tagName);
  },
});

type EbayListingHydrateTarget = {
  id: string;
  masterRowId: string;
  platformItemId: string;
  rawData: unknown;
  integration: {
    id: string;
    platform: Platform;
    config: unknown;
  };
  masterRowUpc?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    const record = asRecord(value);
    const textValue = record ? firstString(record["#text"], record.value, record.Value) : null;
    if (textValue) {
      return textValue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = firstString(entry);
        if (nested) {
          return nested;
        }
      }
    }
  }
  return null;
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value != null) return [value];
  return [];
}

function extractSpecificsUpc(specifics: unknown): string | null {
  const specificsRecord = asRecord(specifics);
  if (!specificsRecord) return null;

  for (const entry of toArray(specificsRecord.NameValueList)) {
    const record = asRecord(entry);
    if (!record) continue;
    const name = firstString(record.Name, record.name);
    if (!name || !["UPC", "EAN", "GTIN", "ISBN"].includes(name.toUpperCase())) {
      continue;
    }

    const value = firstString(record.Value, record.value, record.ValueLiteral);
    if (value && value !== "Does not apply" && value !== "N/A") {
      return value;
    }
  }

  return null;
}

function isDoesNotApply(value: string): boolean {
  return value === "Does not apply" || value === "N/A";
}

function extractEbayUpc(rawData: unknown): string | null {
  const raw = asRecord(rawData);
  if (!raw) return null;
  const item = asRecord(raw.item);
  const variation = asRecord(raw.variation);

  if (variation) {
    const variationListingDetails = asRecord(variation.VariationProductListingDetails);
    const variationUpc = firstString(
      variationListingDetails?.UPC,
      variationListingDetails?.EAN,
      variationListingDetails?.GTIN,
      variationListingDetails?.ISBN,
    );
    if (variationUpc && !isDoesNotApply(variationUpc)) {
      return variationUpc;
    }

    const variationSpecificsUpc = extractSpecificsUpc(variation.VariationSpecifics);
    if (variationSpecificsUpc) {
      return variationSpecificsUpc;
    }

    const variationRawUpc = firstString(variation.upc, variation.UPC);
    if (variationRawUpc && !isDoesNotApply(variationRawUpc)) {
      return variationRawUpc;
    }

    const variationItemSpecificsUpc = extractSpecificsUpc(variation.ItemSpecifics);
    if (variationItemSpecificsUpc) {
      return variationItemSpecificsUpc;
    }

    return null;
  }

  const listingDetails = asRecord(raw.ProductListingDetails);
  const listingDetailsUpc = firstString(
    listingDetails?.UPC,
    listingDetails?.EAN,
    listingDetails?.GTIN,
    listingDetails?.ISBN,
  );
  if (listingDetailsUpc && !isDoesNotApply(listingDetailsUpc)) {
    return listingDetailsUpc;
  }

  const variationListingDetails = asRecord(raw.VariationProductListingDetails);
  const variationUpc = firstString(
    variationListingDetails?.UPC,
    variationListingDetails?.EAN,
    variationListingDetails?.GTIN,
    variationListingDetails?.ISBN,
  );
  if (variationUpc && !isDoesNotApply(variationUpc)) {
    return variationUpc;
  }

  const nestedListingDetails = asRecord(item?.ProductListingDetails);
  const nestedListingDetailsUpc = firstString(
    nestedListingDetails?.UPC,
    nestedListingDetails?.EAN,
    nestedListingDetails?.GTIN,
    nestedListingDetails?.ISBN,
  );
  if (nestedListingDetailsUpc && !isDoesNotApply(nestedListingDetailsUpc)) {
    return nestedListingDetailsUpc;
  }

  const product =
    asRecord(raw.product) ??
    asRecord(raw.Product) ??
    asRecord(item?.product) ??
    asRecord(item?.Product);
  const productUpc = firstString(product?.upc, product?.UPC, product?.EAN, product?.GTIN);
  if (productUpc) return productUpc;

  const rawUpc = firstString(
    raw.upc,
    raw.UPC,
    raw.ean,
    raw.EAN,
    raw.gtin,
    raw.GTIN,
    item?.upc,
    item?.UPC,
  );
  if (rawUpc && !isDoesNotApply(rawUpc)) {
    return rawUpc;
  }

  const rawSpecificsUpc =
    extractSpecificsUpc(raw.ItemSpecifics) ??
    extractSpecificsUpc(item?.ItemSpecifics);
  if (rawSpecificsUpc) {
    return rawSpecificsUpc;
  }

  const rawVariationSpecificsUpc = extractSpecificsUpc(raw.VariationSpecifics);
  if (rawVariationSpecificsUpc) {
    return rawVariationSpecificsUpc;
  }

  return null;
}

function getEbayCredentials(platform: Platform, rawConfig: unknown) {
  const config = normalizeIntegrationConfig(platform, rawConfig);
  if (platform === Platform.TPP_EBAY) {
    return {
      appId:
        typeof config.appId === "string" && config.appId.trim()
          ? config.appId
          : process.env.EBAY_TPP_APP_ID,
      certId:
        typeof config.certId === "string" && config.certId.trim()
          ? config.certId
          : process.env.EBAY_TPP_CERT_ID,
      refreshToken:
        typeof config.refreshToken === "string" && config.refreshToken.trim()
          ? config.refreshToken
          : process.env.EBAY_TPP_REFRESH_TOKEN,
      accessToken:
        typeof config.accessToken === "string" && config.accessToken.trim()
          ? config.accessToken
          : undefined,
      accessTokenExpiresAt:
        typeof config.accessTokenExpiresAt === "number"
          ? config.accessTokenExpiresAt
          : undefined,
    };
  }

  return {
    appId:
      typeof config.appId === "string" && config.appId.trim()
        ? config.appId
        : process.env.EBAY_TT_APP_ID ?? process.env.EBAY_TPP_APP_ID,
    certId:
      typeof config.certId === "string" && config.certId.trim()
        ? config.certId
        : process.env.EBAY_TT_CERT_ID ?? process.env.EBAY_TPP_CERT_ID,
    refreshToken:
      typeof config.refreshToken === "string" && config.refreshToken.trim()
        ? config.refreshToken
        : process.env.EBAY_TT_REFRESH_TOKEN,
    accessToken:
      typeof config.accessToken === "string" && config.accessToken.trim()
        ? config.accessToken
        : undefined,
    accessTokenExpiresAt:
      typeof config.accessTokenExpiresAt === "number"
        ? config.accessTokenExpiresAt
        : undefined,
  };
}

async function getAccessToken(target: EbayListingHydrateTarget) {
  const credentials = getEbayCredentials(target.integration.platform, target.integration.config);
  if (!credentials.appId || !credentials.certId || !credentials.refreshToken) {
    throw new Error(`Missing ${target.integration.platform} eBay credentials for live UPC hydrate.`);
  }

  if (
    credentials.accessToken &&
    credentials.accessTokenExpiresAt &&
    credentials.accessTokenExpiresAt > Date.now() + 60_000
  ) {
    return credentials.accessToken;
  }

  const auth = Buffer.from(`${credentials.appId}:${credentials.certId}`).toString("base64");
  const tokenResponse = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`eBay token refresh failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }

  const data = (await tokenResponse.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
  };
  const accessToken = data.access_token;
  if (!accessToken) {
    throw new Error("eBay token refresh returned no access token.");
  }

  const expiresIn = data.expires_in ?? 7200;
  const refreshExpiresIn = data.refresh_token_expires_in ?? 18 * 30 * 24 * 60 * 60;
  const accessTokenExpiresAt = Date.now() + expiresIn * 1000;
  const nextConfig = {
    ...(target.integration.config && typeof target.integration.config === "object"
      ? (target.integration.config as Record<string, unknown>)
      : {}),
    accessToken,
    accessTokenExpiresAt,
    refreshTokenExpiresAt: Date.now() + refreshExpiresIn * 1000,
  };

  await db.integration.update({
    where: { id: target.integration.id },
    data: {
      config: nextConfig as Prisma.InputJsonValue,
    },
  });

  return accessToken;
}

async function fetchFullItem(target: EbayListingHydrateTarget): Promise<unknown | null> {
  const accessToken = await getAccessToken(target);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${target.platformItemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
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
    throw new Error(`GetItem failed for ${target.platformItemId}: ${response.status} ${xml.slice(0, 300)}`);
  }

  const parsed = parser.parse(xml);
  const getItemResponse = asRecord(parsed?.GetItemResponse);
  const ack = firstString(getItemResponse?.Ack);
  const itemRaw = getItemResponse?.Item;
  const item = Array.isArray(itemRaw) ? itemRaw[0] : itemRaw;
  if ((ack === "Failure" || ack === "Warning") && !item) {
    throw new Error(`GetItem returned no item payload for ${target.platformItemId}.`);
  }

  return item ?? null;
}

export async function hydrateMissingEbayListingUpc(
  target: EbayListingHydrateTarget,
): Promise<string | null> {
  if (target.integration.platform !== Platform.TPP_EBAY && target.integration.platform !== Platform.TT_EBAY) {
    return null;
  }

  const storedUpc = extractEbayUpc(target.rawData);
  if (storedUpc) {
    return storedUpc;
  }

  const item = await fetchFullItem(target);
  const hydratedUpc = extractEbayUpc(item);
  if (!hydratedUpc) {
    return null;
  }

  await db.$transaction([
    db.marketplaceListing.update({
      where: { id: target.id },
      data: {
        rawData: JSON.parse(JSON.stringify(item ?? {})) as Prisma.InputJsonValue,
        lastSyncedAt: new Date(),
      },
    }),
    ...(target.masterRowUpc && target.masterRowUpc.trim().length > 0
      ? []
      : [
          db.masterRow.update({
            where: { id: target.masterRowId },
            data: { upc: hydratedUpc },
          }),
        ]),
  ]);

  return hydratedUpc;
}
