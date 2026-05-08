import { XMLParser } from "fast-xml-parser";
import { db } from "@/lib/db";
import {
  buildEbayConfig,
  getEbayAccessToken,
} from "@/lib/services/auto-responder-ebay";
import { periodToDateRange, matchesSearch, matchesStatusFilter } from "@/lib/manage-orders/filters";
import type {
  EbayStore,
  ManageOrder,
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

async function fetchOrdersForContext(ctx: StoreContext, input: SearchInput) {
  const { from, to } = periodToDateRange(input.period);
  const exactOrderSearch = input.searchBy === "order_number" && input.searchTerm.trim();
  const body = exactOrderSearch
    ? `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderIDArray><OrderID>${escapeXml(input.searchTerm.trim())}</OrderID></OrderIDArray>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`
    : `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderStatus>Completed</OrderStatus>
  <CreateTimeFrom>${from.toISOString()}</CreateTimeFrom>
  <CreateTimeTo>${to.toISOString()}</CreateTimeTo>
  <Pagination>
    <EntriesPerPage>100</EntriesPerPage>
    <PageNumber>1</PageNumber>
  </Pagination>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;

  const { orders } = await ebayGetOrders(ctx, body);
  return Promise.all(orders.map((order) => mapOrder(ctx, order)));
}

export async function searchManageOrders(input: SearchInput): Promise<ManageOrdersSearchResult> {
  const contexts = await fetchStoreContexts(input.store);
  const nested = await Promise.all(contexts.map((ctx) => fetchOrdersForContext(ctx, input)));
  const now = new Date();
  const filtered = nested
    .flat()
    .filter((order) => matchesStatusFilter(order, input.status, now))
    .filter((order) => matchesSearch(order, input.searchBy, input.searchTerm))
    .sort((a, b) => Date.parse(b.paidTime ?? b.createdTime ?? "0") - Date.parse(a.paidTime ?? a.createdTime ?? "0"));

  const page = Math.max(1, input.page);
  const start = (page - 1) * PAGE_SIZE;
  const orders = filtered.slice(start, start + PAGE_SIZE);
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
  const [fulfillment, finance] = await Promise.all([
    fetchFulfillmentOrder(ctx, order.apiOrderId).catch(() => null),
    fetchFinanceForOrder(ctx, order).catch((error) => {
      console.warn("[manage-orders] finance lookup failed", error);
      return null;
    }),
  ]);
  return applyDetailEnrichment(order, fulfillment, finance);
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
      text(firstRecord(transactions)?.SellingManagerSalesRecordNumber),
    finance: defaultFinance(),
    internalProfit: calculateInternalProfit(enrichedLines, totalCents, taxCents, defaultFinance()),
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
  const listings = await db.marketplaceListing.findMany({
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
          supplierCost: true,
          supplierShipping: true,
          shippingCostOverride: true,
        },
      },
    },
  }).catch(() => []);
  const bySku = new Map(listings.map((listing) => [listing.sku, listing]));
  return lines.map((line) => {
    const listing = line.sku ? bySku.get(line.sku) : undefined;
    return {
      ...line,
      availableQuantity: listing?.inventory ?? line.availableQuantity,
      imageUrl: listing?.masterRow.imageUrl ?? listing?.imageUrl ?? line.imageUrl,
      supplierCostCents: dollarsToCents(listing?.masterRow.supplierCost),
      supplierShippingCents: dollarsToCents(listing?.masterRow.supplierShipping),
      outboundShippingCents: dollarsToCents(listing?.masterRow.shippingCostOverride),
      adRate: listing?.adRate ?? null,
    };
  });
}

function defaultFinance() {
  return {
    transactionFeesCents: null,
    adFeeCents: null,
    otherFeesCents: null,
    orderEarningsCents: null,
    feesKnown: false,
    source: "unavailable" as const,
  };
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
  return record ? numberFromJson(record.value ?? record.amount) : null;
}

function stringFromJson(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function classifyFeeType(feeType: string | null | undefined) {
  const normalized = (feeType ?? "").toUpperCase();
  if (
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

async function fetchFinanceForOrder(ctx: StoreContext, order: ManageOrder) {
  const pivot = new Date(order.paidTime ?? order.createdTime ?? Date.now());
  const from = new Date(pivot);
  from.setDate(from.getDate() - 3);
  const to = new Date(pivot);
  to.setDate(to.getDate() + 21);
  const baseUrl =
    ctx.environment === "PRODUCTION"
      ? "https://apiz.ebay.com"
      : "https://apiz.sandbox.ebay.com";
  const url = new URL(`${baseUrl}/sell/finances/v1/transaction`);
  url.searchParams.set("filter", `transactionDate:[${from.toISOString()}..${to.toISOString()}]`);
  url.searchParams.set("limit", "200");
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) throw new Error(`eBay finances fetch failed: ${response.status}`);
  const json = (await response.json()) as { transactions?: Array<Record<string, unknown>> };
  const orderLineIds = new Set(order.lines.map((line) => line.orderLineItemId).filter(Boolean));
  const transactions = (json.transactions ?? []).filter((transaction) => {
    const externalOrderId = stringFromJson(transaction.orderId);
    const salesRecord = stringFromJson(transaction.salesRecordReference);
    if (externalOrderId === order.orderId || externalOrderId === order.apiOrderId) return true;
    if (salesRecord && salesRecord === order.salesRecordNumber) return true;
    return asArray<Record<string, unknown>>(
      transaction.orderLineItems as Record<string, unknown> | Record<string, unknown>[] | undefined,
    ).some((line) => {
      const lineId = stringFromJson(line.lineItemId) ?? stringFromJson(line.orderLineItemId);
      return Boolean(lineId && orderLineIds.has(lineId));
    });
  });

  if (transactions.length === 0) return null;

  let transactionFeesCents = 0;
  let adFeeCents = 0;
  let otherFeesCents = 0;
  let taxCents = 0;
  let netCents: number | null = null;
  let salesRecordNumber: string | null = null;

  for (const transaction of transactions) {
    salesRecordNumber ??= stringFromJson(transaction.salesRecordReference);
    const transactionType = stringFromJson(transaction.transactionType);
    taxCents += moneyJsonToCents(transaction.ebayCollectedTaxAmount) ?? 0;
    const amount = moneyJsonToCents(transaction.amount);
    if (amount != null) netCents = (netCents ?? 0) + amount;
    for (const lineItem of asArray<Record<string, unknown>>(
      transaction.orderLineItems as Record<string, unknown> | Record<string, unknown>[] | undefined,
    )) {
      for (const fee of asArray<Record<string, unknown>>(
        lineItem.marketplaceFees as Record<string, unknown> | Record<string, unknown>[] | undefined,
      )) {
        const feeCents =
          moneyJsonToCents(fee.amount) ??
          moneyJsonToCents(fee.convertedFromAmount) ??
          moneyJsonToCents(fee.value) ??
          0;
        const classification = classifyFeeType(stringFromJson(fee.feeType));
        if (classification === "ad") {
          adFeeCents += feeCents;
        } else if (transactionType === "SALE") {
          transactionFeesCents += feeCents;
        } else {
          otherFeesCents += feeCents;
        }
      }
    }
  }

  return {
    salesRecordNumber,
    taxCents: taxCents || null,
    finance: {
      transactionFeesCents,
      adFeeCents,
      otherFeesCents,
      orderEarningsCents: netCents,
      feesKnown: true,
      source: "ebay_finances" as const,
    },
  };
}

async function fetchFulfillmentOrder(ctx: StoreContext, apiOrderId: string) {
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
      shipBy: enriched.shipBy ?? shipBy,
      estimatedDeliveryMin: enriched.estimatedDeliveryMin ?? minEstimated,
      estimatedDeliveryMax: enriched.estimatedDeliveryMax ?? maxEstimated,
    };
  }
  if (financeResult) {
    enriched = {
      ...enriched,
      salesRecordNumber: enriched.salesRecordNumber ?? financeResult.salesRecordNumber,
      taxCents: enriched.taxCents ?? financeResult.taxCents,
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
  const feesKnown = finance.transactionFeesCents != null && finance.adFeeCents != null;
  const estimatedProfitCents =
    totalCents != null && complete && feesKnown
      ? totalCents - (taxCents ?? 0) - totalCogsCents - (finance.transactionFeesCents ?? 0) - (finance.adFeeCents ?? 0)
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
