import type { Platform } from "@/lib/grid-types";

export type LiveUpcLine =
  | {
      kind: "all";
      label: string;
      value: string;
      state?: "live";
    }
  | {
      kind: "platform";
      platform: Platform;
      label: string;
      value: string | null;
      state: "live" | "missing" | "pending_refresh" | "not_found";
    };

export type LiveUpcChoice = {
  platform: Platform;
  label: string;
  value: string | null;
  editable: boolean;
  state?: "live" | "missing" | "pending_refresh" | "not_found";
};

export type ListingUpcSource = {
  rawData: unknown;
  integration: {
    platform: Platform;
  };
};

const PLATFORM_ORDER: Platform[] = ["TPP_EBAY", "TT_EBAY", "SHOPIFY", "BIGCOMMERCE"];
const PLATFORM_SHORT: Record<Platform, string> = {
  TPP_EBAY: "TPP",
  TT_EBAY: "TT",
  BIGCOMMERCE: "BC",
  SHOPIFY: "SHPFY",
  AMAZON: "AMZ",
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
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim().length > 0) {
          return entry.trim();
        }
        if (typeof entry === "number" && Number.isFinite(entry)) {
          return String(entry);
        }
      }
    }
    const record = asRecord(value);
    if (record) {
      const textValue = firstString(record["#text"], record.value, record.Value);
      if (textValue) {
        return textValue;
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

function hasMeaningfulPayload(rawData: unknown): boolean {
  if (!rawData || typeof rawData !== "object") {
    return false;
  }
  if (Array.isArray(rawData)) {
    return rawData.length > 0;
  }
  return Object.keys(rawData as Record<string, unknown>).length > 0;
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

function extractListingUpc(platform: Platform, rawData: unknown): string | null {
  const raw = asRecord(rawData);
  if (!raw) return null;

  if (platform === "SHOPIFY") {
    const variant = asRecord(raw.variant);
    const product = asRecord(raw.product);
    const productVariants = Array.isArray(product?.variants)
      ? (product?.variants as unknown[])
      : [];
    const singleProductVariant = productVariants.length === 1 ? asRecord(productVariants[0]) : null;

    if (variant) {
      return firstString(variant?.barcode, variant?.upc, raw.barcode, raw.upc);
    }

    return firstString(
      raw.barcode,
      raw.upc,
      product?.barcode,
      product?.upc,
      singleProductVariant?.barcode,
      singleProductVariant?.upc,
    );
  }

  if (platform === "BIGCOMMERCE") {
    const variant = asRecord(raw.variant);
    const product = asRecord(raw.product);
    return firstString(variant?.upc, product?.upc);
  }

  if (platform === "TPP_EBAY" || platform === "TT_EBAY") {
    return extractEbayUpc(raw);
  }

  return null;
}

export function buildLiveUpcSummary(listings: ListingUpcSource[], rowUpc: string | null) {
  const platformValues = new Map<Platform, string>();
  const presentPlatforms = [...new Set(listings.map((listing) => listing.integration.platform as Platform))];

  for (const listing of listings) {
    const platform = listing.integration.platform as Platform;
    const upc = extractListingUpc(platform, listing.rawData);
    if (upc) {
      platformValues.set(platform, upc);
    }
  }

  const ordered: Array<{
    platform: Platform;
    label: string;
    value: string | null;
    state: "live" | "missing" | "pending_refresh" | "not_found";
    editable: boolean;
  }> = PLATFORM_ORDER
    .map((platform) => {
      if (!presentPlatforms.includes(platform)) {
        return {
          platform,
          label: PLATFORM_SHORT[platform],
          value: null,
          state: "not_found" as const,
          editable: false,
        };
      }
      const platformListings = listings.filter((listing) => listing.integration.platform === platform);
      const hasStoredPayload = platformListings.some((listing) => hasMeaningfulPayload(listing.rawData));
      const value = platformValues.get(platform) ?? null;
      return {
        platform,
        label: PLATFORM_SHORT[platform],
        value,
        editable: true,
        state: value
          ? ("live" as const)
          : !hasStoredPayload && (platform === "TPP_EBAY" || platform === "TT_EBAY")
            ? ("pending_refresh" as const)
            : ("missing" as const),
      };
    })
    .filter(Boolean);

  const choices: LiveUpcChoice[] = ordered.map((entry) => ({
    platform: entry.platform,
    label: entry.label,
    value: entry.value,
    editable: entry.editable,
    state: entry.state,
  }));

  const nonNullValues = ordered.map((entry) => entry.value).filter((value): value is string => Boolean(value));
  const distinctValues = [...new Set(nonNullValues)];
  const allStores =
    ordered.length === PLATFORM_ORDER.length &&
    nonNullValues.length === ordered.length &&
    distinctValues.length === 1;

  const lines: LiveUpcLine[] = allStores
    ? [
        {
          kind: "all",
          label: "All Stores",
          value: distinctValues[0],
          state: "live",
        },
      ]
    : ordered.map((entry) => ({
        kind: "platform" as const,
        platform: entry.platform,
        label: entry.label,
        value: entry.value,
        state: entry.state,
      }));

  return {
    lines,
    choices,
    allStores,
    representativeValue:
      (allStores ? distinctValues[0] : null) ??
      ordered.find((entry) => entry.value)?.value ??
      rowUpc ??
      null,
  };
}
