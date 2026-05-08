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
  return orders[0] ? mapOrder(ctx, orders[0]) : null;
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
    totalCents != null && lineSubtotal > 0
      ? Math.max(0, totalCents - lineSubtotal - (shippingCents ?? 0))
      : null;

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
    salesRecordNumber: text(order.SellingManagerSalesRecordNumber),
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
      masterRow: { select: { imageUrl: true } },
    },
  }).catch(() => []);
  const bySku = new Map(listings.map((listing) => [listing.sku, listing]));
  return lines.map((line) => {
    const listing = line.sku ? bySku.get(line.sku) : undefined;
    return {
      ...line,
      availableQuantity: listing?.inventory ?? line.availableQuantity,
      imageUrl: listing?.masterRow.imageUrl ?? listing?.imageUrl ?? line.imageUrl,
    };
  });
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
