import { db } from "@/lib/db";
import { calcProfit, calcFee } from "@/lib/grid-types";
import type { GridRow, StoreValue, Platform } from "@/lib/grid-types";

type DBMasterRow = Awaited<ReturnType<typeof fetchMasterRows>>[number];
type DBListing = DBMasterRow["listings"][number];

async function fetchMasterRows() {
  const rows: Awaited<ReturnType<typeof db.masterRow.findMany>> = [];
  const batchSize = 100;
  let skip = 0;

  while (true) {
    const batch = await db.masterRow.findMany({
      where: { isActive: true },
      include: {
        listings: {
          include: {
            integration: true,
            childListings: {
              include: { integration: true },
            },
            parentListing: true,
          },
        },
        stagedChanges: {
          where: { status: "STAGED" },
        },
      },
      orderBy: { title: "asc" },
      skip,
      take: batchSize,
    });

    rows.push(...batch);

    if (batch.length < batchSize) break;
    skip += batchSize;
  }

  return rows;
}

async function fetchShippingRates(): Promise<Map<string, number>> {
  const rates = await db.shippingRate.findMany({ where: { cost: { not: null } } });
  const map = new Map<string, number>();
  for (const r of rates) {
    if (r.cost != null) map.set(r.weightKey, r.cost);
  }
  return map;
}

function lookupShipping(weight: string | null, rateMap: Map<string, number>): number | null {
  if (!weight) return null;
  const trimmed = weight.trim().toUpperCase();
  if (rateMap.has(trimmed)) return rateMap.get(trimmed)!;
  if (trimmed.endsWith("LBS") && rateMap.has(trimmed)) return rateMap.get(trimmed)!;
  if (trimmed.endsWith("OZ")) return rateMap.get(trimmed.replace("OZ", "oz")) ?? null;
  if (/^\d+$/.test(trimmed)) {
    const ozKey = `${trimmed}oz`;
    return rateMap.get(ozKey) ?? null;
  }
  return null;
}

type ListingLike = Pick<DBListing, "integration" | "platformItemId" | "platformVariantId" | "salePrice" | "adRate">;

function listingToStoreValue(listing: ListingLike, field: "salePrice" | "adRate"): StoreValue {
  return {
    platform: listing.integration.platform as Platform,
    listingId: listing.platformItemId,
    variantId: listing.platformVariantId || undefined,
    value: listing[field],
  };
}

