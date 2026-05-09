import { XMLParser } from "fast-xml-parser";
import { db } from "@/lib/db";
import {
  buildEbayConfig,
  type EbayConfig,
  type EbayOrderContext,
  getEbayAccessToken,
} from "@/lib/services/auto-responder-ebay";
import { periodToDateRange, matchesSearch, matchesStatusFilter } from "@/lib/manage-orders/filters";
import {
  feedbackMirrorToSnapshot,
  fetchEbayFeedbackForOrderContext,
  type HelpdeskFeedbackSnapshot,
} from "@/lib/services/helpdesk-feedback";
import type {
  EbayStore,
  ManageOrder,
  ManageOrderCaseItem,
  ManageOrderCaseSummary,
  ManageOrderFinance,
  ManageOrderFeedbackItem,
  ManageOrderFeedbackSummary,
  ManageOrderLineItem,
  ManageOrdersPeriodFilter,
  ManageOrdersSearchBy,
  ManageOrdersSearchResult,
  ManageOrdersStatusFilter,
  ManageOrdersStoreFilter,
} from "@/lib/manage-orders/types";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const PAGE_SIZE = 50;
const DETAIL_FULFILLMENT_TIMEOUT_MS = 4500;
const DETAIL_FINANCE_TIMEOUT_MS = 7000;
const SEARCH_FEEDBACK_TIMEOUT_MS = 4500;
const NON_ORDER_SEARCH_PAGE_LIMIT = 5;
// Cap eBay GetOrders pages we'll scan for a tracking-number fallback.
// Each page is up to 100 orders, so 20 pages ≈ 2,000 most recent orders —
// enough for the typical "did this label ship in the period" lookup.
// Was 100 (10k orders) which serialized into multi-minute searches when
// the local AutoResponderJob index didn't cover the tracking number.
const TRACKING_SEARCH_PAGE_LIMIT = 20;
// Parallelize fallback page fetches so we don't pay 20 round trips serially.
// Kept low to stay polite to eBay's Trading API rate budget per store.
const TRACKING_SEARCH_PAGE_CONCURRENCY = 5;

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (tagName) =>
    ["Order", "Transaction", "ShipmentTrackingDetails", "PictureURL"].includes(tagName),
});

type StoreContext = {
  platform: EbayStore;
  integrationId: string;
  accessToken: string;
  environment: string;
  config: EbayConfig;
};

type SearchInput = {
  store: ManageOrdersStoreFilter;
  status: ManageOrdersStatusFilter;
  period: ManageOrdersPeriodFilter;
  searchBy: ManageOrdersSearchBy;
  searchTerm: string;
  page: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  const obj = asRecord(value);
  if (obj?.["#text"] != null) return text(obj["#text"]);
  return null;
}

