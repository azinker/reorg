import { XMLParser } from "fast-xml-parser";
import type {
  MarketplaceAdapter,
  FetchListingsOptions,
  FetchListingsResult,
  RawListing,
  InventoryMap,
  PriceUpdate,
  AdRateUpdate,
  UpcUpdate,
  PushResult,
} from "@/lib/integrations/types";
import type { Platform } from "@prisma/client";

const SITE_ID = "0";
const COMPAT_LEVEL = "1199";

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  isArray: (tagName) => {
    const alwaysArray = new Set([
      "Error",
      "Errors",
      "Item",
      "Variation",
      "NameValueList",
      "PictureURL",
      "VariationSpecificPictureSet",
    ]);
    return alwaysArray.has(tagName);
  },
});

interface EbayConfig {
  appId: string;
  certId: string;
  devId: string;
  refreshToken: string;
  environment: "SANDBOX" | "PRODUCTION";
}

interface EbayTokenCache {
  accessToken: string;
  expiresAt: number;
}

interface EbayMarketingCampaign {
  campaignId?: string;
  campaignStatus?: string;
  fundingStrategy?: {
    fundingModel?: string;
  };
}

interface EbayMarketingAd {
  adId?: string;
  listingId?: string;
  bidPercentage?: string;
}

class EbayTradingApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly rawError?: unknown,
  ) {
    super(message);
    this.name = "EbayTradingApiError";
  }
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeTradingErrors(rawErrors: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(rawErrors)) {
    return rawErrors.filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === "object" && !Array.isArray(entry),
    );
  }

  if (rawErrors && typeof rawErrors === "object") {
    return [rawErrors as Record<string, unknown>];
  }

  return [];
}

function readTradingText(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const raw = (source as Record<string, unknown>)[key];
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "object" && raw !== null) {
    const text = (raw as Record<string, unknown>)["#text"];
    if (typeof text === "string") return text;
    if (typeof text === "number" && Number.isFinite(text)) return String(text);
  }
  return undefined;
}

export class EbayAdapter implements MarketplaceAdapter {
  platform: Platform;
  label: string;
  private config: EbayConfig;
  private tokenCache: EbayTokenCache | null = null;
  private baseUrl: string;
  private tradingUrl: string;

  constructor(platform: Platform, label: string, config: EbayConfig) {
    this.platform = platform;
    this.label = label;
    this.config = config;
    this.baseUrl =
      config.environment === "PRODUCTION"
        ? "https://api.ebay.com"
        : "https://api.sandbox.ebay.com";
    this.tradingUrl =
      config.environment === "PRODUCTION"
        ? "https://api.ebay.com/ws/api.dll"
        : "https://api.sandbox.ebay.com/ws/api.dll";
  }

