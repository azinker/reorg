export type Platform = "TPP_EBAY" | "TT_EBAY" | "BIGCOMMERCE" | "SHOPIFY";

export const PLATFORM_SHORT: Record<Platform, string> = {
  TPP_EBAY: "TPP",
  TT_EBAY: "TT",
  BIGCOMMERCE: "BC",
  SHOPIFY: "SHPFY",
};

export const PLATFORM_FULL: Record<Platform, string> = {
  TPP_EBAY: "The Perfect Part (eBay)",
  TT_EBAY: "Telitetech (eBay)",
  BIGCOMMERCE: "BigCommerce",
  SHOPIFY: "Shopify",
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
  marketplaceListingId?: string | null;
  variantId?: string;
  value: number | string | null;
  stagedValue?: number | string | null;
  url?: string;
}

export interface UpcPushTarget {
  platform: Platform;
  listingId: string;
  marketplaceListingId: string | null;
  variantId?: string;
  stagedChangeId?: string | null;
}

export interface GridRow {
  id: string;
  sku: string;
  title: string;
  upc: string | null;
  stagedUpc?: string | null;
  hasStagedUpc?: boolean;
  upcPushTargets?: UpcPushTarget[];
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
  childRowsHydrated?: boolean;
  expanded?: boolean;
  alternateTitles?: { title: string; platform: Platform; listingId: string }[];

  itemNumbers: StoreValue[];
  salePrices: StoreValue[];
  adRates: StoreValue[];
  profits: StoreValue[];
  platformFees: StoreValue[];

  hasStagedChanges: boolean;
}

export type StockFilter = "all" | "in_stock" | "out_of_stock" | "low_stock";

export type FilterState = {
  marketplace: Platform | "all";
  stockStatus: StockFilter;
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

export const HEADER_TOOLTIPS: Record<string, string> = {
  photo: "Product image from the master store listing. Click to expand.",
  upc: "Universal Product Code — a unique barcode identifier for the product.",
  itemIds: "Marketplace-specific listing/item IDs. Click to open the listing on the marketplace.",
  sku: "Stock Keeping Unit — the master-store SKU used as the row's identity key.",
  title: "Product title from the master store. Alternate titles flagged if mismatched across stores.",
  qty: "Current inventory quantity across all warehouses. 0 = out of stock, <25 = low stock.",
  salePrice: "Current sale price per marketplace. Purple = staged (pending push), green = live.",
  weight: "Product weight used to calculate shipping cost. Format: Xoz or XLBS.",
  supplierCost: "Cost paid to the supplier for this product (cost of goods).",
  suppShip: "Shipping cost charged by the supplier to receive this product.",
  shipCost: "Calculated outbound shipping cost based on product weight and the shipping rate table.",
  platformFees: "Total platform/marketplace fees (e.g., eBay final value fee). Calculated as sale price × fee rate.",
  adRate: "Promoted listing general ad rate per marketplace. eBay only in v1; BC/Shopify show N/A.",
  profit: "Net profit = Sale Price − Supplier Cost − Supplier Shipping − Shipping Cost − Platform Fees − Ad Spend.",
};

export interface ColumnConfig {
  id: string;
  label: string;
  visible: boolean;
  frozen?: boolean;
}

export function calcProfit(
  sale: number,
  supplierCost: number,
  supplierShipping: number,
  shippingCost: number,
  feeRate: number,
  adRate: number
): number {
  const fee = sale * feeRate;
  const ad = sale * adRate;
  return Math.round((sale - supplierCost - supplierShipping - shippingCost - fee - ad) * 100) / 100;
}

export function calcFee(sale: number, feeRate: number): number {
  return Math.round(sale * feeRate * 100) / 100;
}

export const DEFAULT_COLUMNS: ColumnConfig[] = [
  { id: "photo", label: "Photo", visible: true, frozen: true },
  { id: "upc", label: "UPC", visible: true, frozen: true },
  { id: "itemIds", label: "Item IDs", visible: true, frozen: true },
  { id: "sku", label: "SKU", visible: true, frozen: true },
  { id: "title", label: "Title", visible: true, frozen: true },
  { id: "qty", label: "Live Quantity", visible: true },
  { id: "salePrice", label: "Sale Price", visible: true },
  { id: "weight", label: "Weight", visible: true },
  { id: "supplierCost", label: "Supplier Cost of Good", visible: true },
  { id: "suppShip", label: "Supplier Shipping Cost", visible: true },
  { id: "shipCost", label: "Outbound Shipping Cost", visible: true },
  { id: "platformFees", label: "Total Platform Fees", visible: true },
  { id: "adRate", label: "Promoted General Ad Rate", visible: true },
  { id: "profit", label: "Profit", visible: true },
];
