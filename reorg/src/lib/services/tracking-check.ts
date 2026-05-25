import ExcelJS from "exceljs";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import {
  extractTrackingNumbersFromOrder,
  parseXmlSimple,
} from "@/lib/services/auto-responder-ebay";

export const TRACKING_CHECK_ALLOWED_EMAIL = "adam@theperfectpart.net";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const TRACKING_DETAILS_URL = "https://www.ebay.com/ship/trk/tracking-details";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const GET_ORDERS_BATCH_SIZE = 20;
const TRACKING_FETCH_CONCURRENCY = 4;
const EBAY_ORDER_ID_PATTERN = /^\d{2}-\d{5}-\d{5}$/;

type EbayStore = "TPP_EBAY" | "TT_EBAY";

type OrderRecord = {
  store: EbayStore;
  order: Record<string, unknown>;
};

export type TrackingCheckSourceFile = {
  filename: string;
  buffer: Buffer;
};

export type TrackingCheckCurlFile = {
  filename: string;
  text: string;
};

type BrowserHeaderSet = {
  source: string;
  headers: Record<string, string>;
};

type AuditRow = {
  sourceFile: string;
  sourceRow: number;
  orderId: string;
  eBayOrder: "YES" | "NO";
  store: EbayStore | "NOT_FOUND" | "N/A";
  orderCity: string | null;
  orderState: string | null;
  orderZip: string | null;
  trackingNumber: string | null;
  trackingCarrier: string | null;
  trackingUrl: string | null;
  trackingStatus: "DELIVERED" | "IN_TRANSIT" | "UNKNOWN" | "NOT_FOUND" | "NOT_EBAY_ORDER" | "TRACKING_PAGE_UNAVAILABLE";
  scanEvent: string | null;
  scanDate: string | null;
  scanTime: string | null;
  scanCity: string | null;
  scanState: string | null;
  scanZip: string | null;
  cityMatch: "MATCH" | "MISMATCH" | "UNKNOWN" | "N/A";
  stateMatch: "MATCH" | "MISMATCH" | "UNKNOWN" | "N/A";
  zipMatch: "MATCH" | "MISMATCH" | "UNKNOWN" | "N/A";
  overallMatch: "MATCH" | "MISMATCH" | "NOT_DELIVERED" | "UNKNOWN" | "N/A";
  notes: string | null;
};

export function canUseTrackingCheck(email: string | null | undefined) {
  return email?.trim().toLowerCase() === TRACKING_CHECK_ALLOWED_EMAIL;
}

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

function normalize(value: string | null): string | null {
  return value?.trim().toUpperCase().replace(/\s+/g, " ") || null;
}

function first5Zip(value: string | null): string | null {
  return value?.match(/\d{5}/)?.[0] ?? null;
}

