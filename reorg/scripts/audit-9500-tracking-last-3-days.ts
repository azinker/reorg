import { mkdirSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import {
  buildEbayConfig,
  extractTrackingNumbersFromOrder,
  getEbayAccessToken,
  parseXmlSimple,
} from "@/lib/services/auto-responder-ebay";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const DAYS = 3;
const TRACKING_PREFIX = "9500";
const REPORT_DIR = "reports";
let publicUspsUnavailableReason: string | null = null;

type Store = "TPP_EBAY" | "TT_EBAY";

type AuditRow = {
  store: Store;
  orderId: string;
  buyerUserId: string | null;
  buyerName: string | null;
  orderCreatedAt: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  ebayActualDeliveryTime: string | null;
  shippingName: string | null;
  shippingStreet1: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingZip: string | null;
  trackingNumber: string;
  trackingCarrier: string | null;
  trackingShippedAt: string | null;
  trackingStatus: "DELIVERED" | "IN_TRANSIT" | "PRE_TRANSIT" | "UNKNOWN" | "LOOKUP_UNAVAILABLE";
  deliveredAt: string | null;
  deliveredCity: string | null;
  deliveredState: string | null;
  deliveredZip: string | null;
  zipMatch: "MATCH" | "MISMATCH" | "UNKNOWN" | "NOT_DELIVERED";
  trackingSummary: string | null;
  lookupSource: string;
  lookupError: string | null;
  itemIds: string;
  skus: string;
  titles: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const inner = (value as Record<string, unknown>)["#text"];
    if (typeof inner === "string") return inner.trim() || null;
  }
  return null;
}

function compactTracking(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function first5Zip(value: string | null): string | null {
  const match = value?.match(/\d{5}/);
  return match?.[0] ?? null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function ebayGetOrders(
  integrationId: string,
  accessToken: string,
  body: string,
): Promise<Record<string, unknown>[]> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await fetch(TRADING_API, {
      method: "POST",
      headers: {
        "X-EBAY-API-IAF-TOKEN": accessToken,
        "X-EBAY-API-SITEID": SITE_ID,
        "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
        "X-EBAY-API-CALL-NAME": "GetOrders",
        "Content-Type": "text/xml",
      },
      body,
    });
    const xml = await res.text();
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      continue;
    }
    const parsed = parseXmlSimple(xml);
    const root = parsed.GetOrdersResponse as Record<string, unknown> | undefined;
    const ack = text(root?.Ack);
    if (ack && ack !== "Success" && ack !== "Warning") {
      lastError = `Ack=${ack}`;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      continue;
    }
    const raw = asRecord(root?.OrderArray)?.Order;
    return asArray<Record<string, unknown>>(raw as Record<string, unknown> | Record<string, unknown>[] | undefined);
  }
  throw new Error(`GetOrders failed for ${integrationId}: ${lastError ?? "unknown error"}`);
}

async function fetchRecentOrders(store: Store, from: Date, to: Date) {
  const integration = await db.integration.findFirst({
    where: { platform: store as Platform, enabled: true },
    select: { id: true, label: true, platform: true, config: true },
  });
  if (!integration) throw new Error(`No enabled integration found for ${store}`);
  const config = buildEbayConfig(integration);
  const accessToken = await getEbayAccessToken(integration.id, config);
  const all: Record<string, unknown>[] = [];
  let page = 1;
  while (page <= 50) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderStatus>Completed</OrderStatus>
  <CreateTimeFrom>${from.toISOString()}</CreateTimeFrom>
  <CreateTimeTo>${to.toISOString()}</CreateTimeTo>
  <Pagination>
    <EntriesPerPage>100</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;
    const orders = await ebayGetOrders(integration.id, accessToken, body);
    all.push(...orders);
    if (orders.length < 100) break;
    page += 1;
  }
  return all;
}

function orderShippingAddress(order: Record<string, unknown>) {
  const address = asRecord(order.ShippingAddress);
  return {
    name: text(address?.Name),
    street1: text(address?.Street1),
    city: text(address?.CityName),
    state: text(address?.StateOrProvince),
    zip: text(address?.PostalCode),
  };
}

