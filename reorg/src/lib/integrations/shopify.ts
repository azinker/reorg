import {
  type MarketplaceAdapter,
  type FetchListingsOptions,
  type FetchListingsResult,
  type RawListing,
  type InventoryMap,
  type PriceUpdate,
  type AdRateUpdate,
  type UpcUpdate,
  type PushResult,
  trimRawDataForStorage,
} from "@/lib/integrations/types";
import type { Platform } from "@prisma/client";
import { addMarketplaceInboundBytes } from "@/lib/server/marketplace-telemetry";

interface ShopifyConfig {
  storeDomain: string;
  accessToken: string;
  apiVersion: string;
}

export class ShopifyAdapter implements MarketplaceAdapter {
  platform: Platform = "SHOPIFY";
  label = "Shopify";
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private config: ShopifyConfig;
  private baseUrl: string;

  constructor(config: ShopifyConfig) {
    this.config = config;
    this.baseUrl = `https://${config.storeDomain}/admin/api/${config.apiVersion}`;
  }

  private async apiCall(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      ShopifyAdapter.REQUEST_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "X-Shopify-Access-Token": this.config.accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...options.headers,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `Shopify request timed out after ${ShopifyAdapter.REQUEST_TIMEOUT_MS}ms: ${endpoint}`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      const retryAfter = parseFloat(
        response.headers.get("Retry-After") || "2"
      );
      throw new Error(
        `Shopify rate limit hit. Retry after ${retryAfter}s`
      );
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      addMarketplaceInboundBytes(parseInt(contentLength, 10));
    }

