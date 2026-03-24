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

interface BigCommerceConfig {
  storeHash: string;
  accessToken: string;
}

export class BigCommerceAdapter implements MarketplaceAdapter {
  platform: Platform = "BIGCOMMERCE";
  label = "BigCommerce";
  // BigCommerce supports up to 250 products per page, but one product page can
  // expand into a very large listing batch once variants are flattened. Keep the
  // API page reasonably large while yielding smaller sync batches so progress is
  // visible quickly and long first batches do not trip stale-job guards.
  private static readonly SYNC_PAGE_SIZE = 25;
  private static readonly SYNC_LISTING_BATCH_SIZE = 50;
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private config: BigCommerceConfig;
  private baseUrl: string;

  constructor(config: BigCommerceConfig) {
    this.config = config;
    this.baseUrl = `https://api.bigcommerce.com/stores/${config.storeHash}/v3`;
  }

  private async apiCall(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      BigCommerceAdapter.REQUEST_TIMEOUT_MS
    );

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "X-Auth-Token": this.config.accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...options.headers,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `BigCommerce request timed out after ${BigCommerceAdapter.REQUEST_TIMEOUT_MS}ms`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      const retryAfter = parseInt(
        response.headers.get("X-Rate-Limit-Time-Reset-Ms") || "30000"
      );
      throw new Error(
        `BigCommerce rate limit hit. Retry after ${retryAfter}ms`
      );
    }

    return response;
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const response = await this.apiCall("/catalog/products?limit=1");
      if (response.ok) {
        return { ok: true, message: "Connected successfully" };
      }
      return {
        ok: false,
        message: `Connection failed: HTTP ${response.status}`,
      };
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
    const page = options?.cursor ? parseInt(options.cursor) : 1;
    const limit = Math.min(options?.pageSize ?? BigCommerceAdapter.SYNC_PAGE_SIZE, 250);

    const response = await this.apiCall(
      `/catalog/products?limit=${limit}&page=${page}&include=variants,images`
    );

    if (!response.ok) {
      throw new Error(`BigCommerce fetchListings failed: ${response.status}`);
    }

    const data = await response.json();
    const products = data.data ?? [];
    const pagination = data.meta?.pagination ?? {};

    const listings: RawListing[] = [];

    for (const product of products) {
      const variants = product.variants ?? [];

      if (variants.length <= 1) {
        listings.push(this.mapProductToListing(product, variants[0]));
      } else {
        for (const variant of variants) {
          listings.push(this.mapProductToListing(product, variant));
        }
      }
    }

    const hasMore = pagination.current_page < pagination.total_pages;

    return {
      listings,
      nextCursor: hasMore ? String(page + 1) : undefined,
      hasMore,
      totalCount: pagination.total,
    };
  }

  async *fetchAllListings(): AsyncGenerator<RawListing[], void, unknown> {
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const result = await this.fetchListings({
        cursor,
        pageSize: BigCommerceAdapter.SYNC_PAGE_SIZE,
      });
      if (result.listings.length > 0) {
        for (
          let index = 0;
          index < result.listings.length;
          index += BigCommerceAdapter.SYNC_LISTING_BATCH_SIZE
        ) {
          yield result.listings.slice(
            index,
            index + BigCommerceAdapter.SYNC_LISTING_BATCH_SIZE,
          );
        }
      }
      cursor = result.nextCursor;
      hasMore = result.hasMore;

      if (hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }

  async fetchListingsByProductId(productId: string): Promise<RawListing[]> {
    const response = await this.apiCall(
      `/catalog/products/${productId}?include=variants,images`
    );

    if (response.status === 404) {
      return [];
    }

    if (!response.ok) {
      throw new Error(
        `BigCommerce fetchListingsByProductId failed: ${response.status}`
      );
    }

    const data = await response.json();
    const product = data.data as Record<string, unknown> | undefined;

    if (!product) return [];

    const variants = (product.variants as Array<Record<string, unknown>>) ?? [];

    if (variants.length <= 1) {
      return [this.mapProductToListing(product, variants[0])];
    }

    return variants.map((variant) => this.mapProductToListing(product, variant));
  }

  async fetchInventory(itemIds: string[]): Promise<InventoryMap> {
    const inventoryMap: InventoryMap = {};

    for (const id of itemIds) {
      try {
        const response = await this.apiCall(`/catalog/products/${id}`);
        if (response.ok) {
          const data = await response.json();
          inventoryMap[id] = {
            quantity: data.data?.inventory_level ?? 0,
          };
        }
      } catch {
        // Continue on individual failure
      }
    }

    return inventoryMap;
  }

  async pushPriceUpdates(updates: PriceUpdate[]): Promise<PushResult> {
    const errors: PushResult["errors"] = [];
    let itemsUpdated = 0;

    for (const update of updates) {
      try {
        const endpoint = update.platformVariantId
          ? `/catalog/products/${update.platformItemId}/variants/${update.platformVariantId}`
          : `/catalog/products/${update.platformItemId}`;

        const response = await this.apiCall(endpoint, {
          method: "PUT",
          body: JSON.stringify({ price: update.newPrice }),
        });

        if (response.ok) {
          itemsUpdated++;
        } else {
          errors.push({
            platformItemId: update.platformItemId,
            message: `Price update failed: ${response.status}`,
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

  async pushAdRateUpdates(_updates: AdRateUpdate[]): Promise<PushResult> {
    // BigCommerce does not have promoted listing ad rates
    return { success: true, itemsUpdated: 0, errors: [] };
  }

  async pushUpcUpdates(updates: UpcUpdate[]): Promise<PushResult> {
    const errors: PushResult["errors"] = [];
    let itemsUpdated = 0;

    for (const update of updates) {
      try {
        const endpoint = update.platformVariantId
          ? `/catalog/products/${update.platformItemId}/variants/${update.platformVariantId}`
          : `/catalog/products/${update.platformItemId}`;

        const response = await this.apiCall(endpoint, {
          method: "PUT",
          body: JSON.stringify({ upc: update.newUpc }),
        });

        if (response.ok) {
          itemsUpdated++;
        } else {
          errors.push({
            platformItemId: update.platformItemId,
            message: `UPC update failed: ${response.status}`,
          });
        }
      } catch (error) {
        errors.push({
          platformItemId: update.platformItemId,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return { success: errors.length === 0, itemsUpdated, errors };
  }

  private mapProductToListing(
    product: Record<string, unknown>,
    variant?: Record<string, unknown>
  ): RawListing {
    const images = (product.images as Array<Record<string, unknown>>) ?? [];
    const inventory = variant
      ? (variant.inventory_level as number) ?? 0
      : (product.inventory_level as number) ?? 0;

    return {
      platformItemId: String(product.id),
      platformVariantId: variant ? String(variant.id) : undefined,
      parentPlatformItemId: variant ? String(product.id) : undefined,
      sku: (variant?.sku as string) ?? (product.sku as string) ?? "",
      title: (product.name as string) ?? "",
      imageUrl: images[0]?.url_standard as string | undefined,
      salePrice: (variant?.price as number) ?? (product.price as number),
      adRate: undefined,
      inventory,
      status: inventory > 0 ? "active" : "out_of_stock",
      isVariation: (product.variants as unknown[])?.length > 1,
      upc: (variant?.upc as string) ?? (product.upc as string),
      rawData: { product, variant },
    };
  }
}
