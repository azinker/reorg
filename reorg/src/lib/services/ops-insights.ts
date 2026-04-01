import { db } from "@/lib/db";
import { getGridData } from "@/lib/grid-query";
import type { GridRow, Platform, StoreValue } from "@/lib/grid-types";
import { calcFee, calcProfit, PLATFORM_DISPLAY_ORDER, PLATFORM_FULL } from "@/lib/grid-types";

type FlattenedGridRow = GridRow & {
  hasAlternateTitlesIssue: boolean;
};

export type CatalogHealthIssueKey =
  | "missing_upc"
  | "missing_image"
  | "missing_weight"
  | "missing_supplier_cost"
  | "missing_supplier_shipping"
  | "missing_shipping_rate"
  | "title_mismatch";

export type CatalogHealthIssueSummary = {
  key: CatalogHealthIssueKey;
  label: string;
  count: number;
};

export type CatalogHealthAttentionRow = {
  id: string;
  sku: string;
  title: string;
  imageUrl: string | null;
  weight: string | null;
  upc: string | null;
  supplierCost: number | null;
  supplierShipping: number | null;
  issueKeys: CatalogHealthIssueKey[];
  issueLabels: string[];
  issueScore: number;
  platformCount: number;
};

export type CatalogHealthData = {
  totalCatalogRows: number;
  missingUpcCount: number;
  missingImageCount: number;
  missingWeightCount: number;
  missingSupplierCostCount: number;
  missingSupplierShippingCount: number;
  missingShippingRateCount: number;
  titleMismatchCount: number;
  unmatchedCount: number;
  issueSummaries: CatalogHealthIssueSummary[];
  unmatchedByPlatform: Array<{
    platform: Platform;
    label: string;
    count: number;
  }>;
  attentionRows: CatalogHealthAttentionRow[];
};

export type ProfitCenterListing = {
  rowId: string;
  sku: string;
  title: string;
  imageUrl: string | null;
  upc: string | null;
  weight: string | null;
  inventory: number | null;
  platform: Platform;
  listingId: string;
  marketplaceListingId: string | null;
  platformVariantId: string | null;
  salePrice: number;
  liveSalePrice: number;
  stagedSalePrice: number | null;
  profit: number;
  marginPercent: number;
  supplierCost: number | null;
  supplierShipping: number | null;
  shippingCost: number | null;
  adRatePercent: number | null;
  liveAdRatePercent: number | null;
  stagedAdRatePercent: number | null;
  feeAmount: number;
  platformFeeRatePercent: number;
};

export type ProfitCenterPlatformSummary = {
  platform: Platform;
  label: string;
  listingCount: number;
  averageProfit: number;
  averageMarginPercent: number;
  negativeCount: number;
  lowMarginCount: number;
};

export type ProfitCenterData = {
  analyzedListingCount: number;
  averageProfit: number;
  averageMarginPercent: number;
  negativeListingCount: number;
  lowMarginListingCount: number;
  highMarginListingCount: number;
  totalProfitLeakage: number;
  platformSummaries: ProfitCenterPlatformSummary[];
  topWinners: ProfitCenterListing[];
  biggestLosers: ProfitCenterListing[];
  biggestLoserCount: number;
  biggestLosersPageSize: number;
  watchlist: ProfitCenterListing[];
};