async function buildChildRows(
  _master: DBMasterRow,
  parentListings: DBMasterRow["listings"],
  _stagedMap: Map<string, { field: string; stagedValue: string; liveValue: string | null }>,
  shippingRateMap: Map<string, number>,
  feeRate: number,
): Promise<GridRow[]> {
  const childSkus = new Set<string>();
  for (const p of parentListings) {
    for (const cl of p.childListings ?? []) {
      childSkus.add(cl.sku);
    }
  }
  if (childSkus.size === 0) return [];

  // Fetch full master rows for child SKUs with ALL their listings (cross-platform)
  const childMasters = await db.masterRow.findMany({
    where: { sku: { in: [...childSkus] } },
    include: {
      listings: { include: { integration: true } },
      stagedChanges: { where: { status: "STAGED" } },
    },
  });

  const rows: GridRow[] = [];

  for (const cm of childMasters) {
    const childStagedMap = new Map<string, { field: string; stagedValue: string; liveValue: string | null }>();
    for (const sc of cm.stagedChanges) {
      if (sc.marketplaceListingId) {
        childStagedMap.set(`${sc.marketplaceListingId}-${sc.field}`, {
          field: sc.field,
          stagedValue: sc.stagedValue,
          liveValue: sc.liveValue,
        });
      }
    }

    const childShipCost = cm.shippingCostOverride ?? lookupShipping(cm.weight, shippingRateMap);

    const allListings = cm.listings;

    const childSalePrices: StoreValue[] = allListings.map((l) => {
      const sv: StoreValue = {
        platform: l.integration.platform as Platform,
        listingId: l.platformItemId,
        variantId: l.platformVariantId || undefined,
        value: l.salePrice,
      };
      const staged = childStagedMap.get(`${l.id}-salePrice`);
      if (staged) sv.stagedValue = parseFloat(staged.stagedValue);
      return sv;
    });

    const childAdRates: StoreValue[] = allListings.map((l) => {
      const sv: StoreValue = {
        platform: l.integration.platform as Platform,
        listingId: l.platformItemId,
        variantId: l.platformVariantId || undefined,
        value: l.adRate,
      };
      const staged = childStagedMap.get(`${l.id}-adRate`);
      if (staged) sv.stagedValue = parseFloat(staged.stagedValue);
      return sv;
    });

    const childItemNumbers: StoreValue[] = allListings.map((l) => ({
      platform: l.integration.platform as Platform,
      listingId: l.platformItemId,
      variantId: l.platformVariantId || undefined,
      value: l.platformItemId,
    }));

    const childFees: StoreValue[] = childSalePrices.map((sp) => {
      const sale = sp.stagedValue != null ? Number(sp.stagedValue) : sp.value != null ? Number(sp.value) : 0;
      const r = sp.platform === "BIGCOMMERCE" || sp.platform === "SHOPIFY" ? 0 : feeRate;
      return { platform: sp.platform, listingId: sp.listingId, variantId: sp.variantId, value: calcFee(sale, r) };
    });

    const childProfits: StoreValue[] = childSalePrices.map((sp) => {
      const sale = sp.stagedValue != null ? Number(sp.stagedValue) : sp.value != null ? Number(sp.value) : 0;
      const r = sp.platform === "BIGCOMMERCE" || sp.platform === "SHOPIFY" ? 0 : feeRate;
      const ar = childAdRates.find((a) => a.platform === sp.platform && a.listingId === sp.listingId);
      const adR = ar?.value != null ? Number(ar.value) : 0;
      return {
        platform: sp.platform,
        listingId: sp.listingId,
        variantId: sp.variantId,
        value: calcProfit(sale, cm.supplierCost ?? 0, cm.supplierShipping ?? 0, childShipCost ?? 0, r, adR),
      };
    });

    const childInv = allListings.find((l) => l.inventory != null)?.inventory ?? null;

    rows.push({
      id: `child-${cm.id}`,
      sku: cm.sku,
      title: cm.title ?? cm.sku,
      upc: cm.upc,
      imageUrl: cm.imageUrl,
      weight: cm.weight,
      supplierCost: cm.supplierCost,
      supplierShipping: cm.supplierShipping,
      shippingCost: childShipCost,
      platformFeeRate: feeRate,
      inventory: childInv,
      isVariation: true,
      isParent: false,
      alternateTitles: [],
      hasStagedChanges: childSalePrices.some((sp) => sp.stagedValue != null && sp.stagedValue !== sp.value),
      itemNumbers: childItemNumbers,
      salePrices: childSalePrices,
      adRates: childAdRates,
      platformFees: childFees,
      profits: childProfits,
    });
  }

  return rows;
}