    return response;
  }

  /** Safely parse JSON from a response; throw a clear error if body is HTML (e.g. login/error page). */
  private async parseJsonOrThrow(response: Response, context: string): Promise<unknown> {
    const contentType = response.headers.get("Content-Type") ?? "";
    const isJson =
      contentType.includes("application/json") ||
      contentType.includes("application/javascript");
    const text = await response.text();
    if (!isJson || text.trimStart().startsWith("<")) {
      const snippet = text.slice(0, 120).replace(/\s+/g, " ");
      throw new Error(
        `${context}: Shopify returned an HTML page instead of JSON (check store domain and access token). Response: ${snippet}`
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `${context}: Invalid JSON from Shopify. Response: ${text.slice(0, 120)}`
      );
    }
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const response = await this.apiCall("/shop.json");
      if (response.ok) {
        const data = (await this.parseJsonOrThrow(
          response,
          "testConnection"
        )) as { shop?: { name?: string } };
        return {
          ok: true,
          message: `Connected to ${data.shop?.name ?? "Shopify store"}`,
        };
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
    const limit = options?.pageSize ?? 50;

    let endpoint: string;
    if (options?.cursor) {
      endpoint = `/products.json?limit=${limit}&page_info=${options.cursor}`;
    } else {
      endpoint = `/products.json?limit=${limit}&status=active`;
    }

    const response = await this.apiCall(endpoint);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Shopify fetchListings failed: ${response.status} ${text.slice(0, 200)}`
      );
    }

    const data = (await this.parseJsonOrThrow(
      response,
      "fetchListings"
    )) as { products?: Record<string, unknown>[] };
    const products = data.products ?? [];

    const listings: RawListing[] = [];

    for (const product of products) {
      const variants = (product.variants as Record<string, unknown>[] | undefined) ?? [];

      for (const variant of variants) {
        listings.push(this.mapVariantToListing(product, variant));
      }
    }

    const linkHeader = response.headers.get("Link") ?? "";
    const nextMatch = linkHeader.match(
      /<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/
    );
    const hasMore = !!nextMatch;

    return {
      listings,
      nextCursor: nextMatch ? nextMatch[1] : undefined,
      hasMore,
    };
  }

  async *fetchAllListings(): AsyncGenerator<RawListing[], void, unknown> {
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const result = await this.fetchListings({ cursor, pageSize: 250 });
      if (result.listings.length > 0) {
        yield result.listings;
      }
      cursor = result.nextCursor;
      hasMore = result.hasMore;

      await new Promise((resolve) => setTimeout(resolve, 550));
    }
  }

  async fetchListingsByProductId(productId: string): Promise<RawListing[]> {
    const response = await this.apiCall(`/products/${productId}.json`);

    if (response.status === 404) {
      return [];
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Shopify fetchListingsByProductId failed: ${response.status} ${text.slice(0, 200)}`
      );
    }

    const data = (await this.parseJsonOrThrow(
      response,
      "fetchListingsByProductId"
    )) as { product?: Record<string, unknown> };

    const product = data.product;
    if (!product) return [];

    const variants = (product.variants as Record<string, unknown>[] | undefined) ?? [];

    return variants.map((variant) => this.mapVariantToListing(product, variant));
  }

  async fetchInventory(itemIds: string[]): Promise<InventoryMap> {
    const inventoryMap: InventoryMap = {};

    for (const productId of itemIds) {
      try {
        const response = await this.apiCall(
          `/products/${productId}/variants.json`
        );
        if (response.ok) {
          const data = (await this.parseJsonOrThrow(
            response,
            "fetchInventory"
          )) as { variants?: Record<string, unknown>[] };
          const variants = data.variants ?? [];
          const totalQty = variants.reduce(
            (sum: number, v: Record<string, unknown>) =>
              sum + ((v.inventory_quantity as number) ?? 0),
            0
          );
          inventoryMap[productId] = {
            quantity: totalQty,
            variantQuantities: Object.fromEntries(
              variants.map((v: Record<string, unknown>) => [
                String(v.id),
                (v.inventory_quantity as number) ?? 0,
              ])
            ),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 600));
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
        const variantId = update.platformVariantId ?? update.platformItemId;

        const response = await this.apiCall(
          `/variants/${variantId}.json`,
          {
            method: "PUT",
            body: JSON.stringify({
              variant: { price: update.newPrice.toFixed(2) },
            }),
          }
        );

        if (response.ok) {
          itemsUpdated++;
        } else {
          errors.push({
            platformItemId: update.platformItemId,
            message: `Price update failed: ${response.status}`,
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 600));
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
    // Shopify does not have promoted listing ad rates
    return { success: true, itemsUpdated: 0, errors: [] };
  }

  async pushUpcUpdates(updates: UpcUpdate[]): Promise<PushResult> {
    const errors: PushResult["errors"] = [];
    let itemsUpdated = 0;

    for (const update of updates) {
      try {
        const variantId = update.platformVariantId ?? update.platformItemId;
        const response = await this.apiCall(`/variants/${variantId}.json`, {
          method: "PUT",
          body: JSON.stringify({
            variant: { barcode: update.newUpc },
          }),
        });

        if (response.ok) {
          itemsUpdated++;
        } else {
          errors.push({
            platformItemId: update.platformItemId,
            message: `UPC update failed: ${response.status}`,
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 600));
      } catch (error) {
        errors.push({
          platformItemId: update.platformItemId,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return { success: errors.length === 0, itemsUpdated, errors };
  }

  private mapVariantToListing(
    product: Record<string, unknown>,
    variant: Record<string, unknown>
  ): RawListing {
    const images = (product.images as Array<Record<string, unknown>>) ?? [];
    const inventory = (variant.inventory_quantity as number) ?? 0;
    const hasMultipleVariants = ((product.variants as unknown[]) ?? []).length > 1;

    return {
      platformItemId: String(product.id),
      platformVariantId: String(variant.id),
      sku: (variant.sku as string) ?? "",
      title: (product.title as string) ?? "",
      imageUrl: images[0]?.src as string | undefined,
      salePrice: parseFloat((variant.price as string) ?? "0"),
      adRate: undefined,
      inventory,
      status: inventory > 0 ? "active" : "out_of_stock",
      isVariation: hasMultipleVariants,
      parentPlatformItemId: hasMultipleVariants ? String(product.id) : undefined,
      upc: (variant.barcode as string) ?? undefined,
      rawData: trimRawDataForStorage({ product, variant }, "SHOPIFY"),
    };
  }
}