export type ProfitCenterLoserPage = {
  items: ProfitCenterListing[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
};

const ISSUE_LABELS: Record<CatalogHealthIssueKey, string> = {
  missing_upc: "Missing UPC",
  missing_image: "Missing image",
  missing_weight: "Missing weight",
  missing_supplier_cost: "Missing supplier cost",
  missing_supplier_shipping: "Missing supplier shipping",
  missing_shipping_rate: "Missing shipping rate",
  title_mismatch: "Alternate titles detected",
};

const ISSUE_WEIGHTS: Record<CatalogHealthIssueKey, number> = {
  missing_upc: 2,
  missing_image: 1,
  missing_weight: 3,
  missing_supplier_cost: 4,
  missing_supplier_shipping: 3,
  missing_shipping_rate: 4,
  title_mismatch: 1,
};

function flattenGridRows(rows: GridRow[]): FlattenedGridRow[] {
  return rows.flatMap((row) => {
    if (row.isParent && row.childRows && row.childRows.length > 0) {
      return row.childRows.map((child) => ({
        ...child,
        hasAlternateTitlesIssue: (child.alternateTitles?.length ?? 0) > 0 || (row.alternateTitles?.length ?? 0) > 0,
      }));
    }

    return [{
      ...row,
      hasAlternateTitlesIssue: (row.alternateTitles?.length ?? 0) > 0,
    }];
  });
}

function numericStoreValue(entry: StoreValue | undefined) {
  return typeof entry?.value === "number" && Number.isFinite(entry.value) ? entry.value : null;
}

function stagedNumericStoreValue(entry: StoreValue | undefined) {
  return typeof entry?.stagedValue === "number" && Number.isFinite(entry.stagedValue)
    ? entry.stagedValue
    : null;
}

function effectiveNumericStoreValue(entry: StoreValue | undefined) {
  return stagedNumericStoreValue(entry) ?? numericStoreValue(entry);
}

function matchStoreValue(values: StoreValue[], target: StoreValue) {
  return values.find(
    (entry) =>
      entry.platform === target.platform &&
      String(entry.listingId) === String(target.listingId) &&
      String(entry.variantId ?? "") === String(target.variantId ?? ""),
  );
}

async function getFlattenedRows() {
  const rows = await getGridData();
  return flattenGridRows(rows);
}

function buildProfitCenterListings(rows: FlattenedGridRow[]): ProfitCenterListing[] {
  const listings: ProfitCenterListing[] = [];

  for (const row of rows) {
    for (const salePriceEntry of row.salePrices) {
      const liveSalePrice = numericStoreValue(salePriceEntry);
      const stagedSalePrice = stagedNumericStoreValue(salePriceEntry);
      const salePrice = effectiveNumericStoreValue(salePriceEntry);
      const adRateEntry = matchStoreValue(row.adRates, salePriceEntry);
      const liveAdRate = numericStoreValue(adRateEntry);
      const stagedAdRate = stagedNumericStoreValue(adRateEntry);
      const effectiveAdRate = effectiveNumericStoreValue(adRateEntry) ?? 0;

      if (salePrice == null || liveSalePrice == null) continue;

      const platformFeeRate = salePriceEntry.platform === "BIGCOMMERCE" || salePriceEntry.platform === "SHOPIFY"
        ? 0
        : row.platformFeeRate;
      const feeAmount = calcFee(salePrice, platformFeeRate);
      const profit = calcProfit(
        salePrice,
        row.supplierCost ?? 0,
        row.supplierShipping ?? 0,
        row.shippingCost ?? 0,
        platformFeeRate,
        effectiveAdRate,
      );

      listings.push({
        rowId: row.id,
        sku: row.sku,
        title: row.title,
        imageUrl: row.imageUrl,
        upc: row.upc ?? null,
        weight: row.weight ?? null,
        inventory: row.inventory ?? null,
        platform: salePriceEntry.platform,
        listingId: salePriceEntry.listingId,
        marketplaceListingId: salePriceEntry.marketplaceListingId ?? null,
        platformVariantId: salePriceEntry.variantId ?? null,
        salePrice,
        liveSalePrice,
        stagedSalePrice,
        profit,
        marginPercent: salePrice > 0 ? (profit / salePrice) * 100 : 0,
        supplierCost: row.supplierCost,
        supplierShipping: row.supplierShipping,
        shippingCost: row.shippingCost,
        adRatePercent: effectiveNumericStoreValue(adRateEntry) != null ? effectiveAdRate * 100 : null,
        liveAdRatePercent: liveAdRate != null ? liveAdRate * 100 : null,
        stagedAdRatePercent: stagedAdRate != null ? stagedAdRate * 100 : null,
        feeAmount,
        platformFeeRatePercent: platformFeeRate * 100,
      });
    }
  }

  return listings;
}

function sortProfitCenterByProfitDesc(listings: ProfitCenterListing[]) {
  return [...listings].sort((a, b) =>
    b.profit - a.profit ||
    b.marginPercent - a.marginPercent ||
    a.sku.localeCompare(b.sku),
  );
}

function sortProfitCenterByProfitAsc(listings: ProfitCenterListing[]) {
  return [...listings].sort((a, b) =>
    a.profit - b.profit ||
    a.marginPercent - b.marginPercent ||
    a.sku.localeCompare(b.sku),
  );
}

export async function getCatalogHealthData(): Promise<CatalogHealthData> {
  const [rows, unmatchedRows] = await Promise.all([
    getFlattenedRows(),
    db.unmatchedListing.findMany({
      select: {
        integration: {
          select: {
            platform: true,
            label: true,
          },
        },
      },
    }),
  ]);

  const issueCounts = new Map<CatalogHealthIssueKey, number>();
  const attentionRows: CatalogHealthAttentionRow[] = [];

  for (const row of rows) {
    const issueKeys: CatalogHealthIssueKey[] = [];

    if (!row.upc?.trim()) issueKeys.push("missing_upc");
    if (!row.imageUrl) issueKeys.push("missing_image");
    if (!row.weight?.trim()) issueKeys.push("missing_weight");
    if (row.supplierCost == null) issueKeys.push("missing_supplier_cost");
    if (row.supplierShipping == null) issueKeys.push("missing_supplier_shipping");
    if (row.weight?.trim() && row.shippingCost == null) issueKeys.push("missing_shipping_rate");
    if (row.hasAlternateTitlesIssue) issueKeys.push("title_mismatch");

    for (const key of issueKeys) {
      issueCounts.set(key, (issueCounts.get(key) ?? 0) + 1);
    }

    if (issueKeys.length === 0) continue;

    attentionRows.push({
      id: row.id,
      sku: row.sku,
      title: row.title,
      imageUrl: row.imageUrl,
      weight: row.weight ?? null,
      upc: row.upc ?? null,
      supplierCost: row.supplierCost ?? null,
      supplierShipping: row.supplierShipping ?? null,
      issueKeys,
      issueLabels: issueKeys.map((key) => ISSUE_LABELS[key]),
      issueScore: issueKeys.reduce((sum, key) => sum + ISSUE_WEIGHTS[key], 0),
      platformCount: row.itemNumbers.length,
    });
  }

  const unmatchedByPlatform = PLATFORM_DISPLAY_ORDER.map((platform) => ({
    platform,
    label: PLATFORM_FULL[platform],
    count: unmatchedRows.filter((row) => row.integration.platform === platform).length,
  })).filter((entry) => entry.count > 0);

  const issueSummaries = (Object.keys(ISSUE_LABELS) as CatalogHealthIssueKey[])
    .map((key) => ({
      key,
      label: ISSUE_LABELS[key],
      count: issueCounts.get(key) ?? 0,
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  attentionRows.sort((a, b) =>
    b.issueScore - a.issueScore ||
    b.issueKeys.length - a.issueKeys.length ||
    a.sku.localeCompare(b.sku),
  );

  return {
    totalCatalogRows: rows.length,
    missingUpcCount: issueCounts.get("missing_upc") ?? 0,
    missingImageCount: issueCounts.get("missing_image") ?? 0,
    missingWeightCount: issueCounts.get("missing_weight") ?? 0,
    missingSupplierCostCount: issueCounts.get("missing_supplier_cost") ?? 0,
    missingSupplierShippingCount: issueCounts.get("missing_supplier_shipping") ?? 0,
    missingShippingRateCount: issueCounts.get("missing_shipping_rate") ?? 0,
    titleMismatchCount: issueCounts.get("title_mismatch") ?? 0,
    unmatchedCount: unmatchedRows.length,
    issueSummaries,
    unmatchedByPlatform,
    attentionRows,
  };
}

export async function getProfitCenterData(): Promise<ProfitCenterData> {
  const rows = await getFlattenedRows();
  const listings = buildProfitCenterListings(rows);

  const analyzedListingCount = listings.length;
  const averageProfit =
    analyzedListingCount > 0
      ? listings.reduce((sum, entry) => sum + entry.profit, 0) / analyzedListingCount
      : 0;
  const averageMarginPercent =
    analyzedListingCount > 0
      ? listings.reduce((sum, entry) => sum + entry.marginPercent, 0) / analyzedListingCount
      : 0;
  const negativeListingCount = listings.filter((entry) => entry.profit < 0).length;
  const lowMarginListingCount = listings.filter((entry) => entry.marginPercent >= 0 && entry.marginPercent < 10).length;
  const highMarginListingCount = listings.filter((entry) => entry.marginPercent >= 25).length;
  const totalProfitLeakage = listings
    .filter((entry) => entry.profit < 0)
    .reduce((sum, entry) => sum + Math.abs(entry.profit), 0);

  const platformSummaries = PLATFORM_DISPLAY_ORDER.map<ProfitCenterPlatformSummary | null>((platform) => {
    const platformListings = listings.filter((entry) => entry.platform === platform);
    if (platformListings.length === 0) return null;

    return {
      platform,
      label: PLATFORM_FULL[platform],
      listingCount: platformListings.length,
      averageProfit:
        platformListings.reduce((sum, entry) => sum + entry.profit, 0) / platformListings.length,
      averageMarginPercent:
        platformListings.reduce((sum, entry) => sum + entry.marginPercent, 0) / platformListings.length,
      negativeCount: platformListings.filter((entry) => entry.profit < 0).length,
      lowMarginCount: platformListings.filter((entry) => entry.marginPercent >= 0 && entry.marginPercent < 10).length,
    };
  }).filter((entry): entry is ProfitCenterPlatformSummary => entry != null);

  const byProfitDesc = sortProfitCenterByProfitDesc(listings);
  const byProfitAsc = sortProfitCenterByProfitAsc(listings);
  const biggestLosersPageSize = 20;

  return {
    analyzedListingCount,
    averageProfit,
    averageMarginPercent,
    negativeListingCount,
    lowMarginListingCount,
    highMarginListingCount,
    totalProfitLeakage,
    platformSummaries,
    topWinners: byProfitDesc.slice(0, 12),
    biggestLosers: byProfitAsc.slice(0, biggestLosersPageSize),
    biggestLoserCount: byProfitAsc.length,
    biggestLosersPageSize,
    watchlist: byProfitAsc
      .filter((entry) => entry.profit >= 0 && entry.marginPercent < 10)
      .slice(0, 12),
  };
}

export async function getProfitCenterLoserPage(
  page = 1,
  pageSize = 20,
): Promise<ProfitCenterLoserPage> {
  const rows = await getFlattenedRows();
  const ordered = sortProfitCenterByProfitAsc(buildProfitCenterListings(rows));
  const safePageSize = Math.min(Math.max(Math.floor(pageSize) || 20, 1), 100);
  const totalCount = ordered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / safePageSize));
  const safePage = Math.min(Math.max(Math.floor(page) || 1, 1), totalPages);
  const startIndex = (safePage - 1) * safePageSize;

  return {
    items: ordered.slice(startIndex, startIndex + safePageSize),
    page: safePage,
    pageSize: safePageSize,
    totalCount,
    totalPages,
  };
}

export async function getProfitCenterListingDetail(
  marketplaceListingId: string,
): Promise<ProfitCenterListing | null> {
  const rows = await getFlattenedRows();
  const listings = buildProfitCenterListings(rows);
  return listings.find((listing) => listing.marketplaceListingId === marketplaceListingId) ?? null;
}