function moneyToCents(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function currency(value: unknown): string | null {
  const obj = asRecord(value);
  return text(obj?.["@_currencyID"]) ?? null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  return asRecord(Array.isArray(value) ? value[0] : value);
}

function lineTitle(tx: Record<string, unknown>, item: Record<string, unknown> | null) {
  const variation = asRecord(tx.Variation);
  return text(variation?.VariationTitle) ?? text(item?.Title) ?? "Untitled item";
}

function itemPicture(item: Record<string, unknown> | null) {
  const pictureDetails = asRecord(item?.PictureDetails);
  const pictureUrl = pictureDetails?.PictureURL;
  if (Array.isArray(pictureUrl)) return text(pictureUrl[0]);
  return text(pictureUrl) ?? text(pictureDetails?.GalleryURL);
}

function variationSelections(variation: Record<string, unknown> | null) {
  const specifics = asRecord(variation?.VariationSpecifics);
  return asArray<Record<string, unknown>>(
    specifics?.NameValueList as Record<string, unknown> | Record<string, unknown>[] | undefined,
  )
    .map((specific) => ({
      name: text(specific.Name),
      value: text(specific.Value),
    }))
    .filter((specific): specific is { name: string; value: string } => Boolean(specific.name && specific.value));
}

function selectedShippingService(order: Record<string, unknown>) {
  const selected = asRecord(order.ShippingServiceSelected);
  const details = asRecord(order.ShippingDetails);
  const options = asRecord(details?.ShippingServiceOptions);
  return text(selected?.ShippingService) ?? text(options?.ShippingService);
}

function shippingCost(order: Record<string, unknown>) {
  const selected = asRecord(order.ShippingServiceSelected);
  const details = asRecord(order.ShippingDetails);
  const options = asRecord(details?.ShippingServiceOptions);
  return (
    moneyToCents(selected?.ShippingServiceCost) ??
    moneyToCents(options?.ShippingServiceCost) ??
    moneyToCents(details?.ShippingServiceCost)
  );
}

function trackingNumbers(order: Record<string, unknown>) {
  const details = asRecord(order.ShippingDetails);
  const direct = asArray<Record<string, unknown>>(
    details?.ShipmentTrackingDetails as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  const txArray = asRecord(order.TransactionArray);
  const txs = asArray<Record<string, unknown>>(
    txArray?.Transaction as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  const txTracking = txs.flatMap((tx) => {
    const shipment = asRecord(tx.Shipment);
    const txShipDetails = asRecord(tx.ShippingDetails);
    return [
      ...asArray<Record<string, unknown>>(
        shipment?.ShipmentTrackingDetails as Record<string, unknown> | Record<string, unknown>[] | undefined,
      ),
      ...asArray<Record<string, unknown>>(
        txShipDetails?.ShipmentTrackingDetails as Record<string, unknown> | Record<string, unknown>[] | undefined,
      ),
    ];
  });
  return [...direct, ...txTracking]
    .map((row) => ({
      number: text(row.ShipmentTrackingNumber),
      carrier: text(row.ShippingCarrierUsed),
      shippedTime: text(row.ShippedTime),
    }))
    .filter((row, index, all) => row.number && all.findIndex((other) => other.number === row.number) === index);
}

function normalizeTrackingSearchValue(value: string | null | undefined) {
  return (value ?? "").replace(/[\s-]+/g, "").toLowerCase();
}

function rawOrderHasTracking(order: Record<string, unknown>, searchTerm: string) {
  const term = normalizeTrackingSearchValue(searchTerm);
  if (!term) return false;
  return trackingNumbers(order).some((tracking) => {
    const number = normalizeTrackingSearchValue(tracking.number);
    return number === term || number.includes(term);
  });
}

function appendSearchedTrackingIfMissing(order: ManageOrder, searchTerm: string) {
  const term = normalizeTrackingSearchValue(searchTerm);
  if (!term || order.trackingNumbers.some((tracking) => normalizeTrackingSearchValue(tracking.number) === term)) {
    return order;
  }
  return {
    ...order,
    trackingNumbers: [
      ...order.trackingNumbers,
      { number: searchTerm.trim(), carrier: null, shippedTime: order.shippedTime },
    ],
  };
}

function deliveryDates(order: Record<string, unknown>) {
  const tx = firstRecord(asRecord(order.TransactionArray)?.Transaction);
  const txSelected = asRecord(tx?.ShippingServiceSelected);
  const packageInfo = asRecord(txSelected?.ShippingPackageInfo);
  return {
    shipBy:
      text(order.ShipByTime) ??
      text(order.ShipByDate) ??
      text(order.HandleByTime) ??
      text(order.HandlingTime) ??
      text(tx?.ShippingDetails && asRecord(tx.ShippingDetails)?.ShipByTime),
    estimatedMin:
      text(order.EstimatedDeliveryDateMin) ??
      text(packageInfo?.EstimatedDeliveryTimeMin),
    estimatedMax:
      text(order.EstimatedDeliveryDateMax) ??
      text(packageInfo?.EstimatedDeliveryTimeMax),
  };
}

async function fetchStoreContexts(store: ManageOrdersStoreFilter): Promise<StoreContext[]> {
  const platforms: EbayStore[] =
    store === "ALL" ? ["TPP_EBAY", "TT_EBAY"] : [store];
  const integrations = await db.integration.findMany({
    where: { platform: { in: platforms }, enabled: true },
  });
  return Promise.all(
    integrations.map(async (integration) => {
      const config = buildEbayConfig(integration);
      return {
        platform: integration.platform as EbayStore,
        integrationId: integration.id,
        accessToken: await getEbayAccessToken(integration.id, config),
        environment: config.environment ?? "PRODUCTION",
        config,
      };
    }),
  );
}

async function ebayGetOrders(ctx: StoreContext, body: string) {
  const response = await fetch(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": ctx.accessToken,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-CALL-NAME": "GetOrders",
      "Content-Type": "text/xml",
    },
    body,
  });
  const xml = await response.text();
  if (!response.ok) throw new Error(`eBay GetOrders failed (${response.status})`);
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const root = asRecord(parsed.GetOrdersResponse);
  const ack = text(root?.Ack);
  if (ack && ack !== "Success" && ack !== "Warning") {
    throw new Error(`eBay GetOrders returned ${ack}`);
  }
  const orderArray = asRecord(root?.OrderArray);
  const orders = asArray<Record<string, unknown>>(
    orderArray?.Order as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  const pagination = asRecord(root?.PaginationResult);
  return {
    orders,
    total: Number(text(pagination?.TotalNumberOfEntries) ?? orders.length),
  };
}

async function fetchOrdersByIds(ctx: StoreContext, orderIds: string[]) {
  const uniqueOrderIds = Array.from(new Set(orderIds.map((orderId) => orderId.trim()).filter(Boolean)));
  if (uniqueOrderIds.length === 0) return [];
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderIDArray>${uniqueOrderIds.map((orderId) => `<OrderID>${escapeXml(orderId)}</OrderID>`).join("")}</OrderIDArray>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;
  const { orders } = await ebayGetOrders(ctx, body);
  return Promise.all(orders.map((order) => mapOrder(ctx, order)));
}

async function findLocalOrderIdsByTracking(ctx: StoreContext, searchTerm: string) {
  const candidates = Array.from(new Set([searchTerm.trim(), normalizeTrackingSearchValue(searchTerm)].filter(Boolean)));
  if (candidates.length === 0) return [];
  const jobs = await db.autoResponderJob.findMany({
    where: {
      integrationId: ctx.integrationId,
      trackingNumber: { in: candidates },
    },
    select: { orderNumber: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return Array.from(new Set(jobs.map((job) => job.orderNumber).filter(Boolean)));
}

async function fetchOrdersForContext(ctx: StoreContext, input: SearchInput) {
  const { from, to } = periodToDateRange(input.period);
  const exactOrderSearch = input.searchBy === "order_number" && input.searchTerm.trim();
  if (exactOrderSearch) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderIDArray><OrderID>${escapeXml(input.searchTerm.trim())}</OrderID></OrderIDArray>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;
    const { orders } = await ebayGetOrders(ctx, body);
    return Promise.all(orders.map((order) => mapOrder(ctx, order)));
  }

  const buildPagedBody = (pageNumber: number) => `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderStatus>Completed</OrderStatus>
  <CreateTimeFrom>${from.toISOString()}</CreateTimeFrom>
  <CreateTimeTo>${to.toISOString()}</CreateTimeTo>
  <Pagination>
    <EntriesPerPage>100</EntriesPerPage>
    <PageNumber>${pageNumber}</PageNumber>
  </Pagination>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;

  const searchTerm = input.searchTerm.trim();
  if (input.searchBy === "tracking_number" && searchTerm) {
    const localOrderIds = await findLocalOrderIdsByTracking(ctx, searchTerm);
    if (localOrderIds.length > 0) {
      const localMatches = await fetchOrdersByIds(ctx, localOrderIds);
      if (localMatches.length > 0) {
        return localMatches.map((order) => appendSearchedTrackingIfMissing(order, searchTerm));
      }
    }

    const matchedRawOrders: Record<string, unknown>[] = [];
    let nextPage = 1;
    let knownPageCeiling = TRACKING_SEARCH_PAGE_LIMIT;
    while (
      matchedRawOrders.length === 0 &&
      nextPage <= Math.min(TRACKING_SEARCH_PAGE_LIMIT, knownPageCeiling)
    ) {
      const waveEnd = Math.min(
        nextPage + TRACKING_SEARCH_PAGE_CONCURRENCY - 1,
        TRACKING_SEARCH_PAGE_LIMIT,
        knownPageCeiling,
      );
      const wavePages: number[] = [];
      for (let p = nextPage; p <= waveEnd; p += 1) wavePages.push(p);
      nextPage = waveEnd + 1;
      const waveResults = await Promise.all(
        wavePages.map((page) => ebayGetOrders(ctx, buildPagedBody(page))),
      );
      let lastPageReached = false;
      for (const { orders, total } of waveResults) {
        if (total > 0) {
          knownPageCeiling = Math.min(
            knownPageCeiling,
            Math.ceil(total / 100),
          );
        }
        matchedRawOrders.push(
          ...orders.filter((order) => rawOrderHasTracking(order, searchTerm)),
        );
        if (orders.length < 100) lastPageReached = true;
      }
      if (lastPageReached) break;
    }
    return Promise.all(matchedRawOrders.map((order) => mapOrder(ctx, order)));
  }

  const scanLimit = searchTerm
    ? NON_ORDER_SEARCH_PAGE_LIMIT
    : 1;
  const allOrders: ManageOrder[] = [];
  for (let pageNumber = 1; pageNumber <= scanLimit; pageNumber += 1) {
    const { orders, total } = await ebayGetOrders(ctx, buildPagedBody(pageNumber));
    const mapped = await Promise.all(orders.map((order) => mapOrder(ctx, order)));
    allOrders.push(...mapped);
    if (orders.length < 100 || pageNumber >= Math.ceil(total / 100)) break;
  }
  return allOrders;
}

export async function searchManageOrders(input: SearchInput): Promise<ManageOrdersSearchResult> {
  const contexts = await fetchStoreContexts(input.store);
  const settled = await Promise.allSettled(contexts.map((ctx) => fetchOrdersForContext(ctx, input)));
  const nested = settled.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];
    console.warn("[manage-orders/search] store lookup failed", {
      store: contexts[index]?.platform,
      error: result.reason instanceof Error ? result.reason.message : result.reason,
    });
    return [];
  });
  if (nested.length === 0 && settled.some((result) => result.status === "rejected")) {
    throw new Error("All eBay order searches failed.");
  }
  const now = new Date();
  const filtered = nested
    .flat()
    .filter((order) => matchesStatusFilter(order, input.status, now))
    .filter((order) => matchesSearch(order, input.searchBy, input.searchTerm))
    .sort((a, b) => Date.parse(b.paidTime ?? b.createdTime ?? "0") - Date.parse(a.paidTime ?? a.createdTime ?? "0"));

  const page = Math.max(1, input.page);
  const start = (page - 1) * PAGE_SIZE;
  const orders = await enrichOrdersWithFeedback(
    contexts,
    filtered.slice(start, start + PAGE_SIZE),
    Boolean(input.searchTerm.trim()) && filtered.length <= 5,
  );
  return {
    orders,
    totalCount: filtered.length,
    page,
    pageSize: PAGE_SIZE,
    totalCents: filtered.reduce((sum, order) => sum + (order.totalCents ?? 0), 0),
  };
}

export async function getManageOrderDetail(store: EbayStore, orderId: string) {
  const [ctx] = await fetchStoreContexts(store);
  if (!ctx) return null;
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderIDArray><OrderID>${escapeXml(orderId)}</OrderID></OrderIDArray>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;
  const { orders } = await ebayGetOrders(ctx, body);
  if (!orders[0]) return null;
  const order = await mapOrder(ctx, orders[0]);
  return enrichOrderDetail(ctx, order);
}

async function enrichOrderDetail(ctx: StoreContext, order: ManageOrder) {
  const [fulfillment, finance, feedback, cases] = await Promise.all([
    runWithTimeout(
      (signal) => fetchFulfillmentOrder(ctx, order.apiOrderId, signal),
      DETAIL_FULFILLMENT_TIMEOUT_MS,
      "fulfillment",
    ),
    runWithTimeout(
      (signal) => fetchFinanceForOrder(ctx, order, signal),
      DETAIL_FINANCE_TIMEOUT_MS,
      "finance",
    ),
    loadFeedbackSummaryForOrder(ctx, order, true),
    loadCaseSummaryForOrder(ctx, order),
  ]);
  return {
    ...applyDetailEnrichment(order, fulfillment, finance),
    feedback,
    cases,
  };
}

async function runWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T | null>,
  timeoutMs: number,
  label: string,
) {
  const controller = new AbortController();
  const timeout = windowlessSetTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    console.warn(`[manage-orders] ${label} enrichment skipped`, error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function windowlessSetTimeout(handler: () => void, timeoutMs: number) {
  return setTimeout(handler, timeoutMs);
}

async function mapOrder(ctx: StoreContext, order: Record<string, unknown>): Promise<ManageOrder> {
  const orderId = text(order.OrderID) ?? "";
  const txArray = asRecord(order.TransactionArray);
  const transactions = asArray<Record<string, unknown>>(
    txArray?.Transaction as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  const lines = transactions.map(mapLine);
  const enrichedLines = await enrichLines(lines, ctx.platform);
  const ship = asRecord(order.ShippingAddress);
  const shippingDetails = asRecord(order.ShippingDetails);
  const tracking = trackingNumbers(order);
  const dates = deliveryDates(order);
  const lineSubtotal = enrichedLines.reduce(
    (sum, line) => sum + (line.unitPriceCents ?? 0) * line.quantity,
    0,
  );
  const totalCents = moneyToCents(order.Total ?? order.AmountPaid);
  const shippingCents = shippingCost(order);
  const taxCents =
    moneyToCents(order.TotalTaxAmount) ??
    moneyToCents(asRecord(order.TaxTable)?.TaxJurisdiction && asRecord(asRecord(order.TaxTable)?.TaxJurisdiction)?.SalesTaxAmount) ??
    (totalCents != null && lineSubtotal > 0
      ? Math.max(0, totalCents - lineSubtotal - (shippingCents ?? 0))
      : null);

  return {
    orderId: orderId.includes("!") ? orderId.split("!")[0] ?? orderId : orderId,
    apiOrderId: orderId,
    store: ctx.platform,
    platform: ctx.platform,
    buyerName: buyerNameFromTransactions(transactions),
    buyerUsername: text(order.BuyerUserID) ?? text(firstRecord(transactions)?.Buyer && asRecord(firstRecord(transactions)?.Buyer)?.UserID),
    shippingPostalCode: text(ship?.PostalCode),
    shippingAddress: ship
      ? {
          name: text(ship.Name),
          street1: text(ship.Street1),
          street2: text(ship.Street2),
          cityName: text(ship.CityName),
          stateOrProvince: text(ship.StateOrProvince),
          postalCode: text(ship.PostalCode),
          countryName: text(ship.CountryName ?? ship.Country),
          phone: text(ship.Phone) === "Invalid Request" ? null : text(ship.Phone),
        }
      : null,
    createdTime: text(order.CreatedTime),
    paidTime: text(order.PaidTime),
    shipBy: dates.shipBy,
    estimatedDeliveryMin: dates.estimatedMin,
    estimatedDeliveryMax: dates.estimatedMax,
    shippedTime: text(order.ShippedTime),
    shippingService: selectedShippingService(order),
    trackingNumbers: tracking,
    subtotalCents: lineSubtotal || null,
    shippingCents,
    taxCents,
    totalCents,
    currency: currency(order.Total ?? order.AmountPaid),
    salesRecordNumber:
      text(order.SellingManagerSalesRecordNumber) ??
      text(shippingDetails?.SellingManagerSalesRecordNumber) ??
      text(firstRecord(transactions)?.SellingManagerSalesRecordNumber),
    finance: defaultFinance(),
    internalProfit: calculateInternalProfit(enrichedLines, totalCents, taxCents, defaultFinance()),
    feedback: defaultFeedbackSummary({
      createdTime: text(order.CreatedTime),
      paidTime: text(order.PaidTime),
      estimatedDeliveryMin: dates.estimatedMin,
      estimatedDeliveryMax: dates.estimatedMax,
    }),
    cases: defaultCaseSummary(),
    lines: enrichedLines,
  };
}

function mapLine(tx: Record<string, unknown>): ManageOrderLineItem {
  const item = asRecord(tx.Item);
  const variation = asRecord(tx.Variation);
  const itemId = text(item?.ItemID) ?? "";
  const sku = text(variation?.SKU) ?? text(item?.SKU) ?? text(tx.SKU);
  return {
    itemId,
    orderLineItemId: text(tx.OrderLineItemID),
    transactionId: text(tx.TransactionID),
    title: lineTitle(tx, item),
    variationSelections: variationSelections(variation),
    sku,
    quantity: Number(text(tx.QuantityPurchased) ?? 1) || 1,
    availableQuantity: null,
    unitPriceCents: moneyToCents(tx.TransactionPrice),
    imageUrl: itemPicture(item),
    listingUrl: itemId ? `https://www.ebay.com/itm/${itemId}` : null,
    supplierCostCents: null,
    supplierShippingCents: null,
    outboundShippingCents: null,
    adRate: null,
  };
}

async function enrichLines(lines: ManageOrderLineItem[], platform: EbayStore) {
  const skus = [...new Set(lines.map((line) => line.sku).filter(Boolean))] as string[];
  if (skus.length === 0) return lines;
  const [listings, shippingRateMap] = await Promise.all([
    db.marketplaceListing.findMany({
      where: {
        integration: { platform },
        sku: { in: skus },
      },
      select: {
        sku: true,
        inventory: true,
        imageUrl: true,
        adRate: true,
        masterRow: {
          select: {
            imageUrl: true,
            weight: true,
            supplierCost: true,
            supplierShipping: true,
            shippingCostOverride: true,
          },
        },
      },
    }).catch(() => []),
    fetchShippingRateMap().catch(() => new Map<string, number>()),
  ]);
  const bySku = new Map(listings.map((listing) => [listing.sku, listing]));
  return lines.map((line) => {
    const listing = line.sku ? bySku.get(line.sku) : undefined;
    const outboundShipping =
      listing?.masterRow.shippingCostOverride ??
      lookupShippingCostFromRates(listing?.masterRow.weight ?? null, shippingRateMap);
    return {
      ...line,
      availableQuantity: listing?.inventory ?? line.availableQuantity,
      imageUrl: listing?.masterRow.imageUrl ?? listing?.imageUrl ?? line.imageUrl,
      supplierCostCents: dollarsToCents(listing?.masterRow.supplierCost),
      supplierShippingCents: dollarsToCents(listing?.masterRow.supplierShipping),
      outboundShippingCents: dollarsToCents(outboundShipping),
      adRate: listing?.adRate ?? null,
    };
  });
}

async function fetchShippingRateMap() {
  const rates = await db.shippingRate.findMany({
    where: { cost: { not: null } },
    select: { weightKey: true, cost: true },
  });
  const rateMap = new Map<string, number>();
  for (const rate of rates) {
    if (rate.cost != null) rateMap.set(rate.weightKey, rate.cost);
  }
  return rateMap;
}

function lookupShippingCostFromRates(weight: string | null, rateMap: Map<string, number>) {
  if (!weight) return null;
  const trimmed = weight.trim().toUpperCase();
  if (rateMap.has(trimmed)) return rateMap.get(trimmed) ?? null;
  if (trimmed.endsWith("OZ")) return rateMap.get(trimmed.replace("OZ", "oz")) ?? null;
  if (/^\d+$/.test(trimmed)) return rateMap.get(`${trimmed}oz`) ?? null;
  if (/^\d+\s*LBS?$/.test(trimmed)) {
    const normalized = trimmed.replace(/\s+/g, "").replace(/LB$/, "LBS");
    return rateMap.get(normalized) ?? null;
  }
  return null;
}

function defaultFinance(): ManageOrderFinance {
  return {
    transactionFeesCents: null,
    adFeeCents: null,
    otherFeesCents: null,
    shippingLabelCents: null,
    orderEarningsCents: null,
    fundsStatus: null,
    fundsStatusDetail: null,
    feesKnown: false,
    source: "unavailable",
  };
}

function validDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function earliestDate(dates: Array<Date | null>) {
  return dates
    .filter((date): date is Date => Boolean(date))
    .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
}

function feedbackLeaveByIso(
  order: Pick<ManageOrder, "createdTime" | "paidTime" | "estimatedDeliveryMin" | "estimatedDeliveryMax">,
) {
  const deliveredOrExpected = earliestDate([
    validDate(order.estimatedDeliveryMax),
    validDate(order.estimatedDeliveryMin),
  ]);
  if (deliveredOrExpected) return addDays(deliveredOrExpected, 60).toISOString();
  const purchased = validDate(order.createdTime) ?? validDate(order.paidTime);
  return purchased ? addDays(purchased, 90).toISOString() : null;
}

function defaultFeedbackSummary(
  order: Pick<ManageOrder, "createdTime" | "paidTime" | "estimatedDeliveryMin" | "estimatedDeliveryMax">,
): ManageOrderFeedbackSummary {
  return {
    state: "UNKNOWN",
    items: [],
    checkedLive: false,
    leaveBy: feedbackLeaveByIso(order),
  };
}

function defaultCaseSummary(): ManageOrderCaseSummary {
  return {
    hasCases: false,
    openCount: 0,
    items: [],
  };
}

function caseKindLabel(kind: ManageOrderCaseItem["kind"]) {
  switch (kind) {
    case "RETURN":
      return "Return Case";
    case "ITEM_NOT_RECEIVED":
      return "INR Case";
    case "NOT_AS_DESCRIBED":
      return "INAD Claim";
    case "CHARGEBACK":
      return "Payment Dispute";
    default:
      return "eBay Case";
  }
}

function caseStatusLabel(status: string) {
  return status
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isOpenCaseStatus(status: string) {
  return !["CLOSED", "CANCELLED", "REFUNDED"].includes(status);
}

function fallbackCaseUrl(kind: ManageOrderCaseItem["kind"], externalId: string) {
  const encoded = encodeURIComponent(externalId);
  if (kind === "RETURN" || kind === "NOT_AS_DESCRIBED") {
    return `https://www.ebay.com/rtn/Return/ReturnsDetail?returnId=${encoded}`;
  }
  if (kind === "ITEM_NOT_RECEIVED") {
    return `https://www.ebay.com/ItemNotReceived/${encoded}`;
  }
  return null;
}

async function loadCaseSummaryForOrder(
  ctx: StoreContext,
  order: ManageOrder,
): Promise<ManageOrderCaseSummary> {
  const orderIds = [...new Set([order.orderId, order.apiOrderId].filter(Boolean))];
  if (orderIds.length === 0) return defaultCaseSummary();
  try {
    const rows = await db.helpdeskCase.findMany({
      where: {
        integrationId: ctx.integrationId,
        ebayOrderNumber: { in: orderIds },
      },
      orderBy: { openedAt: "desc" },
      take: 20,
    });
    const items = rows.map((row): ManageOrderCaseItem => {
      const kind = row.kind as ManageOrderCaseItem["kind"];
      const status = String(row.status);
      return {
        id: row.id,
        externalId: row.externalId,
        kind,
        label: caseKindLabel(kind),
        status,
        statusLabel: caseStatusLabel(status),
        reason: row.reason,
        openedAt: row.openedAt.toISOString(),
        closedAt: row.closedAt?.toISOString() ?? null,
        manageUrl: row.manageUrl ?? fallbackCaseUrl(kind, row.externalId),
        isOpen: isOpenCaseStatus(status),
      };
    });
    return {
      hasCases: items.length > 0,
      openCount: items.filter((item) => item.isOpen).length,
      items,
    };
  } catch (error) {
    console.warn("[manage-orders] case mirror lookup skipped", {
      orderId: order.orderId,
      store: order.store,
      error: error instanceof Error ? error.message : error,
    });
    return defaultCaseSummary();
  }
}

function feedbackSnapshotToManageOrderItem(snapshot: HelpdeskFeedbackSnapshot): ManageOrderFeedbackItem {
  return {
    id: snapshot.id,
    externalId: snapshot.externalId,
    kind: snapshot.kind as ManageOrderFeedbackItem["kind"],
    starRating: snapshot.starRating,
    comment: snapshot.comment,
    sellerResponse: snapshot.sellerResponse,
    ebayOrderNumber: snapshot.ebayOrderNumber,
    ebayItemId: snapshot.ebayItemId,
    buyerUserId: snapshot.buyerUserId,
    leftAt: snapshot.leftAt,
    source: snapshot.source,
    isAutomated: snapshot.isAutomated,
  };
}

function orderToFeedbackContext(order: ManageOrder): EbayOrderContext {
  const tracking = order.trackingNumbers.find((entry) => entry.number);
  return {
    orderId: order.orderId,
    salesRecordNumber: order.salesRecordNumber,
    buyerUserId: order.buyerUsername ?? "",
    buyerName: order.buyerName ?? order.buyerUsername ?? "",
    buyerEmail: null,
    orderStatus: order.shippedTime || order.trackingNumbers.length ? "SHIPPED" : null,
    createdTime: order.createdTime,
    paidTime: order.paidTime,
    shippedTime: order.shippedTime,
    estimatedDeliveryMin: order.estimatedDeliveryMin,
    estimatedDeliveryMax: order.estimatedDeliveryMax,
    actualDeliveryTime: null,
    shippingService: order.shippingService,
    trackingNumber: tracking?.number ?? null,
    trackingCarrier: tracking?.carrier ?? null,
    trackingNumbers: order.trackingNumbers
      .filter((entry): entry is { number: string; carrier: string | null; shippedTime: string | null } =>
        Boolean(entry.number),
      )
      .map((entry) => ({
        number: entry.number,
        carrier: entry.carrier,
        shippedTime: entry.shippedTime,
      })),
    totalCents: order.totalCents,
    shippingCents: order.shippingCents,
    currency: order.currency,
    shippingAddress: order.shippingAddress,
    lineItems: order.lines.map((line) => ({
      itemId: line.itemId,
      orderLineItemId: line.orderLineItemId,
      transactionId: line.transactionId,
      title: line.title,
      sku: line.sku,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      pictureUrl: line.imageUrl,
    })),
  };
}

async function withFeedbackTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T | null>([
      promise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function loadFeedbackSummaryForOrder(
  ctx: StoreContext,
  order: ManageOrder,
  allowLiveLookup: boolean,
): Promise<ManageOrderFeedbackSummary> {
  const fallback = defaultFeedbackSummary(order);
  try {
    const mirrorRows = await db.helpdeskFeedback.findMany({
      where: {
        integrationId: ctx.integrationId,
        ebayOrderNumber: order.orderId,
      },
      orderBy: { leftAt: "desc" },
      take: 20,
    });
    const mirrorItems = mirrorRows
      .map(feedbackMirrorToSnapshot)
      .map(feedbackSnapshotToManageOrderItem);
    if (mirrorItems.length > 0) {
      return {
        ...fallback,
        state: "LEFT",
        items: mirrorItems,
        checkedLive: false,
      };
    }
  } catch (error) {
    console.warn("[manage-orders] feedback mirror lookup skipped", {
      orderId: order.orderId,
      store: order.store,
      error: error instanceof Error ? error.message : error,
    });
  }

  if (!allowLiveLookup) {
    return {
      ...fallback,
      reason: "Live feedback lookup is skipped for broad result sets.",
    };
  }

  try {
    const live = await withFeedbackTimeout(
      fetchEbayFeedbackForOrderContext({
        integrationId: ctx.integrationId,
        config: ctx.config,
        order: orderToFeedbackContext(order),
      }),
      SEARCH_FEEDBACK_TIMEOUT_MS,
    );
    if (!live) {
      return {
        ...fallback,
        reason: "Feedback lookup timed out.",
      };
    }
    return {
      ...fallback,
      state: live.length > 0 ? "LEFT" : "NOT_LEFT",
      items: live.map(feedbackSnapshotToManageOrderItem),
      checkedLive: true,
    };
  } catch (error) {
    console.warn("[manage-orders] live feedback lookup skipped", {
      orderId: order.orderId,
      store: order.store,
      error: error instanceof Error ? error.message : error,
    });
    return {
      ...fallback,
      reason: "Feedback status unavailable.",
    };
  }
}

async function enrichOrdersWithFeedback(
  contexts: StoreContext[],
  orders: ManageOrder[],
  allowLiveLookup: boolean,
) {
  const contextByStore = new Map(contexts.map((ctx) => [ctx.platform, ctx]));
  return Promise.all(
    orders.map(async (order) => {
      const ctx = contextByStore.get(order.store);
      if (!ctx) return order;
      const [feedback, cases] = await Promise.all([
        loadFeedbackSummaryForOrder(ctx, order, allowLiveLookup),
        loadCaseSummaryForOrder(ctx, order),
      ]);
      return {
        ...order,
        feedback,
        cases,
      };
    }),
  );
}

function dollarsToCents(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null;
}

function numberFromJson(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const record = asRecord(value);
  return record
    ? numberFromJson(record.value ?? record.amount ?? record.convertedToValue ?? record.convertedFromValue)
    : null;
}

function stringFromJson(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function classifyFeeType(...parts: Array<string | null | undefined>) {
  const normalized = parts.filter(Boolean).join(" ").toUpperCase();
  if (
    normalized.includes("SHIPPING_LABEL") ||
    normalized.includes("POSTAGE") ||
    normalized.includes("LABEL")
  ) {
    return "shipping" as const;
  }
  if (
    normalized.includes("AD_FEE") ||
    normalized.includes("AD FEE") ||
    normalized.includes("PROMOTED") ||
    normalized.includes("ADVERT") ||
    normalized.includes("ADS EXPRESS") ||
    normalized.includes("OFFSITE")
  ) {
    return "ad" as const;
  }
  return "transaction" as const;
}

function moneyJsonToCents(value: unknown) {
  const amount = numberFromJson(value);
  return amount == null ? null : Math.round(amount * 100);
}

function absMoneyJsonToCents(value: unknown) {
  const cents = moneyJsonToCents(value);
  return cents == null ? null : Math.abs(cents);
}

function centsNear(a: number | null | undefined, b: number | null | undefined, tolerance = 3) {
  return a != null && b != null && Math.abs(a - b) <= tolerance;
}

function transactionBuyerUsername(transaction: Record<string, unknown>) {
  const buyer = asRecord(transaction.buyer);
  return stringFromJson(buyer?.username) ?? stringFromJson(buyer?.userId);
}

function transactionOrderLineItems(transaction: Record<string, unknown>) {
  return asArray<Record<string, unknown>>(
    transaction.orderLineItems as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
}

function transactionReferences(transaction: Record<string, unknown>) {
  return asArray<Record<string, unknown>>(
    transaction.references as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
}

function transactionMatchesOrder(transaction: Record<string, unknown>, order: ManageOrder) {
  const externalOrderId = stringFromJson(transaction.orderId);
  const salesRecord = stringFromJson(transaction.salesRecordReference);
  if (externalOrderId === order.orderId || externalOrderId === order.apiOrderId) return true;
  if (salesRecord && salesRecord === order.salesRecordNumber) return true;
  const referenceMatched = transactionReferences(transaction).some((reference) => {
    const referenceId = stringFromJson(reference.referenceId);
    return referenceId === order.orderId || referenceId === order.apiOrderId;
  });
  if (referenceMatched) return true;

  const orderLineIds = new Set(order.lines.map((line) => line.orderLineItemId).filter(Boolean));
  const itemIds = new Set(order.lines.map((line) => line.itemId).filter(Boolean));
  const skus = new Set(order.lines.map((line) => line.sku).filter(Boolean));
  const lineMatched = transactionOrderLineItems(transaction).some((line) => {
    const lineId = stringFromJson(line.lineItemId) ?? stringFromJson(line.orderLineItemId);
    const legacyItemId =
      stringFromJson(line.legacyItemId) ??
      stringFromJson(line.itemId) ??
      stringFromJson(line.listingMarketplaceId);
    const sku = stringFromJson(line.sku) ?? stringFromJson(line.customLabel);
    return Boolean(
      (lineId && orderLineIds.has(lineId)) ||
      (legacyItemId && itemIds.has(legacyItemId)) ||
      (sku && skus.has(sku)),
    );
  });
  if (lineMatched) return true;

  const buyer = transactionBuyerUsername(transaction);
  const basisCents = moneyJsonToCents(transaction.totalFeeBasisAmount);
  const amountCents = moneyJsonToCents(transaction.amount);
  const buyerMatches = buyer && order.buyerUsername && buyer.toLowerCase() === order.buyerUsername.toLowerCase();
  const amountMatches =
    centsNear(basisCents, order.subtotalCents) ||
    centsNear(basisCents, order.totalCents) ||
    centsNear(amountCents, order.totalCents) ||
    centsNear(amountCents, order.subtotalCents);
  return Boolean(buyerMatches && amountMatches);
}

function financeBaseUrl(ctx: StoreContext) {
  return ctx.environment === "PRODUCTION"
    ? "https://apiz.ebay.com"
    : "https://apiz.sandbox.ebay.com";
}

async function fetchFinanceJson(url: URL, ctx: StoreContext, signal?: AbortSignal) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
    signal,
  });
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`eBay finances fetch failed: ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

async function fetchOrderEarnings(ctx: StoreContext, orderId: string, signal?: AbortSignal) {
  const url = new URL(`${financeBaseUrl(ctx)}/sell/finances/v1/order_earnings/${encodeURIComponent(orderId)}`);
  return fetchFinanceJson(url, ctx, signal);
}

async function fetchFinanceTransactions(ctx: StoreContext, orderIds: string[], signal?: AbortSignal) {
  const allTransactions: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const limit = 200;
  for (const orderId of orderIds) {
    const fetchPage = async (offset: number) => {
      const url = new URL(`${financeBaseUrl(ctx)}/sell/finances/v1/transaction`);
      url.searchParams.set("filter", `orderId:{${orderId}}`);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      const json = await fetchFinanceJson(url, ctx, signal);
      if (!json) return { batch: [], total: 0 };
      return {
        batch: asArray<Record<string, unknown>>(
          json.transactions as Record<string, unknown> | Record<string, unknown>[] | undefined,
        ),
        total: Number(json.total ?? 0),
      };
    };

    const firstPage = await fetchPage(0);
    for (const transaction of firstPage.batch) {
      const key = stringFromJson(transaction.transactionId) ?? JSON.stringify(transaction);
      if (!seen.has(key)) {
        seen.add(key);
        allTransactions.push(transaction);
      }
    }
    const total = Number.isFinite(firstPage.total) && firstPage.total > 0 ? firstPage.total : null;
    if (total != null) {
      for (let offset = limit; offset < total; offset += limit) {
        const page = await fetchPage(offset);
        for (const transaction of page.batch) {
          const key = stringFromJson(transaction.transactionId) ?? JSON.stringify(transaction);
          if (!seen.has(key)) {
            seen.add(key);
            allTransactions.push(transaction);
          }
        }
      }
    }
  }
  return allTransactions;
}

function feeCents(fee: Record<string, unknown>) {
  return (
    absMoneyJsonToCents(fee.amount) ??
    absMoneyJsonToCents(fee.convertedFromAmount) ??
    absMoneyJsonToCents(fee.convertedToAmount) ??
    absMoneyJsonToCents(fee.value) ??
    0
  );
}

function addFee(
  target: { transactionFeesCents: number; adFeeCents: number; otherFeesCents: number; shippingLabelCents: number },
  feeParts: Array<string | null | undefined>,
  cents: number,
) {
  const classification = classifyFeeType(...feeParts);
  if (classification === "ad") target.adFeeCents += cents;
  else if (classification === "shipping") target.shippingLabelCents += cents;
  else target.transactionFeesCents += cents;
}

function parseOrderEarningsFinance(earnings: Record<string, unknown> | null): ManageOrderFinance | null {
  if (!earnings) return null;
  const summary = asRecord(earnings.orderEarningsSummary);
  const expenses = asRecord(summary?.expenses);
  if (!summary) return null;

  const totals = {
    transactionFeesCents: 0,
    adFeeCents: 0,
    otherFeesCents: 0,
    shippingLabelCents: 0,
  };
  for (const fee of asArray<Record<string, unknown>>(
    expenses?.marketplaceFees as Record<string, unknown> | Record<string, unknown>[] | undefined,
  )) {
    addFee(totals, [stringFromJson(fee.feeType), stringFromJson(fee.feeMemo)], feeCents(fee));
  }
  for (const fee of asArray<Record<string, unknown>>(
    expenses?.donations as Record<string, unknown> | Record<string, unknown>[] | undefined,
  )) {
    totals.otherFeesCents += feeCents(fee);
  }
  totals.shippingLabelCents += absMoneyJsonToCents(expenses?.shippingLabels) ?? 0;

  const orderEarningsCents =
    moneyJsonToCents(summary.orderEarnings) ??
    moneyJsonToCents(earnings.orderEarnings) ??
    null;

  return {
    transactionFeesCents: totals.transactionFeesCents,
    adFeeCents: totals.adFeeCents,
    otherFeesCents: totals.otherFeesCents,
    shippingLabelCents: totals.shippingLabelCents,
    orderEarningsCents,
    fundsStatus: null,
    fundsStatusDetail: null,
    feesKnown: true,
    source: "ebay_order_earnings",
  };
}

function mergeFinance(primary: ManageOrderFinance | null, fallback: ManageOrderFinance | null) {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return {
    ...primary,
    fundsStatus: primary.fundsStatus ?? fallback.fundsStatus,
    fundsStatusDetail: primary.fundsStatusDetail ?? fallback.fundsStatusDetail,
  };
}

function parseTransactionFinance(transactions: Record<string, unknown>[], order: ManageOrder) {
  if (transactions.length === 0) return null;
  let transactionFeesCents = 0;
  let adFeeCents = 0;
  let otherFeesCents = 0;
  let shippingLabelCents = 0;
  let taxCents = 0;
  let netCents: number | null = null;
  let salesRecordNumber: string | null = null;
  let fundsStatus: string | null = null;
  let fundsStatusDetail: string | null = null;

  const totals = {
    transactionFeesCents,
    adFeeCents,
    otherFeesCents,
    shippingLabelCents,
  };

  for (const transaction of transactions) {
    salesRecordNumber ??= stringFromJson(transaction.salesRecordReference);
    const transactionType = stringFromJson(transaction.transactionType);
    const feeType = stringFromJson(transaction.feeType);
    const transactionMemo = stringFromJson(transaction.transactionMemo);
    const transactionDescription =
      stringFromJson(transaction.description) ??
      stringFromJson(transaction.memo) ??
      stringFromJson(transaction.transactionDescription);
    if (transactionType === "SALE") {
      fundsStatus ??= stringFromJson(transaction.transactionStatus);
      fundsStatusDetail ??= transactionMemo;
      taxCents += absMoneyJsonToCents(transaction.ebayCollectedTaxAmount) ?? 0;
      const amount = moneyJsonToCents(transaction.amount);
      if (amount != null) netCents = (netCents ?? 0) + amount;
    } else if (feeType || transactionType === "NON_SALE_CHARGE" || moneyJsonToCents(transaction.amount) != null) {
      const rawCents = moneyJsonToCents(transaction.amount);
      const cents = rawCents != null && rawCents < 0 ? Math.abs(rawCents) : 0;
      addFee(totals, [feeType, transactionType, transactionMemo, transactionDescription], cents);
    }

    for (const lineItem of transactionOrderLineItems(transaction)) {
      for (const fee of asArray<Record<string, unknown>>(
        lineItem.marketplaceFees as Record<string, unknown> | Record<string, unknown>[] | undefined,
      )) {
        addFee(totals, [stringFromJson(fee.feeType), stringFromJson(fee.feeMemo)], feeCents(fee));
      }
    }
  }

  transactionFeesCents = totals.transactionFeesCents;
  adFeeCents = totals.adFeeCents;
  otherFeesCents = totals.otherFeesCents;
  shippingLabelCents = totals.shippingLabelCents;

  const buyerPaidCents =
    order.subtotalCents != null
      ? order.subtotalCents + (order.shippingCents ?? 0) + (taxCents || 0)
      : order.totalCents ?? 0;
  const computedNetCents =
    buyerPaidCents -
    (taxCents || 0) -
    transactionFeesCents -
    adFeeCents -
    otherFeesCents -
    shippingLabelCents;
  const hasSeparateSellingCosts =
    transactionFeesCents > 0 || adFeeCents > 0 || otherFeesCents > 0 || shippingLabelCents > 0;

  return {
    salesRecordNumber,
    taxCents: taxCents || null,
    finance: {
      transactionFeesCents,
      adFeeCents,
      otherFeesCents,
      shippingLabelCents,
      orderEarningsCents: hasSeparateSellingCosts ? computedNetCents : netCents ?? computedNetCents,
      fundsStatus,
      fundsStatusDetail,
      feesKnown: true,
      source: "ebay_finances" as const,
    },
  };
}

async function fetchFinanceForOrder(ctx: StoreContext, order: ManageOrder, signal?: AbortSignal) {
  const orderIds = [...new Set([order.apiOrderId, order.orderId].filter(Boolean))];
  const earningsResults = await Promise.allSettled(
    orderIds.map((orderId) => fetchOrderEarnings(ctx, orderId, signal)),
  );
  const orderEarningsFinance =
    earningsResults
      .map((result) => (result.status === "fulfilled" ? parseOrderEarningsFinance(result.value) : null))
      .find(Boolean) ?? null;

  const transactions = (await fetchFinanceTransactions(ctx, orderIds, signal)).filter((transaction) =>
    transactionMatchesOrder(transaction, order),
  );
  const transactionResult = parseTransactionFinance(transactions, order);

  return {
    salesRecordNumber: transactionResult?.salesRecordNumber,
    taxCents: transactionResult?.taxCents ?? null,
    finance: mergeFinance(orderEarningsFinance, transactionResult?.finance ?? null),
  };
}

async function fetchFulfillmentOrder(ctx: StoreContext, apiOrderId: string, signal?: AbortSignal) {
  const baseUrl =
    ctx.environment === "PRODUCTION"
      ? "https://api.ebay.com"
      : "https://api.sandbox.ebay.com";
  const response = await fetch(`${baseUrl}/sell/fulfillment/v1/order/${encodeURIComponent(apiOrderId)}`, {
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    signal,
  });
  if (!response.ok) return null;
  return (await response.json()) as Record<string, unknown>;
}

function applyDetailEnrichment(
  order: ManageOrder,
  fulfillment: Record<string, unknown> | null,
  financeResult: Awaited<ReturnType<typeof fetchFinanceForOrder>> | null,
) {
  let enriched = { ...order };
  if (fulfillment) {
    const instructions = asArray<Record<string, unknown>>(
      fulfillment.fulfillmentStartInstructions as Record<string, unknown> | Record<string, unknown>[] | undefined,
    );
    const firstInstruction = instructions[0];
    const shippingStep = asRecord(firstInstruction?.shippingStep);
    const minEstimated = stringFromJson(shippingStep?.minEstimatedDeliveryDate);
    const maxEstimated = stringFromJson(shippingStep?.maxEstimatedDeliveryDate);
    const shipBy = stringFromJson(firstInstruction?.maxEstimatedDeliveryDate) ??
      stringFromJson(shippingStep?.shipByDate) ??
      stringFromJson(fulfillment.shipByDate);
    enriched = {
      ...enriched,
      salesRecordNumber: enriched.salesRecordNumber ?? stringFromJson(fulfillment.salesRecordReference),
      shipBy: enriched.shipBy ?? shipBy,
      estimatedDeliveryMin: enriched.estimatedDeliveryMin ?? minEstimated,
      estimatedDeliveryMax: enriched.estimatedDeliveryMax ?? maxEstimated,
    };
  }
  if (financeResult?.finance) {
    const taxCents = financeResult.taxCents ?? enriched.taxCents;
    const calculatedBuyerTotal =
      enriched.subtotalCents != null
        ? enriched.subtotalCents + (enriched.shippingCents ?? 0) + (taxCents ?? 0)
        : null;
    const totalCents =
      calculatedBuyerTotal != null && financeResult.taxCents != null
        ? Math.max(enriched.totalCents ?? 0, calculatedBuyerTotal)
        : enriched.totalCents;
    enriched = {
      ...enriched,
      salesRecordNumber: enriched.salesRecordNumber ?? financeResult.salesRecordNumber ?? null,
      taxCents,
      totalCents,
      finance: financeResult.finance,
    };
  }
  return {
    ...enriched,
    internalProfit: calculateInternalProfit(
      enriched.lines,
      enriched.totalCents,
      enriched.taxCents,
      enriched.finance,
    ),
  };
}

function calculateInternalProfit(
  lines: ManageOrderLineItem[],
  totalCents: number | null,
  taxCents: number | null,
  finance: ManageOrder["finance"],
) {
  let itemCostCents = 0;
  let supplierShippingCents = 0;
  let outboundShippingCents = 0;
  let complete = true;
  for (const line of lines) {
    if (line.supplierCostCents == null) complete = false;
    if (line.supplierShippingCents == null) complete = false;
    itemCostCents += (line.supplierCostCents ?? 0) * line.quantity;
    supplierShippingCents += (line.supplierShippingCents ?? 0) * line.quantity;
    outboundShippingCents += (line.outboundShippingCents ?? 0) * line.quantity;
  }
  const totalCogsCents = itemCostCents + supplierShippingCents + outboundShippingCents;
  const sellingCostsKnown =
    finance.transactionFeesCents != null &&
    finance.adFeeCents != null &&
    finance.otherFeesCents != null &&
    finance.shippingLabelCents != null;
  const estimatedProfitCents =
    complete && finance.orderEarningsCents != null
      ? finance.orderEarningsCents - totalCogsCents
      : totalCents != null && complete && sellingCostsKnown
        ? totalCents -
          (taxCents ?? 0) -
          totalCogsCents -
          (finance.transactionFeesCents ?? 0) -
          (finance.adFeeCents ?? 0) -
          (finance.otherFeesCents ?? 0) -
          (finance.shippingLabelCents ?? 0)
      : null;
  return {
    itemCostCents: complete ? itemCostCents : itemCostCents || null,
    supplierShippingCents: complete ? supplierShippingCents : supplierShippingCents || null,
    outboundShippingCents: outboundShippingCents || null,
    totalCogsCents: complete ? totalCogsCents : totalCogsCents || null,
    estimatedProfitCents,
    dataComplete: complete && estimatedProfitCents != null,
  };
}

function buyerNameFromTransactions(transactions: Record<string, unknown>[]) {
  const buyer = asRecord(transactions[0]?.Buyer);
  const first = text(buyer?.UserFirstName);
  const last = text(buyer?.UserLastName);
  return [first, last].filter(Boolean).join(" ") || null;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
