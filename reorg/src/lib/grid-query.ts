import { db } from "@/lib/db";
import { calcProfit, calcFee } from "@/lib/grid-types";
import type { GridRow, StoreValue, Platform, UpcPushTarget } from "@/lib/grid-types";
import { Prisma } from "@prisma/client";

const UPC_PUSH_PLATFORMS = new Set<Platform>(["BIGCOMMERCE", "SHOPIFY"]);

const masterRowWithRelations = Prisma.validator<Prisma.MasterRowDefaultArgs>()({
  select: {
    id: true,
    sku: true,
    title: true,
    imageUrl: true,
    upc: true,
    weight: true,
    supplierCost: true,
    supplierShipping: true,
    shippingCostOverride: true,
    listings: {
      select: {
        id: true,
        platformItemId: true,
        platformVariantId: true,
        sku: true,
        title: true,
        salePrice: true,
        adRate: true,
        inventory: true,
        isVariation: true,
        parentListingId: true,
        integration: {
          select: {
            platform: true,
          },
        },
        childListings: {
          select: {
            id: true,
            platformItemId: true,
            platformVariantId: true,
            sku: true,
            title: true,
            salePrice: true,
            adRate: true,
            inventory: true,
            parentListingId: true,
            integration: {
              select: {
                platform: true,
              },
            },
          },
        },
      },
    },
    stagedChanges: {
      where: { status: "STAGED" },
      select: {
        id: true,
        marketplaceListingId: true,
        field: true,
        stagedValue: true,
        liveValue: true,
      },
    },
  },
});

type DBMasterRow = Prisma.MasterRowGetPayload<typeof masterRowWithRelations>;
type DBListing = DBMasterRow["listings"][number];
type DBListingRef = Pick<DBListing, "integration" | "platformItemId" | "platformVariantId">;

const childMasterRowSnapshotSelect = Prisma.validator<Prisma.MasterRowDefaultArgs>()({
  select: {
    id: true,
    sku: true,
    title: true,
    imageUrl: true,
    upc: true,
    listings: {
      select: {
        id: true,
        platformItemId: true,
        platformVariantId: true,
        inventory: true,
        integration: {
          select: {
            platform: true,
          },
        },
      },
    },
    stagedChanges: {
      where: { status: "STAGED" },
      select: {
        id: true,
        marketplaceListingId: true,
        field: true,
        stagedValue: true,
        liveValue: true,
      },
    },
  },
});

const childMasterRowFullSelect = Prisma.validator<Prisma.MasterRowDefaultArgs>()({
  select: {
    id: true,
    sku: true,
    title: true,
    imageUrl: true,
    upc: true,
    weight: true,
    supplierCost: true,
    supplierShipping: true,
    shippingCostOverride: true,
    listings: {
      select: {
        id: true,
        platformItemId: true,
        platformVariantId: true,
        sku: true,
        title: true,
        salePrice: true,
        adRate: true,
        inventory: true,
        integration: {
          select: {
            platform: true,
          },
        },
      },
    },
    stagedChanges: {
      where: { status: "STAGED" },
      select: {
        id: true,
        marketplaceListingId: true,
        field: true,
        stagedValue: true,
        liveValue: true,
      },
    },
  },
});

type DBChildMasterRowSnapshot = Prisma.MasterRowGetPayload<typeof childMasterRowSnapshotSelect>;
type DBChildMasterRowFull = Prisma.MasterRowGetPayload<typeof childMasterRowFullSelect>;

function appendItemNumber(
  map: Map<string, StoreValue>,
  entry: DBListingRef | StoreValue,
) {
  const isStoreValue = "platform" in entry;
  const platform = isStoreValue
    ? entry.platform
    : (entry.integration.platform as Platform);
  const listingId = isStoreValue ? entry.listingId : entry.platformItemId;
  const variantId = isStoreValue ? entry.variantId : entry.platformVariantId || undefined;
  const key = `${platform}:${listingId}`;

  if (!map.has(key)) {
    map.set(key, {
      platform,
      listingId,
      variantId,
      value: listingId,
    });
  }
}

async function fetchMasterRows() {
  const batchSize = 100;
  let skip = 0;

  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const batch = await db.masterRow.findMany({
          where: { isActive: true },
          ...masterRowWithRelations,
          orderBy: { title: "asc" },
          skip,
          take: batchSize,
        });

        if (batch.length === 0) break;

        yield batch;

        if (batch.length < batchSize) break;
        skip += batchSize;
      }
    },
  };
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

function collectChildSkus(parentListings: DBMasterRow["listings"]): string[] {
  const childSkus = new Set<string>();
  for (const p of parentListings) {
    for (const cl of p.childListings ?? []) {
      childSkus.add(cl.sku);
    }
  }
  return [...childSkus];
}