function compactTracking(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseLocation(value: string | null) {
  const match = value?.match(/^(.+?),\s*(?:(([A-Z]{2})\s+))?(\d{5})(?:-\d{4})?$/i);
  if (!match) return { city: value?.trim() || null, state: null, zip: null };
  return {
    city: match[1]?.trim() ?? null,
    state: match[3]?.toUpperCase() ?? null,
    zip: match[4] ?? null,
  };
}

function parseFirstTrackingHistoryItem(html: string) {
  const itemMatch = html.match(/<li class=["']?history_item_container\b[\s\S]*?<\/li>/i);
  if (!itemMatch) return null;

  const spans = [...itemMatch[0].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)]
    .map((match) => stripTags(match[1] ?? ""))
    .filter(Boolean);

  const [date, time, event, location] = spans;
  if (!date || !event) return null;
  return {
    date,
    time: time ?? null,
    event,
    ...parseLocation(location ?? null),
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function unquoteShellValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readCurlHeaders(file: TrackingCheckCurlFile): BrowserHeaderSet {
  const headers: Record<string, string> = {};
  const headerPattern = /(?:-H|--header)\s+((?:"[^"]+"|'[^']+'))/g;
  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(file.text)) !== null) {
    const header = unquoteShellValue(match[1] ?? "");
    const separator = header.indexOf(":");
    if (separator <= 0) continue;
    const name = header.slice(0, separator).trim();
    const value = header.slice(separator + 1).trim();
    if (!name || !value) continue;
    if (/^(cookie|user-agent|accept|accept-language)$/i.test(name)) {
      headers[name] = value;
    }
  }

  const cookiePattern = /(?:-b|--cookie)\s+((?:"[^"]+"|'[^']+'))/;
  const cookieMatch = file.text.match(cookiePattern);
  if (cookieMatch?.[1]) {
    headers.Cookie = unquoteShellValue(cookieMatch[1]);
  }

  if (!Object.keys(headers).some((name) => /^cookie$/i.test(name))) {
    throw new Error(`${file.filename} does not contain an eBay Cookie header.`);
  }

  return { source: file.filename, headers };
}

function buildEbayConfig(integration: { config: unknown }) {
  const raw = (integration.config ?? {}) as Record<string, unknown>;
  const envPrefix = raw.environment === "PRODUCTION" || !raw.environment ? "" : "SANDBOX_";
  return {
    appId: (raw.appId as string) || "",
    certId: (raw.certId as string) || "",
    refreshToken: (raw.refreshToken as string) || "",
    accessToken: (raw[`${envPrefix}accessToken`] as string) ?? (raw.accessToken as string) ?? undefined,
    accessTokenExpiresAt: (raw.accessTokenExpiresAt as number) ?? undefined,
  };
}

async function getAccessTokenNoPersist(config: ReturnType<typeof buildEbayConfig>) {
  if (
    config.accessToken &&
    config.accessTokenExpiresAt &&
    config.accessTokenExpiresAt > Date.now() + 60_000
  ) {
    return config.accessToken;
  }

  const credentials = Buffer.from(`${config.appId}:${config.certId}`).toString("base64");
  const response = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
    }).toString(),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`eBay token refresh failed (${response.status}): ${body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(body) as { access_token?: string };
  if (!parsed.access_token) throw new Error("eBay token response did not include an access token.");
  return parsed.access_token;
}

async function getOrdersBatch(
  orderIds: string[],
  accessToken: string,
): Promise<Record<string, unknown>[]> {
  const idElements = orderIds.map((id) => `    <OrderID>${escapeXml(id)}</OrderID>`).join("\n");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderIDArray>
${idElements}
  </OrderIDArray>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;
  const response = await fetch(TRADING_API, {
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
  const xml = await response.text();
  if (!response.ok) throw new Error(`GetOrders HTTP ${response.status}: ${xml.slice(0, 200)}`);
  const parsed = parseXmlSimple(xml);
  const root = parsed.GetOrdersResponse as Record<string, unknown> | undefined;
  const ack = text(root?.Ack);
  if (ack && ack !== "Success" && ack !== "Warning") {
    throw new Error(`GetOrders Ack=${ack}`);
  }
  return asArray<Record<string, unknown>>(
    asRecord(root?.OrderArray)?.Order as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
}

function getOrderId(order: Record<string, unknown>) {
  return text(order.OrderID) ?? "";
}

function getShippingAddress(order: Record<string, unknown>) {
  const address = asRecord(order.ShippingAddress);
  return {
    city: text(address?.CityName),
    state: text(address?.StateOrProvince),
    zip: text(address?.PostalCode),
  };
}

function getFirstItemAndTransaction(order: Record<string, unknown>) {
  const transactions = asArray<Record<string, unknown>>(
    asRecord(order.TransactionArray)?.Transaction as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  for (const tx of transactions) {
    const item = asRecord(tx.Item);
    const itemId = text(item?.ItemID);
    const transactionId = text(tx.TransactionID);
    if (itemId && transactionId) return { itemId, transactionId };
  }
  return null;
}

function parseTrackingDetails(html: string): {
  status: AuditRow["trackingStatus"];
  event: string | null;
  date: string | null;
  time: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  notes: string | null;
} {
  const plain = stripTags(html);
  if (/sign in|please log in|access denied/i.test(plain) && !/shipment history/i.test(plain)) {
    return {
      status: "TRACKING_PAGE_UNAVAILABLE",
      event: null,
      date: null,
      time: null,
      city: null,
      state: null,
      zip: null,
      notes: "eBay tracking page did not expose shipment history to this browser session.",
    };
  }
  if (/something went wrong while loading this page/i.test(plain) && !/shipment history/i.test(plain)) {
    return {
      status: "TRACKING_PAGE_UNAVAILABLE",
      event: null,
      date: null,
      time: null,
      city: null,
      state: null,
      zip: null,
      notes: "eBay returned a tracking notice page instead of shipment history.",
    };
  }

  const firstHistoryItem = parseFirstTrackingHistoryItem(html);
  if (firstHistoryItem) {
    const isDelivered = /delivered/i.test(firstHistoryItem.event);
    return {
      status: isDelivered ? "DELIVERED" : "IN_TRANSIT",
      event: firstHistoryItem.event,
      date: firstHistoryItem.date,
      time: firstHistoryItem.time,
      city: firstHistoryItem.city,
      state: firstHistoryItem.state,
      zip: firstHistoryItem.zip,
      notes: null,
    };
  }

  const inTransit = /in transit|arrived|departed|out for delivery|accepted|shipping label created|processed/i.test(plain);
  return {
    status: inTransit ? "IN_TRANSIT" : "UNKNOWN",
    event: null,
    date: null,
    time: null,
    city: null,
    state: null,
    zip: null,
    notes: "Could not parse a shipment history event from eBay tracking page.",
  };
}

function compareValue(orderValue: string | null, scanValue: string | null) {
  const orderNorm = normalize(orderValue);
  const scanNorm = normalize(scanValue);
  if (!orderNorm || !scanNorm) return "UNKNOWN" as const;
  return orderNorm === scanNorm ? "MATCH" as const : "MISMATCH" as const;
}

function compareZip(orderZip: string | null, scanZip: string | null) {
  const orderZip5 = first5Zip(orderZip);
  const scanZip5 = first5Zip(scanZip);
  if (!orderZip5 || !scanZip5) return "UNKNOWN" as const;
  return orderZip5 === scanZip5 ? "MATCH" as const : "MISMATCH" as const;
}

function formatLocation(city: string | null, state: string | null, zip: string | null) {
  if (city && !state && zip) return `${city}, ${zip}`;
  const cityState = [city, state].filter(Boolean).join(", ");
  return [cityState, zip].filter(Boolean).join(" ").trim() || null;
}

function formatScanDate(date: string | null) {
  const match = date?.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})\b/);
  if (!match) return date;
  const monthMap: Record<string, number> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };
  const month = monthMap[match[1]!.toLowerCase()];
  return month ? `${month}/${Number(match[2])}` : date;
}

function formatScanTime(time: string | null) {
  return time?.replace(/\s+/g, "").toUpperCase() ?? null;
}

function formatLatestScan(row: AuditRow) {
  const location = formatLocation(row.scanCity, row.scanState, row.scanZip);
  const date = formatScanDate(row.scanDate);
  const time = formatScanTime(row.scanTime);
  return [location, date, time].filter(Boolean).join(" - ") || null;
}

async function fetchTrackingDetailsOnce(url: string, browserHeaders: Record<string, string>) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      ...browserHeaders,
    },
  });
  const html = await response.text();
  if (!response.ok) {
    return {
      status: "TRACKING_PAGE_UNAVAILABLE" as const,
      event: null,
      date: null,
      time: null,
      city: null,
      state: null,
      zip: null,
      notes: `eBay tracking page HTTP ${response.status}`,
    };
  }
  return parseTrackingDetails(html);
}

async function fetchTrackingDetails(url: string, browserHeaderSets: BrowserHeaderSet[]) {
  let lastResult: Awaited<ReturnType<typeof fetchTrackingDetailsOnce>> | null = null;
  for (const headerSet of browserHeaderSets) {
    const result = await fetchTrackingDetailsOnce(url, headerSet.headers);
    lastResult = result;
    if (result.status !== "TRACKING_PAGE_UNAVAILABLE") return result;
  }
  return lastResult ?? {
    status: "TRACKING_PAGE_UNAVAILABLE" as const,
    event: null,
    date: null,
    time: null,
    city: null,
    state: null,
    zip: null,
    notes: "No eBay tracking browser session was provided.",
  };
}

async function readSourceRows(files: TrackingCheckSourceFile[]) {
  const sourceRows: Array<{ sourceFile: string; sourceRow: number; orderId: string }> = [];
  for (const file of files) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) continue;
    const headerRow = worksheet.getRow(1);
    let orderColumn = 18;
    headerRow.eachCell((cell, colNumber) => {
      if (String(cell.text ?? "").trim().toLowerCase() === "ordernumber") {
        orderColumn = colNumber;
      }
    });
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const value = row.getCell(orderColumn).text.trim();
      if (value) sourceRows.push({ sourceFile: file.filename, sourceRow: rowNumber, orderId: value });
    });
  }
  return sourceRows;
}

function addDeliveredSheet(out: ExcelJS.Workbook, name: string, rows: AuditRow[]) {
  const sheet = out.addWorksheet(name);
  sheet.columns = [
    { header: "eBay Store", key: "store", width: 14 },
    { header: "Order Number", key: "orderId", width: 18 },
    { header: "Tracking Number", key: "trackingNumber", width: 28 },
    { header: "Ship To City, State, ZIP", key: "shipTo", width: 34 },
    { header: "Actual Delivered City, State, ZIP", key: "actualDelivered", width: 38 },
  ];
  rows.forEach((row) =>
    sheet.addRow({
      store: row.store,
      orderId: row.orderId,
      trackingNumber: row.trackingNumber,
      shipTo: formatLocation(row.orderCity, row.orderState, row.orderZip),
      actualDelivered: formatLocation(row.scanCity, row.scanState, row.scanZip),
    }),
  );
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = "A1:E1";
}

async function buildWorkbook(auditRows: AuditRow[], inputFileNames: string[]) {
  const out = new ExcelJS.Workbook();
  const deliveredMatchedRows = auditRows.filter((row) => row.trackingStatus === "DELIVERED" && row.overallMatch === "MATCH");
  const deliveredNoMatchRows = auditRows.filter((row) => row.trackingStatus === "DELIVERED" && row.overallMatch !== "MATCH");
  const inTransitRows = auditRows.filter((row) => row.trackingStatus === "IN_TRANSIT" || row.overallMatch === "NOT_DELIVERED");
  const nonEbayRows = auditRows.filter((row) => row.eBayOrder === "NO");

  addDeliveredSheet(out, "Delivered and Matched", deliveredMatchedRows);
  addDeliveredSheet(out, "Delivered No Match", deliveredNoMatchRows);

  const inTransitSheet = out.addWorksheet("In Transit");
  inTransitSheet.columns = [
    { header: "eBay Store", key: "store", width: 14 },
    { header: "Order Number", key: "orderId", width: 18 },
    { header: "Tracking Number", key: "trackingNumber", width: 28 },
    { header: "Ship To City, State, ZIP", key: "shipTo", width: 34 },
    { header: "Latest eBay Tracking Event", key: "scanEvent", width: 34 },
    { header: "Latest Scan", key: "latestScan", width: 44 },
  ];
  inTransitRows.forEach((row) =>
    inTransitSheet.addRow({
      store: row.store,
      orderId: row.orderId,
      trackingNumber: row.trackingNumber,
      shipTo: formatLocation(row.orderCity, row.orderState, row.orderZip),
      scanEvent: row.scanEvent ?? row.trackingStatus,
      latestScan: formatLatestScan(row),
    }),
  );
  inTransitSheet.views = [{ state: "frozen", ySplit: 1 }];
  inTransitSheet.autoFilter = "A1:F1";

  const nonEbaySheet = out.addWorksheet("Non eBay Orders");
  nonEbaySheet.columns = [
    { header: "Source File", key: "sourceFile", width: 36 },
    { header: "Source Row", key: "sourceRow", width: 12 },
    { header: "Order Number", key: "orderId", width: 18 },
    { header: "Notes", key: "notes", width: 70 },
  ];
  nonEbayRows.forEach((row) => nonEbaySheet.addRow(row));
  nonEbaySheet.views = [{ state: "frozen", ySplit: 1 }];
  nonEbaySheet.autoFilter = "A1:D1";

  const auditSheet = out.addWorksheet("Full Audit");
  auditSheet.columns = [
    { header: "Source File", key: "sourceFile", width: 36 },
    { header: "Source Row", key: "sourceRow", width: 12 },
    { header: "Order ID", key: "orderId", width: 18 },
    { header: "eBay Order", key: "eBayOrder", width: 12 },
    { header: "Store", key: "store", width: 14 },
    { header: "Order City", key: "orderCity", width: 18 },
    { header: "Order State", key: "orderState", width: 12 },
    { header: "Order ZIP", key: "orderZip", width: 14 },
    { header: "Tracking Number", key: "trackingNumber", width: 26 },
    { header: "Carrier", key: "trackingCarrier", width: 12 },
    { header: "Tracking Status", key: "trackingStatus", width: 22 },
    { header: "Scan Event", key: "scanEvent", width: 34 },
    { header: "Scan Date", key: "scanDate", width: 16 },
    { header: "Scan Time", key: "scanTime", width: 14 },
    { header: "Scan City", key: "scanCity", width: 30 },
    { header: "Scan State", key: "scanState", width: 12 },
    { header: "Scan ZIP", key: "scanZip", width: 12 },
    { header: "City Match", key: "cityMatch", width: 14 },
    { header: "State Match", key: "stateMatch", width: 14 },
    { header: "ZIP Match", key: "zipMatch", width: 14 },
    { header: "Overall Match", key: "overallMatch", width: 16 },
    { header: "Tracking URL", key: "trackingUrl", width: 70 },
    { header: "Notes", key: "notes", width: 60 },
  ];
  auditRows.forEach((row) => auditSheet.addRow(row));
  auditSheet.views = [{ state: "frozen", ySplit: 1 }];
  auditSheet.autoFilter = "A1:W1";

  const summarySheet = out.addWorksheet("Summary");
  [
    ["Input files", inputFileNames.join(", ")],
    ["Input rows", auditRows.length],
    ["Delivered and Matched", deliveredMatchedRows.length],
    ["Delivered No Match", deliveredNoMatchRows.length],
    ["In Transit", inTransitRows.length],
    ["Non eBay Orders", nonEbayRows.length],
    ["Needs tracking review", auditRows.filter((row) => row.eBayOrder === "YES" && row.overallMatch === "UNKNOWN").length],
  ].forEach((row) => summarySheet.addRow(row));
  summarySheet.getColumn(1).width = 28;
  summarySheet.getColumn(2).width = 110;

  return {
    workbookBuffer: Buffer.from(await out.xlsx.writeBuffer()),
    summary: {
      rows: auditRows.length,
      deliveredMatched: deliveredMatchedRows.length,
      deliveredNoMatch: deliveredNoMatchRows.length,
      inTransit: inTransitRows.length,
      nonEbay: nonEbayRows.length,
      needsReview: auditRows.filter((row) => row.eBayOrder === "YES" && row.overallMatch === "UNKNOWN").length,
    },
  };
}

export async function runTrackingCheck(input: {
  files: TrackingCheckSourceFile[];
  curlFiles: TrackingCheckCurlFile[];
}) {
  if (input.files.length === 0) throw new Error("Upload at least one .xlsx file.");
  if (input.curlFiles.length === 0) throw new Error("Upload at least one eBay tracking session .txt file.");

  const sourceRows = await readSourceRows(input.files);
  const uniqueOrderIds = [...new Set(sourceRows.map((row) => row.orderId))];
  const ebayOrderIds = uniqueOrderIds.filter((orderId) => EBAY_ORDER_ID_PATTERN.test(orderId));
  const browserHeaders = input.curlFiles.map(readCurlHeaders);

  const integrations = await db.integration.findMany({
    where: { platform: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] }, enabled: true },
    select: { platform: true, config: true },
    orderBy: { platform: "asc" },
  });

  const foundOrders = new Map<string, OrderRecord>();
  for (const integration of integrations) {
    const store = integration.platform as EbayStore;
    const missing = ebayOrderIds.filter((orderId) => !foundOrders.has(orderId));
    if (missing.length === 0) break;
    const token = await getAccessTokenNoPersist(buildEbayConfig(integration));
    for (const ids of chunk(missing, GET_ORDERS_BATCH_SIZE)) {
      const orders = await getOrdersBatch(ids, token);
      for (const order of orders) {
        const orderId = getOrderId(order);
        if (orderId && !foundOrders.has(orderId)) foundOrders.set(orderId, { store, order });
      }
    }
  }

  const trackingInputs = ebayOrderIds
    .map((orderId) => {
      const record = foundOrders.get(orderId);
      if (!record) return null;
      const tx = getFirstItemAndTransaction(record.order);
      if (!tx) return null;
      const url = `${TRACKING_DETAILS_URL}?itemid=${encodeURIComponent(tx.itemId)}&transid=${encodeURIComponent(tx.transactionId)}`;
      return { orderId, url };
    })
    .filter((item): item is { orderId: string; url: string } => Boolean(item));
  const trackingPageByOrder = new Map<string, Awaited<ReturnType<typeof fetchTrackingDetails>>>();
  await mapLimit(trackingInputs, TRACKING_FETCH_CONCURRENCY, async (item) => {
    const parsed = await fetchTrackingDetails(item.url, browserHeaders);
    trackingPageByOrder.set(item.orderId, parsed);
    return parsed;
  });

  const auditRows: AuditRow[] = sourceRows.map(({ sourceFile, sourceRow, orderId }) => {
    if (!EBAY_ORDER_ID_PATTERN.test(orderId)) {
      return {
        sourceFile,
        sourceRow,
        orderId,
        eBayOrder: "NO",
        store: "N/A",
        orderCity: null,
        orderState: null,
        orderZip: null,
        trackingNumber: null,
        trackingCarrier: null,
        trackingUrl: null,
        trackingStatus: "NOT_EBAY_ORDER",
        scanEvent: null,
        scanDate: null,
        scanTime: null,
        scanCity: null,
        scanState: null,
        scanZip: null,
        cityMatch: "N/A",
        stateMatch: "N/A",
        zipMatch: "N/A",
        overallMatch: "N/A",
        notes: "Order number does not match eBay order ID format.",
      };
    }

    const record = foundOrders.get(orderId);
    if (!record) {
      return {
        sourceFile,
        sourceRow,
        orderId,
        eBayOrder: "YES",
        store: "NOT_FOUND",
        orderCity: null,
        orderState: null,
        orderZip: null,
        trackingNumber: null,
        trackingCarrier: null,
        trackingUrl: null,
        trackingStatus: "NOT_FOUND",
        scanEvent: null,
        scanDate: null,
        scanTime: null,
        scanCity: null,
        scanState: null,
        scanZip: null,
        cityMatch: "UNKNOWN",
        stateMatch: "UNKNOWN",
        zipMatch: "UNKNOWN",
        overallMatch: "UNKNOWN",
        notes: "Order was not found in enabled TPP/TT eBay integrations.",
      };
    }

    const address = getShippingAddress(record.order);
    const tracking = extractTrackingNumbersFromOrder(record.order)[0] ?? null;
    const tx = getFirstItemAndTransaction(record.order);
    const trackingUrl = tx
      ? `${TRACKING_DETAILS_URL}?itemid=${encodeURIComponent(tx.itemId)}&transid=${encodeURIComponent(tx.transactionId)}`
      : null;
    const page = trackingPageByOrder.get(orderId);
    const status = page?.status ?? (tracking ? "UNKNOWN" : "NOT_FOUND");
    const cityMatch = status === "DELIVERED" ? compareValue(address.city, page?.city ?? null) : "N/A";
    const stateMatch = status === "DELIVERED" ? compareValue(address.state, page?.state ?? null) : "N/A";
    const zipMatch = status === "DELIVERED" ? compareZip(address.zip, page?.zip ?? null) : "N/A";
    const overallMatch = status !== "DELIVERED"
      ? status === "IN_TRANSIT" ? "NOT_DELIVERED" : "UNKNOWN"
      : cityMatch === "MATCH" && stateMatch === "MATCH" && zipMatch === "MATCH"
        ? "MATCH"
        : cityMatch === "MISMATCH" || stateMatch === "MISMATCH" || zipMatch === "MISMATCH"
          ? "MISMATCH"
          : "UNKNOWN";

    return {
      sourceFile,
      sourceRow,
      orderId,
      eBayOrder: "YES",
      store: record.store,
      orderCity: address.city,
      orderState: address.state,
      orderZip: address.zip,
      trackingNumber: tracking ? compactTracking(tracking.number) : null,
      trackingCarrier: tracking?.carrier ?? null,
      trackingUrl,
      trackingStatus: status,
      scanEvent: page?.event ?? null,
      scanDate: page?.date ?? null,
      scanTime: page?.time ?? null,
      scanCity: page?.city ?? null,
      scanState: page?.state ?? null,
      scanZip: page?.zip ?? null,
      cityMatch,
      stateMatch,
      zipMatch,
      overallMatch,
      notes: page?.notes ?? null,
    };
  });

  return buildWorkbook(auditRows, input.files.map((file) => file.filename));
}
