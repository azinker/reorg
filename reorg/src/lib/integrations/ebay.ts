import type {
  MarketplaceAdapter,
  FetchListingsOptions,
  FetchListingsResult,
  RawListing,
  InventoryMap,
  PriceUpdate,
  AdRateUpdate,
  PushResult,
} from "@/lib/integrations/types";
import type { Platform } from "@prisma/client";

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

export class EbayAdapter implements MarketplaceAdapter {
  platform: Platform;
  label: string;
  private config: EbayConfig;
  private tokenCache: EbayTokenCache | null = null;
  private baseUrl: string;

  constructor(platform: Platform, label: string, config: EbayConfig) {
    this.platform = platform;
    this.label = label;
    this.config = config;
    this.baseUrl =
      config.environment === "PRODUCTION"
        ? "https://api.ebay.com"
        : "https://api.sandbox.ebay.com";
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.accessToken;
    }

    const credentials = Buffer.from(
      `${this.config.appId}:${this.config.certId}`
    ).toString("base64");

    const response = await fetch(`${this.baseUrl}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.config.refreshToken,
        scope: "https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.marketing https://api.ebay.com/oauth/api_scope/sell.fulfillment",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`eBay token refresh failed: ${response.status} ${error}`);
    }

    const data = await response.json();
    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    return this.tokenCache.accessToken;
  }

  private async apiCall(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("Retry-After") || "60");
      throw new Error(`eBay rate limit hit. Retry after ${retryAfter}s`);
    }

    return response;
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

  async fetchListings(
    options?: FetchListingsOptions
  ): Promise<FetchListingsResult> {
    const limit = options?.pageSize ?? 100;
    const offset = options?.cursor ? parseInt(options.cursor) : 0;

    const response = await this.apiCall(
      `/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`
    );

    if (!response.ok) {
      throw new Error(`eBay fetchListings failed: ${response.status}`);
    }

    const data = await response.json();
    const items = data.inventoryItems ?? [];

    const listings: RawListing[] = items.map((item: Record<string, unknown>) =>
      this.mapToRawListing(item)
    );

    return {
      listings,
      nextCursor:
        items.length === limit ? String(offset + limit) : undefined,
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
        const response = await this.apiCall(
          `/sell/inventory/v1/inventory_item/${itemId}`
        );
        if (response.ok) {
          const data = await response.json();
          inventoryMap[itemId] = {
            quantity:
              data.availability?.shipToLocationAvailability?.quantity ?? 0,
          };
        }
      } catch {
        // Log but don't fail entire batch for one item
      }
    }

    return inventoryMap;
  }

  async pushPriceUpdates(updates: PriceUpdate[]): Promise<PushResult> {
    const errors: PushResult["errors"] = [];
    let itemsUpdated = 0;

    for (const update of updates) {
      try {
        const response = await this.apiCall(
          `/sell/inventory/v1/offer/${update.platformItemId}`,
          {
            method: "PUT",
            body: JSON.stringify({
              pricingSummary: {
                price: {
                  value: update.newPrice.toFixed(2),
                  currency: "USD",
                },
              },
            }),
          }
        );

        if (response.ok) {
          itemsUpdated++;
        } else {
          const errData = await response.text();
          errors.push({
            platformItemId: update.platformItemId,
            message: `Price update failed: ${response.status}`,
            rawError: errData,
          });
        }
      } catch (error) {
        errors.push({
          platformItemId: update.platformItemId,
          message:
            error instanceof Error ? error.message : "Unknown error",
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
        const response = await this.apiCall(
          `/sell/marketing/v1/ad_campaign/update_ad_rate_strategy`,
          {
            method: "POST",
            body: JSON.stringify({
              listingId: update.platformItemId,
              bidPercentage: (update.newAdRate * 100).toFixed(1),
            }),
          }
        );

        if (response.ok) {
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
          message:
            error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return { success: errors.length === 0, itemsUpdated, errors };
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