function buildChildStagedMap(
  stagedChanges: Array<{
    id: string;
    marketplaceListingId: string | null;
    field: string;
    stagedValue: string;
    liveValue: string | null;
  }>,
) {
  const childStagedMap = new Map<string, { id: string; field: string; stagedValue: string; liveValue: string | null }>();
  for (const sc of stagedChanges) {
    if (sc.marketplaceListingId) {
      childStagedMap.set(`${sc.marketplaceListingId}-${sc.field}`, {
        id: sc.id,
        field: sc.field,
        stagedValue: sc.stagedValue,
        liveValue: sc.liveValue,
      });
    }
  }
  return childStagedMap;
}

function buildUpcStageDetails(
  listings: Array<{
    id: string;
    platformItemId: string;
    platformVariantId: string | null | undefined;
    integration: { platform: Platform };
  }>,
  stagedChanges: Array<{
    id: string;
    marketplaceListingId: string | null;
    field: string;
    stagedValue: string;
  }>,
) {
  const upcStages = stagedChanges.filter((change) => change.field === "upc");
  const stagedUpc = upcStages[0]?.stagedValue ?? null;
  const upcPushTargets: UpcPushTarget[] = [];

  const stageByListingId = new Map(
    upcStages
      .filter((change) => change.marketplaceListingId)
      .map((change) => [change.marketplaceListingId as string, change]),
  );

  for (const listing of listings) {
    if (!UPC_PUSH_PLATFORMS.has(listing.integration.platform)) {
      continue;
    }

    const stagedChange = stageByListingId.get(listing.id);
    if (!stagedChange) {
      continue;
    }

    upcPushTargets.push({
      platform: listing.integration.platform,
      listingId: listing.platformItemId,
      marketplaceListingId: listing.id,
      variantId: listing.platformVariantId ?? undefined,
      stagedChangeId: stagedChange.id,
    });
  }

  return {
    stagedUpc: stagedUpc ?? null,
    hasStagedUpc: upcStages.length > 0,
    upcPushTargets,
  };
}

async function fetchChildMasterSnapshots(parentListings: DBMasterRow["listings"]) {
  const childSkus = collectChildSkus(parentListings);
  if (childSkus.length === 0) return [];

  return db.masterRow.findMany({
    where: { sku: { in: childSkus } },
    ...childMasterRowSnapshotSelect,
  });
}

async function fetchChildMasterRows(parentListings: DBMasterRow["listings"]) {
  const childSkus = collectChildSkus(parentListings);
  if (childSkus.length === 0) return [];

  return db.masterRow.findMany({
    where: { sku: { in: [...childSkus] } },
    ...childMasterRowFullSelect,
  });
}

function buildChildRowStubs(childMasters: DBChildMasterRowSnapshot[]): GridRow[] {
  const rows: GridRow[] = [];

  for (const cm of childMasters) {
    const childInv = cm.listings.find((l) => l.inventory != null)?.inventory ?? null;
    const upcStage = buildUpcStageDetails(cm.listings, cm.stagedChanges);
    const itemNumberMap = new Map<string, StoreValue>();
    for (const listing of cm.listings) {
      appendItemNumber(itemNumberMap, listing);
    }

    rows.push({
      id: `child-${cm.id}`,
      sku: cm.sku,
      title: cm.title ?? cm.sku,
      upc: cm.upc,
      stagedUpc: upcStage.stagedUpc,
      hasStagedUpc: upcStage.hasStagedUpc,
      upcPushTargets: upcStage.upcPushTargets,
      imageUrl: cm.imageUrl,
      weight: null,
      supplierCost: null,
      supplierShipping: null,
      shippingCost: null,
      platformFeeRate: 0,
      inventory: childInv,
      isVariation: true,
      isParent: false,
      childRowsHydrated: true,
      alternateTitles: [],
      hasStagedChanges: cm.stagedChanges.length > 0,
      itemNumbers: [...itemNumberMap.values()],
      salePrices: [],
      adRates: [],
      platformFees: [],
      profits: [],
    });
  }

  return rows;
}

