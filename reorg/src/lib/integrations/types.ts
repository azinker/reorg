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

export interface UpcUpdate {
  platformItemId: string;
  platformVariantId?: string;
  newUpc: string;
}

export interface PushResult {
  success: boolean;
  itemsUpdated: number;
  errors: PushError[];
}

export interface PushError {
  platformItemId: string;
  platformVariantId?: string;
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

  pushUpcUpdates(updates: UpcUpdate[]): Promise<PushResult>;
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  TPP_EBAY: "TPP",
  TT_EBAY: "TT",
  BIGCOMMERCE: "BC",
  SHOPIFY: "SHPFY",
  AMAZON: "AMZ",
};

export const PLATFORM_FULL_LABELS: Record<Platform, string> = {
  TPP_EBAY: "The Perfect Part (eBay)",
  TT_EBAY: "Telitetech (eBay)",
  BIGCOMMERCE: "BigCommerce",
  SHOPIFY: "Shopify",
  AMAZON: "Amazon",
};

const EBAY_STRIP_KEYS = new Set([
  "Description",
  "PictureDetails",
  "ShippingDetails",
  "ReturnPolicy",
  "SellerProfiles",
  "PaymentMethods",
  "Subtitle",
  "ConditionDescription",
  "BuyerRequirementDetails",
  "ListingDesigner",
  "ShipToLocations",
  "ExtendedSellerContactDetails",
  "ThirdPartyCheckout",
  "PickupInStoreDetails",
  "eBayPlus",
  "PostCheckoutExperienceEnabled",
]);

const BIGCOMMERCE_STRIP_KEYS = new Set([
  "description",
  "meta_description",
  "search_keywords",
]);

const SHOPIFY_STRIP_KEYS = new Set([
  "body_html",
  "template_suffix",
  "metafields_global_title_tag",
  "metafields_global_description_tag",
]);

function stripKeys(obj: Record<string, unknown>, keys: Set<string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.has(k)) result[k] = v;
  }
  return result;
}

/**
 * Strip heavy, unused fields from marketplace API responses before storing in
 * the database. The trimmed fields (HTML descriptions, picture URLs already
 * extracted, shipping policies, etc.) are never read back by reorG.
 *
 * Fields preserved: ItemSpecifics, ProductListingDetails, VariationSpecifics,
 * Variations (structural), SKU, Title, SellingStatus, Quantity, and all other
 * fields not explicitly listed in the strip sets above.
 */
export function trimRawDataForStorage(
  data: Record<string, unknown>,
  platform?: string,
): Record<string, unknown> {
  if (!data || typeof data !== "object") return data;

  if (platform === "BIGCOMMERCE") return stripKeys(data, BIGCOMMERCE_STRIP_KEYS);
  if (platform === "SHOPIFY") {
    const trimmed = stripKeys(data, SHOPIFY_STRIP_KEYS);
    if (trimmed.product && typeof trimmed.product === "object") {
      trimmed.product = stripKeys(trimmed.product as Record<string, unknown>, SHOPIFY_STRIP_KEYS);
    }
    return trimmed;
  }

  const trimmed = stripKeys(data, EBAY_STRIP_KEYS);
  if (trimmed.variation && typeof trimmed.variation === "object") {
    trimmed.variation = stripKeys(trimmed.variation as Record<string, unknown>, EBAY_STRIP_KEYS);
  }
  if (trimmed.item && typeof trimmed.item === "object") {
    trimmed.item = stripKeys(trimmed.item as Record<string, unknown>, EBAY_STRIP_KEYS);
  }
  return trimmed;
}