function orderLines(order: Record<string, unknown>) {
  const txArray = asRecord(order.TransactionArray);
  const transactions = asArray<Record<string, unknown>>(
    txArray?.Transaction as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  return transactions.map((tx) => {
    const item = asRecord(tx.Item);
    const variation = asRecord(tx.Variation);
    return {
      itemId: text(item?.ItemID),
      sku: text(variation?.SKU) ?? text(item?.SKU) ?? text(tx.SKU),
      title: text(item?.Title),
    };
  });
}

function actualDeliveryTime(order: Record<string, unknown>): string | null {
  const txArray = asRecord(order.TransactionArray);
  const firstTx = asArray<Record<string, unknown>>(
    txArray?.Transaction as Record<string, unknown> | Record<string, unknown>[] | undefined,
  )[0];
  const paths = [
    asRecord(order.ShippingServiceSelected),
    asRecord(firstTx?.ShippingServiceSelected),
    asRecord(order.ShippingDetails),
    asRecord(firstTx?.ShippingDetails),
  ];
  for (const pathRecord of paths) {
    const packageInfo = asRecord(pathRecord?.ShippingPackageInfo);
    const value = text(packageInfo?.ActualDeliveryTime);
    if (value) return value;
  }
  return null;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function lookupUsps(trackingNumber: string): Promise<{
  status: AuditRow["trackingStatus"];
  deliveredAt: string | null;
  deliveredCity: string | null;
  deliveredState: string | null;
  deliveredZip: string | null;
  summary: string | null;
  source: string;
  error: string | null;
}> {
  const userId = process.env.USPS_WEB_TOOLS_USER_ID ?? process.env.USPS_USER_ID;
  if (userId) {
    try {
      const xml = `<TrackFieldRequest USERID="${escapeXml(userId)}"><Revision>1</Revision><ClientIp>127.0.0.1</ClientIp><SourceId>reorG</SourceId><TrackID ID="${escapeXml(trackingNumber)}"/></TrackFieldRequest>`;
      const url = `https://secure.shippingapis.com/ShippingAPI.dll?API=TrackV2&XML=${encodeURIComponent(xml)}`;
      const res = await fetch(url, { headers: { "User-Agent": "reorG internal audit" } });
      const body = await res.text();
      if (!res.ok) throw new Error(`USPS API HTTP ${res.status}`);
      const parsed = parseXmlSimple(body);
      const info = asRecord(asRecord(parsed.TrackResponse)?.TrackInfo);
      const error = asRecord(info?.Error);
      if (error) throw new Error(text(error.Description) ?? "USPS API error");
      const summary = text(info?.TrackSummary);
      const events = asArray<Record<string, unknown>>(
        info?.TrackDetail as Record<string, unknown> | Record<string, unknown>[] | undefined,
      );
      const allText = [summary, ...events.map((event) => text(event))].filter(Boolean).join(" | ");
      const delivered = /delivered/i.test(allText);
      const inTransit = /in transit|arrived|departed|moving through network|out for delivery/i.test(allText);
      const city = text(info?.DestinationCity);
      const state = text(info?.DestinationState);
      const zip = first5Zip(text(info?.DestinationZip));
      return {
        status: delivered ? "DELIVERED" : inTransit ? "IN_TRANSIT" : "UNKNOWN",
        deliveredAt: delivered ? (text(info?.PredictedDeliveryDate) ?? null) : null,
        deliveredCity: delivered ? city : null,
        deliveredState: delivered ? state : null,
        deliveredZip: delivered ? zip : null,
        summary,
        source: "USPS TrackV2",
        error: null,
      };
    } catch (err) {
      return {
        status: "LOOKUP_UNAVAILABLE",
        deliveredAt: null,
        deliveredCity: null,
        deliveredState: null,
        deliveredZip: null,
        summary: null,
        source: "USPS TrackV2",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (publicUspsUnavailableReason) {
    return {
      status: "LOOKUP_UNAVAILABLE",
      deliveredAt: null,
      deliveredCity: null,
      deliveredState: null,
      deliveredZip: null,
      summary: null,
      source: "USPS public page",
      error: publicUspsUnavailableReason,
    };
  }

  try {
    const res = await fetch(
      `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      },
    );
    const html = await res.text();
    const plain = stripHtml(html);
    if (!res.ok) throw new Error(`USPS public page HTTP ${res.status}`);
    if (!plain.includes(trackingNumber) && !/delivered|in transit|out for delivery/i.test(plain)) {
      throw new Error("USPS public page did not expose tracking details (likely bot-protected)");
    }
    const delivered = /delivered/i.test(plain);
    const inTransit = /in transit|arrived|departed|moving through network|out for delivery/i.test(plain);
    const zipMatch = plain.match(/\b([A-Z][A-Z .'-]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/);
    return {
      status: delivered ? "DELIVERED" : inTransit ? "IN_TRANSIT" : "UNKNOWN",
      deliveredAt: null,
      deliveredCity: delivered ? (zipMatch?.[1]?.trim() ?? null) : null,
      deliveredState: delivered ? (zipMatch?.[2] ?? null) : null,
      deliveredZip: delivered ? (zipMatch?.[3] ?? null) : null,
      summary: plain.slice(0, 500),
      source: "USPS public page",
      error: null,
    };
  } catch (err) {
    publicUspsUnavailableReason = err instanceof Error ? err.message : String(err);
    return {
      status: "LOOKUP_UNAVAILABLE",
      deliveredAt: null,
      deliveredCity: null,
      deliveredState: null,
      deliveredZip: null,
      summary: null,
      source: "USPS public page",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function zipResult(orderZip: string | null, deliveredZip: string | null, status: AuditRow["trackingStatus"]) {
  if (status !== "DELIVERED") return "NOT_DELIVERED" as const;
  const orderZip5 = first5Zip(orderZip);
  const deliveredZip5 = first5Zip(deliveredZip);
  if (!orderZip5 || !deliveredZip5) return "UNKNOWN" as const;
  return orderZip5 === deliveredZip5 ? "MATCH" : "MISMATCH";
}

function buyerInfo(order: Record<string, unknown>) {
  const txArray = asRecord(order.TransactionArray);
  const firstTx = asArray<Record<string, unknown>>(
    txArray?.Transaction as Record<string, unknown> | Record<string, unknown>[] | undefined,
  )[0];
  const buyer = asRecord(firstTx?.Buyer);
  const first = text(buyer?.UserFirstName);
  const last = text(buyer?.UserLastName);
  const name = [first, last].filter(Boolean).join(" ").trim();
  return {
    userId: text(order.BuyerUserID) ?? text(buyer?.UserID),
    name: name || text(buyer?.UserID),
  };
}

function sheetColumns() {
  return [
    { header: "Store", key: "store", width: 12 },
    { header: "Order ID", key: "orderId", width: 18 },
    { header: "Buyer User ID", key: "buyerUserId", width: 18 },
    { header: "Buyer Name", key: "buyerName", width: 22 },
    { header: "Order Created", key: "orderCreatedAt", width: 22 },
    { header: "Paid At", key: "paidAt", width: 22 },
    { header: "Shipped At", key: "shippedAt", width: 22 },
    { header: "eBay Actual Delivery", key: "ebayActualDeliveryTime", width: 22 },
    { header: "Ship Name", key: "shippingName", width: 24 },
    { header: "Ship Street", key: "shippingStreet1", width: 32 },
    { header: "Ship City", key: "shippingCity", width: 18 },
    { header: "Ship State", key: "shippingState", width: 12 },
    { header: "Ship ZIP", key: "shippingZip", width: 12 },
    { header: "Tracking Number", key: "trackingNumber", width: 26 },
    { header: "Carrier", key: "trackingCarrier", width: 12 },
    { header: "Tracking Shipped At", key: "trackingShippedAt", width: 22 },
    { header: "Tracking Status", key: "trackingStatus", width: 20 },
    { header: "Delivered At", key: "deliveredAt", width: 22 },
    { header: "Delivered City", key: "deliveredCity", width: 20 },
    { header: "Delivered State", key: "deliveredState", width: 14 },
    { header: "Delivered ZIP", key: "deliveredZip", width: 14 },
    { header: "ZIP Match", key: "zipMatch", width: 14 },
    { header: "Lookup Source", key: "lookupSource", width: 18 },
    { header: "Lookup Error", key: "lookupError", width: 52 },
    { header: "Tracking Summary", key: "trackingSummary", width: 80 },
    { header: "Item IDs", key: "itemIds", width: 22 },
    { header: "SKUs", key: "skus", width: 28 },
    { header: "Titles", key: "titles", width: 60 },
  ];
}

function addSheet(workbook: ExcelJS.Workbook, name: string, rows: AuditRow[]) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = sheetColumns();
  sheet.addRows(rows);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columnCount },
  };
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "<unknown>";
  console.log(`[audit] DB host: ${host}`);
  if (!host.includes("little-fire")) {
    throw new Error("Refusing to run: expected prod little-fire DATABASE_URL");
  }

  const to = new Date();
  const from = new Date(to.getTime() - DAYS * 86_400_000);
  console.log(`[audit] Window: ${from.toISOString()} -> ${to.toISOString()}`);

  const rows: AuditRow[] = [];
  for (const store of ["TPP_EBAY", "TT_EBAY"] as const) {
    console.log(`[audit] Fetching ${store} orders...`);
    const orders = await fetchRecentOrders(store, from, to);
    console.log(`[audit] ${store}: ${orders.length} orders`);
    for (const order of orders) {
      const trackingNumbers = extractTrackingNumbersFromOrder(order).filter((tracking) =>
        compactTracking(tracking.number).startsWith(TRACKING_PREFIX),
      );
      if (trackingNumbers.length === 0) continue;
      const address = orderShippingAddress(order);
      const lines = orderLines(order);
      const buyer = buyerInfo(order);
      const ebayDeliveredAt = actualDeliveryTime(order);
      for (const tracking of trackingNumbers) {
        const lookup = await lookupUsps(compactTracking(tracking.number));
        const trackingStatus =
          lookup.status === "LOOKUP_UNAVAILABLE" && ebayDeliveredAt
            ? "DELIVERED"
            : lookup.status;
        const deliveredAt =
          lookup.status === "LOOKUP_UNAVAILABLE" && ebayDeliveredAt
            ? ebayDeliveredAt
            : lookup.deliveredAt;
        const lookupSource =
          lookup.status === "LOOKUP_UNAVAILABLE" && ebayDeliveredAt
            ? "eBay ActualDeliveryTime (USPS scan ZIP unavailable)"
            : lookup.source;
        const lookupError =
          lookup.status === "LOOKUP_UNAVAILABLE" && ebayDeliveredAt
            ? [lookup.error, "USPS did not provide delivery scan ZIP; eBay has ActualDeliveryTime"].filter(Boolean).join(" | ")
            : lookup.error;
        rows.push({
          store,
          orderId: text(order.OrderID) ?? "",
          buyerUserId: buyer.userId,
          buyerName: buyer.name,
          orderCreatedAt: text(order.CreatedTime),
          paidAt: text(order.PaidTime),
          shippedAt: text(order.ShippedTime),
          ebayActualDeliveryTime: ebayDeliveredAt,
          shippingName: address.name,
          shippingStreet1: address.street1,
          shippingCity: address.city,
          shippingState: address.state,
          shippingZip: address.zip,
          trackingNumber: compactTracking(tracking.number),
          trackingCarrier: tracking.carrier ?? "USPS",
          trackingShippedAt: tracking.shippedTime,
          trackingStatus,
          deliveredAt,
          deliveredCity: lookup.deliveredCity,
          deliveredState: lookup.deliveredState,
          deliveredZip: lookup.deliveredZip,
          zipMatch: zipResult(address.zip, lookup.deliveredZip, trackingStatus),
          trackingSummary: lookup.summary,
          lookupSource,
          lookupError,
          itemIds: lines.map((line) => line.itemId).filter(Boolean).join(", "),
          skus: lines.map((line) => line.sku).filter(Boolean).join(", "),
          titles: lines.map((line) => line.title).filter(Boolean).join(" | "),
        });
        console.log(`[audit] ${store} ${text(order.OrderID)} ${tracking.number}: ${lookup.status} ${rows.at(-1)?.zipMatch}`);
      }
    }
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "reorG";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Metric", key: "metric", width: 36 },
    { header: "Value", key: "value", width: 24 },
  ];
  summary.addRows([
    { metric: "Window start", value: from.toISOString() },
    { metric: "Window end", value: to.toISOString() },
    { metric: "Tracking prefix", value: TRACKING_PREFIX },
    { metric: "Total 9500 tracking rows", value: rows.length },
    { metric: "Delivered", value: rows.filter((row) => row.trackingStatus === "DELIVERED").length },
    { metric: "Delivered ZIP match", value: rows.filter((row) => row.zipMatch === "MATCH").length },
    { metric: "Delivered ZIP mismatch", value: rows.filter((row) => row.zipMatch === "MISMATCH").length },
    { metric: "In transit", value: rows.filter((row) => row.trackingStatus === "IN_TRANSIT").length },
    { metric: "Pre-transit", value: rows.filter((row) => row.trackingStatus === "PRE_TRANSIT").length },
    { metric: "Unknown", value: rows.filter((row) => row.trackingStatus === "UNKNOWN").length },
    { metric: "Lookup unavailable", value: rows.filter((row) => row.trackingStatus === "LOOKUP_UNAVAILABLE").length },
  ]);
  summary.getRow(1).font = { bold: true };

  addSheet(workbook, "All 9500 Tracking", rows);
  addSheet(workbook, "Delivered ZIP Match", rows.filter((row) => row.zipMatch === "MATCH"));
  addSheet(workbook, "Delivered ZIP Mismatch", rows.filter((row) => row.zipMatch === "MISMATCH"));
  addSheet(workbook, "Delivered ZIP Unknown", rows.filter((row) => row.trackingStatus === "DELIVERED" && row.zipMatch === "UNKNOWN"));
  addSheet(workbook, "In Transit", rows.filter((row) => row.trackingStatus === "IN_TRANSIT"));
  addSheet(workbook, "Not Delivered Unknown", rows.filter((row) => row.trackingStatus !== "DELIVERED" && row.trackingStatus !== "IN_TRANSIT"));

  mkdirSync(REPORT_DIR, { recursive: true });
  const fileName = `tracking-9500-delivery-zip-audit-${new Date().toISOString().slice(0, 10)}.xlsx`;
  const outPath = path.join(REPORT_DIR, fileName);
  await workbook.xlsx.writeFile(outPath);
  console.log(`[audit] Wrote ${outPath}`);
}

main()
  .catch((err) => {
    console.error("[audit] FAILED", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
