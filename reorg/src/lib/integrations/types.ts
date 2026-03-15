import type { Platform } from "@prisma/client";

export interface RawListing {
  platformItemId: string;
  platformVariantId?: string;
  sku: string;
  title: string;
  imageUrl?: string;
  salePrice?: number;
  adRate?: number;
  inventory?: number;
  status: "active" | "out_of_stock";
  isVariation: boolean;
  parentPlatformItemId?: string;
  upc?: string;
  rawData: Record<string, unknown>;
}

export interface PriceUpdate {
  platformItemId: string;
  platformVariantId?: string;
  newPrice: number;
}

export interface AdRateUpdate {
  platformItemId: string;
  newAdRate: number;
}

export interface PushResult {
  success: boolean;
  itemsUpdated: number;
  errors: PushError[];
}

export interface PushError {
  platformItemId: string;
  message: string;
  code?: string;
  rawError?: unknown;
}

export interface InventoryMap {
  [platformItemId: string]: {
    quantity: number;
    variantQuantities?: Record<string, number>;
  };
}

export interface FetchListingsOptions {
  cursor?: string;
  pageSize?: number;
  status?: "active" | "out_of_stock" | "all";
}

export interface FetchListingsResult {
  listings: RawListing[];
  nextCursor?: string;
  hasMore: boolean;
  totalCount?: number;
}

/**
 * All marketplace integrations implement this interface.
 * CRITICAL: No delete methods. Ever.
 */
export interface MarketplaceAdapter {
  platform: Platform;
  label: string;

  testConnection(): Promise<{ ok: boolean; message: string }>;

  fetchListings(options?: FetchListingsOptions): Promise<FetchListingsResult>;

  fetchAllListings(): AsyncGenerator<RawListing[], void, unknown>;

  fetchInventory(itemIds: string[]): Promise<InventoryMap>;

  pushPriceUpdates(updates: PriceUpdate[]): Promise<PushResult>;

  pushAdRateUpdates(updates: AdRateUpdate[]): Promise<PushResult>;
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  TPP_EBAY: "TPP",
  TT_EBAY: "TT",
  BIGCOMMERCE: "BC",
  SHOPIFY: "SHPFY",
};

export const PLATFORM_FULL_LABELS: Record<Platform, string> = {
  TPP_EBAY: "The Perfect Part (eBay)",
  TT_EBAY: "Telitetech (eBay)",
  BIGCOMMERCE: "BigCommerce",
  SHOPIFY: "Shopify",
};