  private async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.accessToken;
    }

    const credentials = Buffer.from(`${this.config.appId}:${this.config.certId}`).toString("base64");

    const response = await fetch(`${this.baseUrl}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.config.refreshToken,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`eBay token refresh failed: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    return this.tokenCache.accessToken;
  }

  private clearAccessTokenCache() {
    this.tokenCache = null;
  }

  private async apiCall(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl}${endpoint}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...options.headers,
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("Retry-After") || "60", 10);
      throw new Error(`eBay rate limit hit. Retry after ${retryAfter}s`);
    }

    return response;
  }

  private async getActiveCostPerSaleCampaignIds(): Promise<string[]> {
    const response = await this.apiCall(
      "/sell/marketing/v1/ad_campaign?funding_strategy=COST_PER_SALE&limit=100",
    );

    if (!response.ok) {
      throw new Error(`Failed to load eBay promoted campaigns: ${response.status}`);
    }

    const data = (await response.json()) as {
      campaigns?: EbayMarketingCampaign[];
    };

    return (data.campaigns ?? [])
      .filter(
        (campaign) =>
          campaign.campaignId &&
          campaign.fundingStrategy?.fundingModel === "COST_PER_SALE" &&
          (campaign.campaignStatus === "RUNNING" || campaign.campaignStatus === "SCHEDULED"),
      )
      .map((campaign) => campaign.campaignId!)
      .filter(Boolean);
  }

  private async findPromotedAdForListing(
    listingId: string,
  ): Promise<{ campaignId: string; adId: string } | null> {
    const campaignIds = await this.getActiveCostPerSaleCampaignIds();

    for (const campaignId of campaignIds) {
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const response = await this.apiCall(
          `/sell/marketing/v1/ad_campaign/${campaignId}/ad?limit=500&offset=${offset}`,
        );

        if (!response.ok) {
          break;
        }

        const data = (await response.json()) as {
          ads?: EbayMarketingAd[];
          total?: number;
        };
        const ads = data.ads ?? [];
        const matchingAd = ads.find((ad) => ad.listingId === listingId && ad.adId);
        if (matchingAd?.adId) {
          return { campaignId, adId: matchingAd.adId };
        }

        offset += ads.length;
        hasMore = ads.length === 500 && (data.total == null || offset < data.total);
      }
    }

    return null;
  }

  private async tradingApiCall(
    callName: string,
    body: string,
    allowTokenRefresh = true,
  ): Promise<Record<string, unknown> | undefined> {
    const token = await this.getAccessToken();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(this.tradingUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "X-EBAY-API-IAF-TOKEN": token,
          "X-EBAY-API-SITEID": SITE_ID,
          "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
          "X-EBAY-API-CALL-NAME": callName,
          "Content-Type": "text/xml",
        },
        body,
      });

      const xml = await response.text();
      if (!response.ok) {
        throw new EbayTradingApiError(
          `${callName} failed: ${response.status} ${xml.slice(0, 400)}`,
          undefined,
          xml,
        );
      }

      const parsed = parser.parse(xml);
      const rootKey = `${callName}Response`;
      const tradingResponse = parsed?.[rootKey];
      const errors = normalizeTradingErrors(tradingResponse?.Errors);
      const errorCode = errors.map((entry) => readTradingText(entry, "ErrorCode")).find(Boolean);
      const severityErrors = errors.filter(
        (entry) => (readTradingText(entry, "SeverityCode") ?? "Error").toLowerCase() !== "warning",
      );
      const errorMessage =
        errors
          .map((entry) => readTradingText(entry, "LongMessage") ?? readTradingText(entry, "ShortMessage"))
          .find(Boolean) ??
        `${callName} returned an unknown Trading API error.`;
      const ack = readTradingText(tradingResponse, "Ack");

      if (errorCode === "21916984" && allowTokenRefresh) {
        this.clearAccessTokenCache();
        return this.tradingApiCall(callName, body, false);
      }

      if (ack === "Failure" || severityErrors.length > 0) {
        throw new EbayTradingApiError(errorMessage, errorCode, tradingResponse);
      }

      return tradingResponse;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.getAccessToken();
      return { ok: true, message: "Connected successfully" };
    } catch (error) {
      return {
        ok: false,
        message: `Connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  async fetchListings(options?: FetchListingsOptions): Promise<FetchListingsResult> {
    const limit = options?.pageSize ?? 100;
    const offset = options?.cursor ? parseInt(options.cursor, 10) : 0;

    const response = await this.apiCall(
      `/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`,
    );

    if (!response.ok) {
      throw new Error(`eBay fetchListings failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      inventoryItems?: Array<Record<string, unknown>>;
      total?: number;
    };
    const items = data.inventoryItems ?? [];

    const listings: RawListing[] = items.map((item) => this.mapToRawListing(item));

    return {
      listings,
      nextCursor: items.length === limit ? String(offset + limit) : undefined,
      hasMore: items.length === limit,
      totalCount: data.total,
    };
  }

  async *fetchAllListings(): AsyncGenerator<RawListing[], void, unknown> {
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const result = await this.fetchListings({ cursor, pageSize: 100 });
      if (result.listings.length > 0) {
        yield result.listings;
      }
      cursor = result.nextCursor;
      hasMore = result.hasMore;
    }
  }

  async fetchInventory(itemIds: string[]): Promise<InventoryMap> {
    const inventoryMap: InventoryMap = {};

    for (const itemId of itemIds) {
      try {
        const response = await this.apiCall(`/sell/inventory/v1/inventory_item/${itemId}`);
        if (response.ok) {
          const data = (await response.json()) as {
            availability?: {
              shipToLocationAvailability?: {
                quantity?: number;
              };
            };
          };
          inventoryMap[itemId] = {
            quantity: data.availability?.shipToLocationAvailability?.quantity ?? 0,
          };
        }
      } catch {
        // Ignore one-off inventory misses so the rest of the batch still loads.
      }
    }

    return inventoryMap;
  }

  async pushPriceUpdates(updates: PriceUpdate[]): Promise<PushResult> {
    const errors: PushResult["errors"] = [];
    let itemsUpdated = 0;

    for (const update of updates) {
      try {
        const inventoryStatus = [
          "<InventoryStatus>",
          `<ItemID>${escapeXml(update.platformItemId)}</ItemID>`,
          update.platformVariantId ? `<SKU>${escapeXml(update.platformVariantId)}</SKU>` : "",
          `<StartPrice currencyID=\"USD\">${update.newPrice.toFixed(2)}</StartPrice>`,
          "</InventoryStatus>",
        ].join("");

        const body = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${inventoryStatus}
</ReviseInventoryStatusRequest>`;

        await this.tradingApiCall("ReviseInventoryStatus", body);
        itemsUpdated += 1;
      } catch (error) {
        errors.push({
          platformItemId: update.platformItemId,
          platformVariantId: update.platformVariantId,
          message: error instanceof Error ? error.message : "Unknown error",
          rawError: error,
        });
      }
    }

    return {
      success: errors.length === 0,
      itemsUpdated,
      errors,
    };
  }

  async pushAdRateUpdates(updates: AdRateUpdate[]): Promise<PushResult> {
    const errors: PushResult["errors"] = [];
    let itemsUpdated = 0;

    for (const update of updates) {
      try {
        const adReference = await this.findPromotedAdForListing(update.platformItemId);
        if (!adReference) {
          errors.push({
            platformItemId: update.platformItemId,
            message:
              "Promoted ad not found for this eBay listing. Sync promoted listings first or confirm the listing is already enrolled in a CPS campaign.",
          });
          continue;
        }

        const response = await this.apiCall(
          `/sell/marketing/v1/ad_campaign/${adReference.campaignId}/ad/${adReference.adId}/update_bid`,
          {
            method: "POST",
            body: JSON.stringify({
              bidPercentage: (update.newAdRate * 100).toFixed(1),
            }),
          },
        );

        if (response.status === 204 || response.ok) {
          itemsUpdated++;
        } else {
          const errData = await response.text();
          errors.push({
            platformItemId: update.platformItemId,
            message: `Ad rate update failed: ${response.status}`,
            rawError: errData,
          });
        }
      } catch (error) {
        errors.push({
          platformItemId: update.platformItemId,
          message: error instanceof Error ? error.message : "Unknown error",
          rawError: error,
        });
      }
    }

    return { success: errors.length === 0, itemsUpdated, errors };
  }

  async pushUpcUpdates(updates: UpcUpdate[]): Promise<PushResult> {
    const errors: PushResult["errors"] = [];
    let itemsUpdated = 0;

    for (const update of updates) {
      try {
        const itemPayload = update.platformVariantId
          ? [
              "<Item>",
              `<ItemID>${escapeXml(update.platformItemId)}</ItemID>`,
              "<Variations>",
              "<Variation>",
              `<SKU>${escapeXml(update.platformVariantId)}</SKU>`,
              "<VariationProductListingDetails>",
              `<UPC>${escapeXml(update.newUpc)}</UPC>`,
              "</VariationProductListingDetails>",
              "</Variation>",
              "</Variations>",
              "</Item>",
            ].join("")
          : [
              "<Item>",
              `<ItemID>${escapeXml(update.platformItemId)}</ItemID>`,
              "<ProductListingDetails>",
              `<UPC>${escapeXml(update.newUpc)}</UPC>`,
              "</ProductListingDetails>",
              "</Item>",
            ].join("");

        const body = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${itemPayload}
</ReviseFixedPriceItemRequest>`;

        await this.tradingApiCall("ReviseFixedPriceItem", body);
        itemsUpdated += 1;
      } catch (error) {
        errors.push({
          platformItemId: update.platformItemId,
          platformVariantId: update.platformVariantId,
          message: error instanceof Error ? error.message : "Unknown error",
          rawError: error,
        });
      }
    }

    return {
      success: errors.length === 0,
      itemsUpdated,
      errors,
    };
  }

  private mapToRawListing(item: Record<string, unknown>): RawListing {
    const product = (item.product ?? {}) as Record<string, unknown>;
    const availability = (item.availability ?? {}) as Record<string, unknown>;
    const shipAvail = (availability.shipToLocationAvailability ?? {}) as Record<string, unknown>;

    return {
      platformItemId: item.sku as string,
      sku: item.sku as string,
      title: (product.title as string) ?? "",
      imageUrl: ((product.imageUrls as string[]) ?? [])[0],
      salePrice: undefined,
      adRate: undefined,
      inventory: (shipAvail.quantity as number) ?? 0,
      status: (shipAvail.quantity as number) > 0 ? "active" : "out_of_stock",
      isVariation: false,
      upc: ((product.upc as string[]) ?? [])[0],
      rawData: item,
    };
  }
}