function buildFullChildRows(
  childMasters: DBChildMasterRowFull[],
  shippingRateMap: Map<string, number>,
  feeRate: number,
): GridRow[] {
  
  const rows: GridRow[] = [];

  for (const cm of childMasters) {
    const childStagedMap = buildChildStagedMap(cm.stagedChanges);
    const upcStage = buildUpcStageDetails(cm.listings, cm.stagedChanges);

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
      stagedUpc: upcStage.stagedUpc,
      hasStagedUpc: upcStage.hasStagedUpc,
      upcPushTargets: upcStage.upcPushTargets,
      imageUrl: cm.imageUrl,
      weight: cm.weight,
      supplierCost: cm.supplierCost,
      supplierShipping: cm.supplierShipping,
      shippingCost: childShipCost,
      platformFeeRate: feeRate,
      inventory: childInv,
      isVariation: true,
      isParent: false,
      childRowsHydrated: true,
      alternateTitles: [],
      hasStagedChanges:
        upcStage.hasStagedUpc ||
        childSalePrices.some((sp) => sp.stagedValue != null && sp.stagedValue !== sp.value)
        || childAdRates.some((ar) => ar.stagedValue != null && ar.stagedValue !== ar.value),
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
  const parentListings = master.listings.filter((l: DBListing) => !l.parentListingId);
  const totalChildListings = parentListings.reduce((sum: number, l: DBListing) => sum + (l.childListings?.length ?? 0), 0);
  const isVariationParent = totalChildListings > 0 || parentListings.some((l: DBListing) => l.isVariation && l.childListings.length > 0);

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

  const hasStagedChanges = salePrices.some((sp) => sp.stagedValue != null && sp.stagedValue !== sp.value)
    || adRates.some((ar) => ar.stagedValue != null && ar.stagedValue !== ar.value);
  const upcStage = buildUpcStageDetails(parentListings, master.stagedChanges);

  let inventory: number | null;
  if (isVariationParent) {
    const childListings = parentListings.flatMap((p: DBListing) => p.childListings ?? []);
    const childInvValues = childListings.map((cl) => cl.inventory).filter((v): v is number => v != null);
    inventory = childInvValues.length > 0 ? childInvValues.reduce((a: number, b: number) => a + b, 0) : null;
  } else {
    const firstListing = parentListings.find((l: DBListing) => l.inventory != null);
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
    ? await buildChildRowsSnapshot(parentListings)
    : undefined;

  const itemNumberMap = new Map<string, StoreValue>();
  for (const listing of parentListings) {
    appendItemNumber(itemNumberMap, listing);
    for (const childListing of listing.childListings ?? []) {
      appendItemNumber(itemNumberMap, childListing);
    }
  }
  for (const childRow of childRows ?? []) {
    for (const item of childRow.itemNumbers) {
      appendItemNumber(itemNumberMap, item);
    }
  }
  const itemNumbers: StoreValue[] = [...itemNumberMap.values()];

  return {
    id: master.id,
    sku: master.sku,
    title: master.title ?? master.sku,
    upc: master.upc,
    stagedUpc: upcStage.stagedUpc,
    hasStagedUpc: upcStage.hasStagedUpc,
    upcPushTargets: upcStage.upcPushTargets,
    imageUrl: master.imageUrl,
    weight: master.weight,
    supplierCost: master.supplierCost,
    supplierShipping: master.supplierShipping,
    shippingCost: shippingCost,
    platformFeeRate: feeRate,
    inventory,
    isVariation: isVariationParent,
    isParent: isVariationParent,
    childRowsHydrated: !isVariationParent,
    alternateTitles,
    hasStagedChanges: hasStagedChanges || upcStage.hasStagedUpc,
    itemNumbers,
    salePrices: isVariationParent ? [] : salePrices,
    adRates,
    platformFees: isVariationParent ? [] : platformFees,
    profits: isVariationParent ? [] : profits,
    childRows,
  };
}


export async function getGridData(): Promise<GridRow[]> {
  const [masterRowBatches, shippingRateMap, feeRateSetting] = await Promise.all([
    fetchMasterRows(),
    fetchShippingRates(),
    db.appSetting.findUnique({ where: { key: "platformFeeRate" } }),
  ]);

  const feeRate = feeRateSetting?.value != null ? Number(feeRateSetting.value) : 0.136;
  const rows: GridRow[] = [];

  for await (const batch of masterRowBatches) {
    const parentRows = batch.filter((mr) => {
      // Exclude master rows that have ANY listing as a child of a variation parent;
      // these appear nested under their parent's variation group instead.
      const hasAnyChildListing = mr.listings.some((l: DBListing) => l.parentListingId);
      return !hasAnyChildListing;
    });

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
  }

  return rows;
}

export async function getGridChildRows(parentRowId: string): Promise<GridRow[]> {
  const [master, shippingRateMap, feeRateSetting] = await Promise.all([
    db.masterRow.findUnique({
      where: { id: parentRowId },
      ...masterRowWithRelations,
    }),
    fetchShippingRates(),
    db.appSetting.findUnique({ where: { key: "platformFeeRate" } }),
  ]);

  if (!master) {
    return [];
  }

  const feeRate = feeRateSetting?.value != null ? Number(feeRateSetting.value) : 0.136;
  const parentListings = master.listings.filter((listing: DBListing) => !listing.parentListingId);
  return buildChildRows(parentListings, shippingRateMap, feeRate);
}

async function buildChildRowsSnapshot(parentListings: DBMasterRow["listings"]): Promise<GridRow[]> {
  const childMasters = await fetchChildMasterSnapshots(parentListings);
  return buildChildRowStubs(childMasters);
}

async function buildChildRows(
  parentListings: DBMasterRow["listings"],
  shippingRateMap: Map<string, number>,
  feeRate: number,
): Promise<GridRow[]> {
  const childMasters = await fetchChildMasterRows(parentListings);
  return buildFullChildRows(childMasters, shippingRateMap, feeRate);
}
