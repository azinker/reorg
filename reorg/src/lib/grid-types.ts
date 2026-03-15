export type Platform = "TPP_EBAY" | "TT_EBAY" | "BIGCOMMERCE" | "SHOPIFY";

export const PLATFORM_SHORT: Record<Platform, string> = {
  TPP_EBAY: "TPP",
  TT_EBAY: "TT",
  BIGCOMMERCE: "BC",
  SHOPIFY: "SHPFY",
};

export const PLATFORM_COLORS: Record<Platform, string> = {
  TPP_EBAY: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  TT_EBAY: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  BIGCOMMERCE: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  SHOPIFY: "bg-lime-500/15 text-lime-400 border-lime-500/30",
};

export const PLATFORM_COLORS_LIGHT: Record<Platform, string> = {
  TPP_EBAY: "bg-blue-50 text-blue-700 border-blue-200",
  TT_EBAY: "bg-emerald-50 text-emerald-700 border-emerald-200",
  BIGCOMMERCE: "bg-orange-50 text-orange-700 border-orange-200",
  SHOPIFY: "bg-lime-50 text-lime-700 border-lime-200",
};

export interface StoreValue {
  platform: Platform;
  listingId: string;
  variantId?: string;
  value: number | string | null;
  stagedValue?: number | string | null;
  url?: string;
}

export interface GridRow {
  id: string;
  sku: string;
  title: string;
  upc: string | null;
  imageUrl: string | null;
  imageSource?: string;
  weight: string | null;
  supplierCost: number | null;
  supplierShipping: number | null;
  shippingCost: number | null;
  platformFeeRate: number;
  inventory: number | null;
  isVariation: boolean;
  isParent: boolean;
  childRows?: GridRow[];
  expanded?: boolean;
  alternateTitles?: string[];

  itemNumbers: StoreValue[];
  salePrices: StoreValue[];
  adRates: StoreValue[];
  profits: StoreValue[];

  hasStagedChanges: boolean;
}

export type FilterState = {
  marketplace: Platform | "all";
  stockStatus: "all" | "in_stock" | "out_of_stock";
  stagedOnly: boolean;
  missingData: MissingDataFilter | null;
  priceMin: number | null;
  priceMax: number | null;
  profitMin: number | null;
  profitMax: number | null;
};

export type MissingDataFilter =
  | "missing_upc"
  | "missing_image"
  | "missing_weight"
  | "missing_supplier_cost"
  | "missing_supplier_shipping"
  | "missing_shipping_rate"
  | "missing_linkage";
