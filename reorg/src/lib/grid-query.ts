import { db } from "@/lib/db";
import { calcProfit, calcFee } from "@/lib/grid-types";
import type { GridRow, StoreValue, Platform, UpcPushTarget } from "@/lib/grid-types";
import { Prisma } from "@prisma/client";

const UPC_PUSH_PLATFORMS = new Set<Platform>(["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"]);

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
            isVariation: true,
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
      where: { status: { in: ["STAGED", "LOCAL_ONLY"] } },
      select: {
        id: true,
        marketplaceListingId: true,
        field: true,
        stagedValue: true,
        liveValue: true,
        status: true,
        rejectionReason: true,
      },
    },
  },
});

type DBMasterRow = Prisma.MasterRowGetPayload<typeof masterRowWithRelations>;
type DBListing = DBMasterRow["listings"][number];
type DBListingRef = Pick<DBListing, "id" | "integration" | "platformItemId" | "platformVariantId">;

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
      where: { status: { in: ["STAGED", "LOCAL_ONLY"] } },
      select: {
        id: true,
        marketplaceListingId: true,
        field: true,
        stagedValue: true,
        liveValue: true,
        status: true,
        rejectionReason: true,
      },
    },
  },
});

type DBChildMasterRowFull = Prisma.MasterRowGetPayload<typeof childMasterRowFullSelect>;

function sameStoreIdentity(
  a: Pick<StoreValue, "platform" | "listingId" | "marketplaceListingId" | "variantId">,
  b: Pick<StoreValue, "platform" | "listingId" | "marketplaceListingId" | "variantId">,
) {
  if (a.marketplaceListingId && b.marketplaceListingId) {
    return a.marketplaceListingId === b.marketplaceListingId;
  }

  if (a.variantId && b.variantId) {
    return (
      a.platform === b.platform &&
      a.listingId === b.listingId &&
      a.variantId === b.variantId
    );
  }

  return a.platform === b.platform && a.listingId === b.listingId;
}

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
  const marketplaceListingId = isStoreValue
    ? entry.marketplaceListingId
    : entry.id;
  const key = `${platform}:${listingId}`;

  if (!map.has(key)) {
    map.set(key, {
      platform,
      listingId,
      variantId,
      marketplaceListingId,
      value: listingId,
    });
  }
}