async function buildGridRow(
  master: DBMasterRow,
  stagedMap: Map<string, { field: string; stagedValue: string; liveValue: string | null }>,
  shippingRateMap: Map<string, number>,
  feeRate: number,
): Promise<GridRow> {
  const parentListings = master.listings.filter((l) => !l.parentListingId);
  const totalChildListings = parentListings.reduce((sum, l) => sum + (l.childListings?.length ?? 0), 0);
  const isVariationParent = totalChildListings > 0 || parentListings.some((l) => l.isVariation && l.childListings.length > 0);

  const shippingCost = master.shippingCostOverride ?? lookupShipping(master.weight, shippingRateMap);

  const salePrices: StoreValue[] = parentListings.map((l) => {
    const sv = listingToStoreValue(l, "salePrice");
    const staged = stagedMap.get(`${l.id}-salePrice`);
    if (staged) sv.stagedValue = parseFloat(staged.stagedValue);
    return sv;
  });

  const adRates: StoreValue[] = parentListings.map((l) => {
    const sv = listingToStoreValue(l, "adRate");
    const staged = stagedMap.get(`${l.id}-adRate`);
    if (staged) sv.stagedValue = parseFloat(staged.stagedValue);
    return sv;
  });

  const itemNumbers: StoreValue[] = parentListings.map((l) => ({
    platform: l.integration.platform as Platform,
    listingId: l.platformItemId,
    variantId: l.platformVariantId || undefined,
    value: l.platformItemId,
  }));

  const platformFees: StoreValue[] = salePrices.map((sp) => {
    const sale = sp.stagedValue != null ? Number(sp.stagedValue) : sp.value != null ? Number(sp.value) : 0;
    const rate = sp.platform === "BIGCOMMERCE" || sp.platform === "SHOPIFY" ? 0 : feeRate;
    return { platform: sp.platform, listingId: sp.listingId, variantId: sp.variantId, value: calcFee(sale, rate) };
  });

  const profits: StoreValue[] = salePrices.map((sp) => {
    const sale = sp.stagedValue != null ? Number(sp.stagedValue) : sp.value != null ? Number(sp.value) : 0;
    const rate = sp.platform === "BIGCOMMERCE" || sp.platform === "SHOPIFY" ? 0 : feeRate;
    const ar = adRates.find((a) => a.platform === sp.platform && a.listingId === sp.listingId);
    const adRate = ar?.value != null ? Number(ar.value) : 0;
    return {
      platform: sp.platform,
      listingId: sp.listingId,
      variantId: sp.variantId,
      value: calcProfit(sale, master.supplierCost ?? 0, master.supplierShipping ?? 0, shippingCost ?? 0, rate, adRate),
    };
  });

  const hasStagedChanges = salePrices.some((sp) => sp.stagedValue != null && sp.stagedValue !== sp.value);

  let inventory: number | null;
  if (isVariationParent) {
    const childListings = parentListings.flatMap((p) => p.childListings ?? []);
    const childInvValues = childListings.map((cl) => cl.inventory).filter((v): v is number => v != null);
    inventory = childInvValues.length > 0 ? childInvValues.reduce((a, b) => a + b, 0) : null;
  } else {
    const firstListing = parentListings.find((l) => l.inventory != null);
    inventory = firstListing?.inventory ?? null;
  }

  const alternateTitles: { title: string; platform: Platform; listingId: string }[] = [];
  for (const l of parentListings) {
    if (l.title && l.title !== master.title) {
      alternateTitles.push({
        title: l.title,
        platform: l.integration.platform as Platform,
        listingId: l.platformItemId,
      });
    }
  }

  const childRows: GridRow[] | undefined = isVariationParent
    ? await buildChildRows(master, parentListings, stagedMap, shippingRateMap, feeRate)
    : undefined;

  return {
    id: master.id,
    sku: master.sku,
    title: master.title ?? master.sku,
    upc: master.upc,
    imageUrl: master.imageUrl,
    weight: master.weight,
    supplierCost: master.supplierCost,
    supplierShipping: master.supplierShipping,
    shippingCost: shippingCost,
    platformFeeRate: feeRate,
    inventory,
    isVariation: isVariationParent,
    isParent: isVariationParent,
    alternateTitles,
    hasStagedChanges,
    itemNumbers,
    salePrices: isVariationParent ? [] : salePrices,
    adRates,
    platformFees: isVariationParent ? [] : platformFees,
    profits: isVariationParent ? [] : profits,
    childRows,
  };
}


export async function getGridData(): Promise<GridRow[]> {
  const [masterRows, shippingRateMap, feeRateSetting] = await Promise.all([
    fetchMasterRows(),
    fetchShippingRates(),
    db.appSetting.findUnique({ where: { key: "platformFeeRate" } }),
  ]);

  const feeRate = feeRateSetting?.value != null ? Number(feeRateSetting.value) : 0.136;

  const parentRows = masterRows.filter((mr) => {
    // Exclude master rows that have ANY listing as a child of a variation parent;
    // these appear nested under their parent's variation group instead.
    const hasAnyChildListing = mr.listings.some((l) => l.parentListingId);
    return !hasAnyChildListing;
  });

  const rows: GridRow[] = [];

  for (const master of parentRows) {
    const stagedMap = new Map<string, { field: string; stagedValue: string; liveValue: string | null }>();
    for (const sc of master.stagedChanges) {
      if (sc.marketplaceListingId) {
        stagedMap.set(`${sc.marketplaceListingId}-${sc.field}`, {
          field: sc.field,
          stagedValue: sc.stagedValue,
          liveValue: sc.liveValue,
        });
      }
    }

    const gridRow = await buildGridRow(master, stagedMap, shippingRateMap, feeRate);
    rows.push(gridRow);
  }

  return rows;
}