async function fetchMasterRows() {
  const batchSize = 1000;
  let skip = 0;

  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const batch = await db.masterRow.findMany({
          where: {
            isActive: true,
            listings: {
              some: {},
            },
          },
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

function buildStagedMap(
  stagedChanges: Array<{
    marketplaceListingId: string | null;
    field: string;
    stagedValue: string;
    liveValue: string | null;
    status: string;
    rejectionReason: string | null;
  }>,
) {
  const stagedMap = new Map<
    string,
    { field: string; stagedValue: string; liveValue: string | null; localOnly: boolean; rejectionReason: string | null }
  >();

  for (const sc of stagedChanges) {
    if (sc.marketplaceListingId) {
      stagedMap.set(`${sc.marketplaceListingId}-${sc.field}`, {
        field: sc.field,
        stagedValue: sc.stagedValue,
        liveValue: sc.liveValue,
        localOnly: sc.status === "LOCAL_ONLY",
        rejectionReason: sc.rejectionReason,
      });
    }
  }

  return stagedMap;
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

type ListingLike = Pick<DBListing, "id" | "integration" | "platformItemId" | "platformVariantId" | "salePrice" | "adRate">;

function listingToStoreValue(listing: ListingLike, field: "salePrice" | "adRate"): StoreValue {
  return {
    platform: listing.integration.platform as Platform,
    listingId: listing.platformItemId,
    marketplaceListingId: listing.id,
    variantId: listing.platformVariantId || undefined,
    value: listing[field],
  };
}

/** Best promoted-listing ad rate from variation children (parent row often has null). */
function aggregateChildAdRates(
  children: Array<{ adRate: number | null }> | undefined,
): number | null {
  if (!children?.length) return null;
  let best: number | null = null;
  for (const c of children) {
    if (c.adRate == null) continue;
    const n = Number(c.adRate);
    if (!Number.isFinite(n)) continue;
    if (best == null || n > best) best = n;
  }
  return best;
}

function buildAdRateLookupByPlatform(
  listings: Array<{
    id: string;
    adRate: number | null;
    integration: { platform: Platform };
    childListings?: Array<{ adRate: number | null }>;
  }>,
  stagedMap: Map<string, { field: string; stagedValue: string; liveValue: string | null; localOnly: boolean; rejectionReason: string | null }>,
): Partial<Record<Platform, number>> {
  const lookup: Partial<Record<Platform, number>> = {};

  for (const listing of listings) {
    const platform = listing.integration.platform;
    if (platform !== "TPP_EBAY" && platform !== "TT_EBAY") continue;

    const staged = stagedMap.get(`${listing.id}-adRate`);
    const fromChildren = aggregateChildAdRates(listing.childListings);
    const effective =
      staged != null
        ? parseFloat(staged.stagedValue)
        : listing.adRate != null
          ? Number(listing.adRate)
          : fromChildren;

    if (effective != null) {
      lookup[platform] = effective;
    }
  }

  return lookup;
}

const EBAY_AD_PLATFORMS = ["TPP_EBAY", "TT_EBAY"] as const;

/** When parent eBay row has no ad rate, use any child master row's listing for that platform. */
function backfillAdRatesFromChildMasters(
  lookup: Partial<Record<Platform, number>>,
  parentListings: DBMasterRow["listings"],
  childMasterRowsBySku: Map<string, DBChildMasterRowFull>,
) {
  const childSkus = collectChildSkus(parentListings);
  for (const plat of EBAY_AD_PLATFORMS) {
    if (lookup[plat] != null) continue;
    for (const sku of childSkus) {
      const cm = childMasterRowsBySku.get(sku);
      if (!cm) continue;
      for (const l of cm.listings) {
        if (l.integration.platform !== plat) continue;
        if (l.adRate != null) {
          lookup[plat] = Number(l.adRate);
          break;
        }
      }
      if (lookup[plat] != null) break;
    }
  }
}

function collectChildSkus(parentListings: DBMasterRow["listings"]): string[] {
  const childSkus = new Set<string>();
  const sortedParents = [...parentListings].sort((a, b) => {
    return ITEM_NUMBER_PLATFORM_ORDER[a.integration.platform as Platform] - ITEM_NUMBER_PLATFORM_ORDER[b.integration.platform as Platform];
  });

  for (const p of sortedParents) {
    for (const cl of p.childListings ?? []) {
      childSkus.add(cl.sku);
    }
  }
  return [...childSkus];
}

async function fetchBatchChildMasterRowsBySku(masters: DBMasterRow[]) {
  const childSkus = new Set<string>();

  for (const master of masters) {
    for (const childSku of collectChildSkus(master.listings)) {
      childSkus.add(childSku);
    }
  }

  if (childSkus.size === 0) {
    return new Map<string, DBChildMasterRowFull>();
  }

  const childMasters = await db.masterRow.findMany({
    where: { sku: { in: [...childSkus] } },
    ...childMasterRowFullSelect,
  });

  return new Map(childMasters.map((childMaster) => [childMaster.sku, childMaster]));
}

function buildChildStagedMap(
  stagedChanges: Array<{
    id: string;
    marketplaceListingId: string | null;
    field: string;
    stagedValue: string;
    liveValue: string | null;
    status: string;
    rejectionReason: string | null;
  }>,
) {
  const childStagedMap = new Map<string, { id: string; field: string; stagedValue: string; liveValue: string | null; localOnly: boolean; rejectionReason: string | null }>();
  for (const sc of stagedChanges) {
    if (sc.marketplaceListingId) {
      childStagedMap.set(`${sc.marketplaceListingId}-${sc.field}`, {
        id: sc.id,
        field: sc.field,
        stagedValue: sc.stagedValue,
        liveValue: sc.liveValue,
        localOnly: sc.status === "LOCAL_ONLY",
        rejectionReason: sc.rejectionReason,
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
    status: string;
  }>,
) {
  const upcStages = stagedChanges.filter((change) => change.field === "upc");
  const activeUpcStages = upcStages.filter((s) => s.status === "STAGED");
  const localOnlyUpcStages = upcStages.filter((s) => s.status === "LOCAL_ONLY");
  const stagedUpc = activeUpcStages[0]?.stagedValue ?? localOnlyUpcStages[0]?.stagedValue ?? null;
  const upcPushTargets: UpcPushTarget[] = [];

  const stageByListingId = new Map(
    upcStages
      .filter((change) => change.marketplaceListingId)
      .map((change) => [change.marketplaceListingId as string, change]),
  );

  const localOnlyUpcPlatforms: Platform[] = [];

  for (const listing of listings) {
    if (!UPC_PUSH_PLATFORMS.has(listing.integration.platform)) {
      continue;
    }

    const stagedChange = stageByListingId.get(listing.id);

    if (stagedChange?.status === "LOCAL_ONLY") {
      localOnlyUpcPlatforms.push(listing.integration.platform);
    }

    upcPushTargets.push({
      platform: listing.integration.platform,
      listingId: listing.platformItemId,
      marketplaceListingId: listing.id,
      variantId: listing.platformVariantId ?? undefined,
      stagedChangeId: stagedChange?.id ?? null,
    });
  }

  return {
    stagedUpc: stagedUpc ?? null,
    hasStagedUpc: activeUpcStages.length > 0,
    hasLocalOnlyChanges: localOnlyUpcStages.length > 0,
    localOnlyUpcPlatforms,
    upcPushTargets,
  };
}

const ITEM_NUMBER_PLATFORM_ORDER: Record<Platform, number> = {
  TPP_EBAY: 0,
  TT_EBAY: 1,
  SHOPIFY: 2,
  BIGCOMMERCE: 3,
};

function sortItemNumbers(items: StoreValue[]): StoreValue[] {
  return [...items].sort((a, b) => {
    const platformDelta =
      ITEM_NUMBER_PLATFORM_ORDER[a.platform] - ITEM_NUMBER_PLATFORM_ORDER[b.platform];
    if (platformDelta !== 0) {
      return platformDelta;
    }

    const listingDelta = String(a.listingId).localeCompare(String(b.listingId), undefined, {
      numeric: true,
    });
    if (listingDelta !== 0) {
      return listingDelta;
    }

    return String(a.variantId ?? "").localeCompare(String(b.variantId ?? ""), undefined, {
      numeric: true,
    });
  });
}

async function fetchChildMasterRows(parentListings: DBMasterRow["listings"]) {
  const childSkus = collectChildSkus(parentListings);
  if (childSkus.length === 0) return [];

  const childMasters = await db.masterRow.findMany({
    where: { sku: { in: [...childSkus] } },
    ...childMasterRowFullSelect,
  });

  const childMasterBySku = new Map(childMasters.map((childMaster) => [childMaster.sku, childMaster]));
  return childSkus
    .map((sku) => childMasterBySku.get(sku))
    .filter((childMaster): childMaster is DBChildMasterRowFull => childMaster != null);
}

function parseVariationSpecifics(
  rawData: unknown,
): { name: string; value: string }[] | undefined {
  if (!rawData || typeof rawData !== "object") return undefined;

  const raw = rawData as Record<string, unknown>;

  // eBay TPP child variation: rawData = the Variation node directly
  // eBay TT child variation: rawData = { item, variation, parentItemId }
  const variation = (raw.variation ?? raw) as Record<string, unknown>;
  const specifics = variation.VariationSpecifics as Record<string, unknown> | undefined;
  if (!specifics) return undefined;

  const nameValueList = specifics.NameValueList;
  const entries: unknown[] = Array.isArray(nameValueList) ? nameValueList : nameValueList ? [nameValueList] : [];

  const attrs: { name: string; value: string }[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const name = rec.Name;
    const rawValue = rec.Value;
    if (name == null) continue;

    const nameStr = String(name);
    const valueStr = Array.isArray(rawValue) ? String(rawValue[0] ?? "") : String(rawValue ?? "");
    if (nameStr && valueStr) {
      attrs.push({ name: nameStr, value: valueStr });
    }
  }

  return attrs.length > 0 ? attrs : undefined;
}

async function fetchVariationAttributesBatch(
  childMasterIds: string[],
): Promise<Map<string, { name: string; value: string }[]>> {
  if (childMasterIds.length === 0) return new Map();

  const masterListings = await db.marketplaceListing.findMany({
    where: {
      masterRowId: { in: childMasterIds },
      integration: { isMaster: true },
    },
    select: {
      masterRowId: true,
      rawData: true,
    },
  });

  const result = new Map<string, { name: string; value: string }[]>();
  for (const listing of masterListings) {
    if (!listing.masterRowId || !listing.rawData) continue;
    const attrs = parseVariationSpecifics(listing.rawData);
    if (attrs) result.set(listing.masterRowId, attrs);
  }
  return result;
}

function buildFullChildRows(
  childMasters: DBChildMasterRowFull[],
  shippingRateMap: Map<string, number>,
  feeRate: number,
  parentAdRatesByPlatform: Partial<Record<Platform, number>>,
  variationAttrsMap?: Map<string, { name: string; value: string }[]>,
  parentImageUrl?: string | null,
): GridRow[] {
  
  const rows: GridRow[] = [];

  for (const cm of childMasters) {
    const childStagedMap = buildChildStagedMap(cm.stagedChanges);
    const upcStage = buildUpcStageDetails(cm.listings, cm.stagedChanges);

    const childShipCost = cm.shippingCostOverride ?? lookupShipping(cm.weight, shippingRateMap);

    const allListings = cm.listings;

    const childSalePrices: StoreValue[] = allListings.map((l) => {
      const sv = listingToStoreValue(l, "salePrice");
      const staged = childStagedMap.get(`${l.id}-salePrice`);
      if (staged) {
        sv.stagedValue = parseFloat(staged.stagedValue);
        sv.localOnly = staged.localOnly;
        sv.rejectionReason = staged.rejectionReason;
      }
      return sv;
    });

    const childAdRates: StoreValue[] = [];

    const childItemNumbers: StoreValue[] = allListings.map((l) => ({
      platform: l.integration.platform as Platform,
      listingId: l.platformItemId,
      marketplaceListingId: l.id,
      variantId: l.platformVariantId || undefined,
      value: l.platformItemId,
    }));

    const childFees: StoreValue[] = childSalePrices.map((sp) => {
      const sale = sp.stagedValue != null ? Number(sp.stagedValue) : sp.value != null ? Number(sp.value) : 0;
      const r = sp.platform === "BIGCOMMERCE" || sp.platform === "SHOPIFY" ? 0 : feeRate;
      return {
        platform: sp.platform,
        listingId: sp.listingId,
        marketplaceListingId: sp.marketplaceListingId,
        variantId: sp.variantId,
        value: calcFee(sale, r),
      };
    });

    const childProfits: StoreValue[] = childSalePrices.map((sp) => {
      const sale = sp.stagedValue != null ? Number(sp.stagedValue) : sp.value != null ? Number(sp.value) : 0;
      const r = sp.platform === "BIGCOMMERCE" || sp.platform === "SHOPIFY" ? 0 : feeRate;
      const adR = parentAdRatesByPlatform[sp.platform] ?? 0;
      return {
        platform: sp.platform,
        listingId: sp.listingId,
        marketplaceListingId: sp.marketplaceListingId,
        variantId: sp.variantId,
        value: calcProfit(sale, cm.supplierCost ?? 0, cm.supplierShipping ?? 0, childShipCost ?? 0, r, adR),
      };
    });

    const childInv = allListings.find((l) => l.inventory != null)?.inventory ?? null;
    const variationAttributes = variationAttrsMap?.get(cm.id);

    rows.push({
      id: `child-${cm.id}`,
      sku: cm.sku,
      title: cm.title ?? cm.sku,
      upc: cm.upc,
      stagedUpc: upcStage.stagedUpc,
      hasStagedUpc: upcStage.hasStagedUpc,
      hasLocalOnlyChanges: upcStage.hasLocalOnlyChanges,
      localOnlyUpcPlatforms: upcStage.localOnlyUpcPlatforms,
      upcPushTargets: upcStage.upcPushTargets,
      imageUrl: cm.imageUrl ?? parentImageUrl ?? null,
      weight: cm.weight,
      supplierCost: cm.supplierCost,
      supplierShipping: cm.supplierShipping,
      shippingCost: childShipCost,
      platformFeeRate: feeRate,
      inventory: childInv,
      variationAttributes,
      isVariation: true,
      isParent: false,
      childRowsHydrated: true,
      alternateTitles: [],
      hasStagedChanges:
        upcStage.hasStagedUpc || upcStage.hasLocalOnlyChanges ||
        childSalePrices.some((sp) => sp.stagedValue != null && sp.stagedValue !== sp.value)
        || childAdRates.some((ar) => ar.stagedValue != null && ar.stagedValue !== ar.value),
      itemNumbers: sortItemNumbers(childItemNumbers),
      salePrices: childSalePrices,
      adRates: childAdRates,
      platformFees: childFees,
      profits: childProfits,
      profitAdRatesByPlatform: parentAdRatesByPlatform,
    });
  }

  return rows;
}

function buildGridRow(
  master: DBMasterRow,
  stagedMap: Map<string, { field: string; stagedValue: string; liveValue: string | null; localOnly: boolean; rejectionReason: string | null }>,
  shippingRateMap: Map<string, number>,
  feeRate: number,
  childMasterRowsBySku: Map<string, DBChildMasterRowFull>,
  variationAttrsMap?: Map<string, { name: string; value: string }[]>,
): GridRow | null {
  if (master.listings.length === 0) {
    return null;
  }

  const parentListings = master.listings.filter((l: DBListing) =>
    !l.parentListingId || !l.isVariation,
  );
  if (parentListings.length === 0) {
    return null;
  }
  const totalChildListings = parentListings.reduce((sum: number, l: DBListing) => sum + (l.childListings?.length ?? 0), 0);

  // Synthetic parent MasterRows (created by variation-repair for single-variant
  // BC/Shopify products) have ONLY variation-flagged listings and zero real
  // children. Skip them — the real data lives on the original MasterRow.
  if (totalChildListings === 0 && parentListings.every((l: DBListing) => l.isVariation)) {
    return null;
  }

  const isVariationParent = totalChildListings > 0 || parentListings.some((l: DBListing) => l.isVariation && l.childListings.length > 0);
  const hasVariationListings = parentListings.some((l: DBListing) => l.isVariation);

  const shippingCost = master.shippingCostOverride ?? lookupShipping(master.weight, shippingRateMap);

  const salePrices: StoreValue[] = parentListings.map((l) => {
    const sv = listingToStoreValue(l, "salePrice");
    const staged = stagedMap.get(`${l.id}-salePrice`);
    if (staged) {
      sv.stagedValue = parseFloat(staged.stagedValue);
      sv.localOnly = staged.localOnly;
      sv.rejectionReason = staged.rejectionReason;
    }
    return sv;
  });

  const rawAdRates: StoreValue[] = parentListings.map((l) => {
    const sv = listingToStoreValue(l, "adRate");
    const staged = stagedMap.get(`${l.id}-adRate`);
    if (staged) {
      sv.stagedValue = parseFloat(staged.stagedValue);
      sv.localOnly = staged.localOnly;
      sv.rejectionReason = staged.rejectionReason;
    }
    return sv;
  }).filter((entry) => entry.platform === "TPP_EBAY" || entry.platform === "TT_EBAY");

  const parentAdRatesByPlatform = buildAdRateLookupByPlatform(parentListings, stagedMap);
  if (isVariationParent) {
    backfillAdRatesFromChildMasters(parentAdRatesByPlatform, parentListings, childMasterRowsBySku);
  }
  const adRates: StoreValue[] = isVariationParent
    ? parentListings
        .filter((listing) => {
          const platform = listing.integration.platform as Platform;
          return platform === "TPP_EBAY" || platform === "TT_EBAY";
        })
        .map((listing) => {
          const platform = listing.integration.platform as Platform;
          const staged = stagedMap.get(`${listing.id}-adRate`);
          // When no rate has been synced yet, default to 0 so the block shows
          // "0.0%" rather than "N/A" (N/A is reserved for SHPFY/BC which take a
          // separate render path).
          const effectiveValue =
            staged != null
              ? parseFloat(staged.stagedValue)
              : (parentAdRatesByPlatform[platform] ?? 0);

          return {
            platform,
            listingId: listing.platformItemId,
            marketplaceListingId: listing.id,
            variantId: undefined,
            value: effectiveValue,
            stagedValue: staged != null ? parseFloat(staged.stagedValue) : undefined,
          };
        })
    : rawAdRates;

  const platformFees: StoreValue[] = salePrices.map((sp) => {
    const sale = sp.stagedValue != null ? Number(sp.stagedValue) : sp.value != null ? Number(sp.value) : 0;
    const rate = sp.platform === "BIGCOMMERCE" || sp.platform === "SHOPIFY" ? 0 : feeRate;
    return { platform: sp.platform, listingId: sp.listingId, variantId: sp.variantId, value: calcFee(sale, rate) };
  });

  const profits: StoreValue[] = salePrices.map((sp) => {
    const sale = sp.stagedValue != null ? Number(sp.stagedValue) : sp.value != null ? Number(sp.value) : 0;
    const rate = sp.platform === "BIGCOMMERCE" || sp.platform === "SHOPIFY" ? 0 : feeRate;
    const ar = rawAdRates.find((a) => a.platform === sp.platform && a.listingId === sp.listingId);
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
    ? buildBatchChildRows(parentListings, childMasterRowsBySku, shippingRateMap, feeRate, parentAdRatesByPlatform, variationAttrsMap, master.imageUrl)
    : undefined;

  let variationDimensions: string[] | undefined;
  if (childRows && childRows.length > 0) {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const child of childRows) {
      for (const attr of child.variationAttributes ?? []) {
        if (!seen.has(attr.name)) {
          seen.add(attr.name);
          ordered.push(attr.name);
        }
      }
    }
    if (ordered.length > 0) variationDimensions = ordered;
  }

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
  const itemNumbers: StoreValue[] = sortItemNumbers([...itemNumberMap.values()]);
  const parentRowItemNumbers = itemNumbers.filter((item) => !item.variantId);

  return {
    id: master.id,
    sku: master.sku,
    title: master.title ?? master.sku,
    upc: master.upc,
    stagedUpc: upcStage.stagedUpc,
    hasStagedUpc: upcStage.hasStagedUpc,
    hasLocalOnlyChanges: upcStage.hasLocalOnlyChanges,
    localOnlyUpcPlatforms: upcStage.localOnlyUpcPlatforms,
    upcPushTargets: upcStage.upcPushTargets,
    imageUrl: master.imageUrl,
    weight: master.weight,
    supplierCost: master.supplierCost,
    supplierShipping: master.supplierShipping,
    shippingCost: shippingCost,
    platformFeeRate: feeRate,
    inventory,
    variationDimensions,
    isVariation: isVariationParent || hasVariationListings,
    isParent: isVariationParent,
    childRowsHydrated: !isVariationParent,
    alternateTitles,
    hasStagedChanges: hasStagedChanges || upcStage.hasStagedUpc || upcStage.hasLocalOnlyChanges,
    itemNumbers: isVariationParent ? parentRowItemNumbers : itemNumbers,
    salePrices: isVariationParent ? [] : salePrices,
    adRates,
    platformFees: isVariationParent ? [] : platformFees,
    profits: isVariationParent ? [] : profits,
    profitAdRatesByPlatform: parentAdRatesByPlatform,
    childRows,
  };
}

function buildVariationFamilyKey(row: GridRow): string | null {
  if (row.isParent || !row.isVariation || row.itemNumbers.length === 0) {
    return null;
  }

  const platformItemPairs = [...new Set(
    row.itemNumbers.map((item) => `${item.platform}:${item.listingId}`),
  )].sort();

  if (platformItemPairs.length === 0) {
    return null;
  }

  return `${row.title}::${platformItemPairs.join("|")}`;
}

function buildParentVariationFamilyKey(row: GridRow): string | null {
  if (!row.isParent || !row.childRows?.length) {
    return null;
  }

  const childIds = [...new Set(row.childRows.map((child) => child.id))].sort();
  if (childIds.length === 0) {
    return null;
  }

  return childIds.join("|");
}

/** Best eBay promoted rate across child rows (synthetic parent used to take first child only). */
function mergeEbayAdRatesFromChildGridRows(children: GridRow[]): Partial<Record<Platform, number>> {
  const best: Partial<Record<Platform, number>> = {};

  function consider(platform: Platform, raw: number | null | undefined) {
    if (raw == null) return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const prev = best[platform];
    if (prev == null || n > prev) best[platform] = n;
  }

  for (const child of children) {
    const map = child.profitAdRatesByPlatform;
    if (map) {
      for (const plat of EBAY_AD_PLATFORMS) {
        consider(plat, map[plat]);
      }
    }
    for (const ar of child.adRates) {
      if (ar.platform !== "TPP_EBAY" && ar.platform !== "TT_EBAY") continue;
      const v =
        ar.stagedValue != null ? Number(ar.stagedValue) : ar.value != null ? Number(ar.value) : null;
      consider(ar.platform as Platform, v);
    }
  }

  return best;
}

function buildSyntheticVariationParent(children: GridRow[], familyKey: string): GridRow {
  const first = children[0];
  const itemNumberMap = new Map<string, StoreValue>();
  const alternateTitles: { title: string; platform: Platform; listingId: string }[] = [];

  for (const child of children) {
    for (const item of child.itemNumbers) {
      appendItemNumber(itemNumberMap, item);
    }
    if (child.alternateTitles?.length) {
      alternateTitles.push(...child.alternateTitles);
    }
  }

  const inventoryValues = children
    .map((child) => child.inventory)
    .filter((value): value is number => value != null);
  const fromChildren = mergeEbayAdRatesFromChildGridRows(children);
  const profitAdRatesByPlatform: Partial<Record<Platform, number>> = {
    ...(first.profitAdRatesByPlatform ?? {}),
  };
  for (const plat of EBAY_AD_PLATFORMS) {
    const merged = fromChildren[plat];
    if (merged == null) continue;
    const cur = profitAdRatesByPlatform[plat];
    if (cur == null || !Number.isFinite(Number(cur)) || merged > Number(cur)) {
      profitAdRatesByPlatform[plat] = merged;
    }
  }
  const adRates = sortItemNumbers(
    [...itemNumberMap.values()]
      .filter((item) => item.platform === "TPP_EBAY" || item.platform === "TT_EBAY")
      .map((item) => ({
        platform: item.platform,
        listingId: item.listingId,
        marketplaceListingId: item.marketplaceListingId ?? null,
        variantId: undefined,
        value: profitAdRatesByPlatform[item.platform] ?? null,
      })),
  );

  return {
    id: `variation-parent:${familyKey}`,
    sku: first.sku,
    title: first.title,
    upc: null,
    stagedUpc: null,
    hasStagedUpc: false,
    upcPushTargets: [],
    imageUrl: first.imageUrl,
    imageSource: first.imageSource,
    weight: first.weight,
    supplierCost: first.supplierCost,
    supplierShipping: first.supplierShipping,
    shippingCost: first.shippingCost,
    platformFeeRate: first.platformFeeRate,
    inventory:
      inventoryValues.length > 0
        ? inventoryValues.reduce((sum, value) => sum + value, 0)
        : null,
    isVariation: true,
    isParent: true,
    childRows: children,
    childRowsHydrated: true,
    expanded: false,
    alternateTitles,
    itemNumbers: sortItemNumbers([...itemNumberMap.values()]),
    salePrices: [],
    adRates,
    profits: [],
    platformFees: [],
    profitAdRatesByPlatform,
    hasStagedChanges: children.some((child) => child.hasStagedChanges),
  };
}

function pickRepresentativeVariationParent(rows: GridRow[]): GridRow {
  const priority = (row: GridRow) => {
    if (row.sku?.startsWith("TPP-")) return 0;
    if (row.sku?.startsWith("TT-")) return 1;
    if (row.sku?.startsWith("SHPFY-")) return 2;
    if (row.sku?.startsWith("BC-")) return 3;
    return 4;
  };

  return [...rows].sort((a, b) => priority(a) - priority(b))[0] ?? rows[0];
}

function mergeVariationParents(rows: GridRow[], familyKey: string): GridRow {
  const representative = pickRepresentativeVariationParent(rows);
  const childRowMap = new Map<string, GridRow>();
  const itemNumberMap = new Map<string, StoreValue>();
  const adRateMap = new Map<string, StoreValue>();
  const alternateTitles: { title: string; platform: Platform; listingId: string }[] = [];

  for (const row of rows) {
    for (const item of row.itemNumbers) {
      appendItemNumber(itemNumberMap, item);
    }
    for (const adRate of row.adRates) {
      const key = `${adRate.platform}:${adRate.listingId}:${adRate.variantId ?? ""}`;
      const existing = adRateMap.get(key);
      if (!existing) {
        adRateMap.set(key, adRate);
        continue;
      }
      const ev = existing.value;
      const nv = adRate.value;
      const existingEmpty = ev == null || (typeof ev === "number" && !Number.isFinite(ev));
      const nextHas = nv != null && (typeof nv !== "number" || Number.isFinite(nv));
      if (existingEmpty && nextHas) {
        adRateMap.set(key, adRate);
      }
    }
    if (row.profitAdRatesByPlatform) {
      const acc = { ...(representative.profitAdRatesByPlatform ?? {}) };
      for (const plat of EBAY_AD_PLATFORMS) {
        const next = row.profitAdRatesByPlatform![plat];
        if (next == null || !Number.isFinite(Number(next))) continue;
        const n = Number(next);
        const cur = acc[plat];
        if (cur == null || !Number.isFinite(Number(cur)) || n > Number(cur)) acc[plat] = n;
      }
      representative.profitAdRatesByPlatform = acc;
    }
    if (row.alternateTitles?.length) {
      alternateTitles.push(...row.alternateTitles);
    }
    for (const child of row.childRows ?? []) {
      if (!childRowMap.has(child.id)) {
        childRowMap.set(child.id, child);
      }
    }
  }

  const childRows = [...childRowMap.values()];
  const inventoryValues = childRows
    .map((child) => child.inventory)
    .filter((value): value is number => value != null);

  return {
    ...representative,
    id: `variation-parent:${familyKey}`,
    inventory:
      inventoryValues.length > 0
        ? inventoryValues.reduce((sum, value) => sum + value, 0)
        : null,
    itemNumbers: sortItemNumbers([...itemNumberMap.values()]),
    adRates: [...adRateMap.values()],
    alternateTitles,
    childRows,
    childRowsHydrated: true,
    hasStagedChanges:
      rows.some((row) => row.hasStagedChanges) ||
      childRows.some((child) => child.hasStagedChanges),
  };
}

function consolidateVariationParentRows(rows: GridRow[]): GridRow[] {
  const groups = new Map<string, GridRow[]>();

  for (const row of rows) {
    const familyKey = buildParentVariationFamilyKey(row);
    if (!familyKey) continue;
    const existing = groups.get(familyKey);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(familyKey, [row]);
    }
  }

  if (![...groups.values()].some((group) => group.length > 1)) {
    return rows;
  }

  const emittedFamilies = new Set<string>();
  const groupedRowIds = new Set(
    [...groups.entries()]
      .filter(([, group]) => group.length > 1)
      .flatMap(([, group]) => group.map((row) => row.id)),
  );

  const result: GridRow[] = [];
  for (const row of rows) {
    const familyKey = buildParentVariationFamilyKey(row);
    if (!familyKey || !groupedRowIds.has(row.id)) {
      result.push(row);
      continue;
    }

    if (emittedFamilies.has(familyKey)) {
      continue;
    }

    emittedFamilies.add(familyKey);
    result.push(mergeVariationParents(groups.get(familyKey) ?? [row], familyKey));
  }

  return result;
}

function consolidateStandaloneVariationRows(rows: GridRow[]): GridRow[] {
  const groups = new Map<string, GridRow[]>();

  for (const row of rows) {
    const familyKey = buildVariationFamilyKey(row);
    if (!familyKey) continue;
    const existing = groups.get(familyKey);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(familyKey, [row]);
    }
  }

  if (![...groups.values()].some((group) => group.length > 1)) {
    return rows;
  }

  const emittedFamilies = new Set<string>();
  const groupedRowIds = new Set(
    [...groups.entries()]
      .filter(([, group]) => group.length > 1)
      .flatMap(([, group]) => group.map((row) => row.id)),
  );

  const result: GridRow[] = [];
  for (const row of rows) {
    const familyKey = buildVariationFamilyKey(row);
    if (!familyKey || !groupedRowIds.has(row.id)) {
      result.push(row);
      continue;
    }

    if (emittedFamilies.has(familyKey)) {
      continue;
    }

    emittedFamilies.add(familyKey);
    result.push(buildSyntheticVariationParent(groups.get(familyKey) ?? [row], familyKey));
  }

  return result;
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
      const isEntirelyChild = mr.listings.length > 0 &&
        mr.listings.every((l: DBListing) => l.parentListingId && l.isVariation);
      return !isEntirelyChild;
    });
    const childMasterRowsBySku = await fetchBatchChildMasterRowsBySku(parentRows);

    const childMasterIds = [...childMasterRowsBySku.values()].map((cm) => cm.id);
    const variationAttrsMap = await fetchVariationAttributesBatch(childMasterIds);

    for (const master of parentRows) {
      const stagedMap = buildStagedMap(master.stagedChanges);
      const gridRow = buildGridRow(
        master,
        stagedMap,
        shippingRateMap,
        feeRate,
        childMasterRowsBySku,
        variationAttrsMap,
      );
      if (gridRow) {
        rows.push(gridRow);
      }
    }
  }

  return consolidateStandaloneVariationRows(consolidateVariationParentRows(rows));
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
  return buildChildRows(parentListings, shippingRateMap, feeRate, master.imageUrl);
}

export async function getGridRowById(rowId: string): Promise<GridRow | null> {
  const isChildRow = rowId.startsWith("child-");
  const normalizedRowId = isChildRow ? rowId.slice("child-".length) : rowId;

  const [shippingRateMap, feeRateSetting] = await Promise.all([
    fetchShippingRates(),
    db.appSetting.findUnique({ where: { key: "platformFeeRate" } }),
  ]);

  const feeRate = feeRateSetting?.value != null ? Number(feeRateSetting.value) : 0.136;

  if (isChildRow) {
    const childMaster = await db.masterRow.findUnique({
      where: { id: normalizedRowId },
      ...childMasterRowFullSelect,
    });

    if (!childMaster) {
      return null;
    }

    let parentImageUrl: string | null = null;
    const childListing = await db.marketplaceListing.findFirst({
      where: { masterRowId: normalizedRowId, parentListingId: { not: null } },
      select: { parentListing: { select: { masterRow: { select: { imageUrl: true } } } } },
    });
    if (childListing?.parentListing?.masterRow?.imageUrl) {
      parentImageUrl = childListing.parentListing.masterRow.imageUrl;
    }

    const variationAttrsMap = await fetchVariationAttributesBatch([normalizedRowId]);
    return buildFullChildRows([childMaster], shippingRateMap, feeRate, {}, variationAttrsMap, parentImageUrl)[0] ?? null;
  }

  const master = await db.masterRow.findUnique({
    where: { id: normalizedRowId },
    ...masterRowWithRelations,
  });

  if (!master) {
    return null;
  }

  const childMasterRowsBySku = await fetchBatchChildMasterRowsBySku([master]);
  const childMasterIds = [...childMasterRowsBySku.values()].map((cm) => cm.id);
  const variationAttrsMap = await fetchVariationAttributesBatch(childMasterIds);

  return buildGridRow(
    master,
    buildStagedMap(master.stagedChanges),
    shippingRateMap,
    feeRate,
    childMasterRowsBySku,
    variationAttrsMap,
  );
}

async function buildChildRows(
  parentListings: DBMasterRow["listings"],
  shippingRateMap: Map<string, number>,
  feeRate: number,
  parentImageUrl?: string | null,
): Promise<GridRow[]> {
  const childMasters = await fetchChildMasterRows(parentListings);
  return buildFullChildRows(childMasters, shippingRateMap, feeRate, {}, undefined, parentImageUrl);
}

function buildBatchChildRows(
  parentListings: DBMasterRow["listings"],
  childMasterRowsBySku: Map<string, DBChildMasterRowFull>,
  shippingRateMap: Map<string, number>,
  feeRate: number,
  parentAdRatesByPlatform: Partial<Record<Platform, number>>,
  variationAttrsMap?: Map<string, { name: string; value: string }[]>,
  parentImageUrl?: string | null,
): GridRow[] {
  const childMasters = collectChildSkus(parentListings)
    .map((sku) => childMasterRowsBySku.get(sku))
    .filter((childMaster): childMaster is DBChildMasterRowFull => childMaster != null);

  return buildFullChildRows(childMasters, shippingRateMap, feeRate, parentAdRatesByPlatform, variationAttrsMap, parentImageUrl);
}
