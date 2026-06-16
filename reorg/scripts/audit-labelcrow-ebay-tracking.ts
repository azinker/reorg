import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { Platform } from "@prisma/client";
import {
  extractTrackingNumbersFromOrder,
  parseXmlSimple,
} from "@/lib/services/auto-responder-ebay";

const args = process.argv.slice(2);
const CURL_FILES = args
  .flatMap((arg, index) => (arg === "--curl-file" && args[index + 1] ? [args[index + 1]!] : []))
  .concat(
    process.env.EBAY_TRACKING_CURL_FILE
      ? process.env.EBAY_TRACKING_CURL_FILE.split(";").map((file) => file.trim()).filter(Boolean)
      : [],
  );
const ignoredArgIndexes = new Set<number>();
args.forEach((arg, index) => {
  if (arg === "--curl-file") {
    ignoredArgIndexes.add(index);
    ignoredArgIndexes.add(index + 1);
  }
});
const INPUT_FILE =
  args.find((arg, index) => !ignoredArgIndexes.has(index) && !arg.startsWith("--")) ??
  "C:\\Users\\thepe\\Downloads\\TPP_LABELCROW_1_with_tracking.xlsx";
const REPORT_DIR = "reports";
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

type AuditRow = {
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

type BrowserHeaderSet = {
  source: string;
  headers: Record<string, string>;
};

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const body = fs.readFileSync(filePath, "utf8");
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
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

function readCurlHeaders(filePath: string | undefined): BrowserHeaderSet | null {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) throw new Error(`cURL file not found: ${filePath}`);
  const body = fs.readFileSync(filePath, "utf8");
  const headers: Record<string, string> = {};
  const headerPattern = /(?:-H|--header)\s+((?:"[^"]+"|'[^']+'))/g;
  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(body)) !== null) {
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
  const cookieMatch = body.match(cookiePattern);
  if (cookieMatch?.[1]) {
    headers.Cookie = unquoteShellValue(cookieMatch[1]);
  }

  if (!Object.keys(headers).some((name) => /^cookie$/i.test(name))) {
    throw new Error(`No Cookie header was found in cURL file: ${filePath}`);
  }

  return { source: filePath, headers };
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

function buildEbayConfig(integration: { config: unknown }) {
  const raw = (integration.config ?? {}) as Record<string, unknown>;
  const envPrefix = raw.environment === "PRODUCTION" || !raw.environment ? "" : "SANDBOX_";
  return {
    appId: (raw.appId as string) || "",
    certId: (raw.certId as string) || "",
    devId: (raw.devId as string) || "",
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
      notes: "eBay tracking page did not expose shipment history to the server.",
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
      notes: "eBay returned a tracking notice page instead of shipment history. This usually means the browser session cannot access that store/order.",
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

  const deliveredMatch = plain.match(
    /(Sat|Sun|Mon|Tue|Wed|Thu|Fri),\s+([A-Za-z]{3,9}\s+\d{1,2})\s+(\d{1,2}:\d{2}(?:am|pm))\s+(Delivered.*?)\s+([A-Z][A-Z .'-]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?/i,
  );
  if (deliveredMatch) {
    return {
      status: "DELIVERED",
      event: deliveredMatch[4]?.trim() ?? "Delivered",
      date: `${deliveredMatch[1]}, ${deliveredMatch[2]}`,
      time: deliveredMatch[3] ?? null,
      city: deliveredMatch[5]?.trim() ?? null,
      state: deliveredMatch[6] ?? null,
      zip: deliveredMatch[7] ?? null,
      notes: null,
    };
  }

  const historyMatch = plain.match(
    /(Sat|Sun|Mon|Tue|Wed|Thu|Fri),\s+([A-Za-z]{3,9}\s+\d{1,2})\s+(\d{1,2}:\d{2}(?:am|pm))\s+([^,]+?)(?:\s+([A-Z][A-Z .'-]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?)?(?=\s+(?:Sat|Sun|Mon|Tue|Wed|Thu|Fri),|\s*$)/i,
  );
  const event = historyMatch?.[4]?.trim() ?? null;
  const inTransit = /in transit|arrived|departed|out for delivery|accepted|shipping label created|processed/i.test(plain);
  return {
    status: inTransit ? "IN_TRANSIT" : "UNKNOWN",
    event,
    date: historyMatch ? `${historyMatch[1]}, ${historyMatch[2]}` : null,
    time: historyMatch?.[3] ?? null,
    city: historyMatch?.[5]?.trim() ?? null,
    state: historyMatch?.[6] ?? null,
    zip: historyMatch?.[7] ?? null,
    notes: event ? null : "Could not parse a shipment history event from eBay tracking page.",
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

const STATE_CODES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "IA", "ID",
  "IL", "IN", "KS", "KY", "LA", "MA", "MD", "ME", "MI", "MN", "MO", "MS", "MT",
  "NC", "ND", "NE", "NH", "NJ", "NM", "NV", "NY", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY", "DC", "PR",
  "GU",
] as const;

const STATE_SET = new Set<string>(STATE_CODES);

const STATE_NEIGHBORS: Record<string, string[]> = {
  AL: ["FL", "GA", "MS", "TN"], AZ: ["CA", "CO", "NM", "NV", "UT"],
  AR: ["LA", "MO", "MS", "OK", "TN", "TX"], CA: ["AZ", "NV", "OR"],
  CO: ["AZ", "KS", "NE", "NM", "OK", "UT", "WY"], CT: ["MA", "NY", "RI"],
  DC: ["MD", "VA"], DE: ["MD", "NJ", "PA"], FL: ["AL", "GA"],
  GA: ["AL", "FL", "NC", "SC", "TN"], IA: ["IL", "MN", "MO", "NE", "SD", "WI"],
  ID: ["MT", "NV", "OR", "UT", "WA", "WY"], IL: ["IA", "IN", "KY", "MO", "WI"],
  IN: ["IL", "KY", "MI", "OH"], KS: ["CO", "MO", "NE", "OK"],
  KY: ["IL", "IN", "MO", "OH", "TN", "VA", "WV"], LA: ["AR", "MS", "TX"],
  MA: ["CT", "NH", "NY", "RI", "VT"], MD: ["DC", "DE", "PA", "VA", "WV"],
  ME: ["NH"], MI: ["IN", "OH", "WI"], MN: ["IA", "ND", "SD", "WI"],
  MO: ["AR", "IA", "IL", "KS", "KY", "NE", "OK", "TN"], MS: ["AL", "AR", "LA", "TN"],
  MT: ["ID", "ND", "SD", "WY"], NC: ["GA", "SC", "TN", "VA"], ND: ["MN", "MT", "SD"],
  NE: ["CO", "IA", "KS", "MO", "SD", "WY"], NH: ["MA", "ME", "VT"],
  NJ: ["DE", "NY", "PA"], NM: ["AZ", "CO", "OK", "TX", "UT"],
  NV: ["AZ", "CA", "ID", "OR", "UT"], NY: ["CT", "MA", "NJ", "PA", "VT"],
  OH: ["IN", "KY", "MI", "PA", "WV"], OK: ["AR", "CO", "KS", "MO", "NM", "TX"],
  OR: ["CA", "ID", "NV", "WA"], PA: ["DE", "MD", "NJ", "NY", "OH", "WV"],
  RI: ["CT", "MA"], SC: ["GA", "NC"], SD: ["IA", "MN", "MT", "ND", "NE", "WY"],
  TN: ["AL", "AR", "GA", "KY", "MO", "MS", "NC", "VA"], TX: ["AR", "LA", "NM", "OK"],
  UT: ["AZ", "CO", "ID", "NM", "NV", "WY"], VA: ["DC", "KY", "MD", "NC", "TN", "WV"],
  VT: ["MA", "NH", "NY"], WA: ["ID", "OR"], WI: ["IA", "IL", "MI", "MN"],
  WV: ["KY", "MD", "OH", "PA", "VA"], WY: ["CO", "ID", "MT", "NE", "SD", "UT"],
};

const ZIP_STATE_RANGES: Array<[number, number, string]> = [
  [6, 9, "PR"], [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"],
  [50, 59, "VT"], [60, 69, "CT"], [70, 89, "NJ"], [100, 149, "NY"], [150, 196, "PA"],
  [197, 199, "DE"], [200, 205, "DC"], [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"],
  [270, 289, "NC"], [290, 299, "SC"], [300, 319, "GA"], [320, 349, "FL"], [350, 369, "AL"],
  [370, 385, "TN"], [386, 397, "MS"], [398, 399, "GA"], [400, 427, "KY"], [430, 459, "OH"],
  [460, 479, "IN"], [480, 499, "MI"], [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"],
  [570, 577, "SD"], [580, 588, "ND"], [590, 599, "MT"], [600, 629, "IL"], [630, 658, "MO"],
  [660, 679, "KS"], [680, 693, "NE"], [700, 714, "LA"], [716, 729, "AR"], [730, 749, "OK"],
  [750, 799, "TX"], [800, 816, "CO"], [820, 831, "WY"], [832, 838, "ID"], [840, 847, "UT"],
  [850, 865, "AZ"], [870, 884, "NM"], [889, 898, "NV"], [900, 961, "CA"], [967, 968, "HI"],
  [970, 979, "OR"], [980, 994, "WA"], [995, 999, "AK"],
];

function inferStateFromZip(zip: string | null) {
  const zip5 = first5Zip(zip);
  if (!zip5) return null;
  const prefix = Number(zip5.slice(0, 3));
  const range = ZIP_STATE_RANGES.find(([min, max]) => prefix >= min && prefix <= max);
  return range?.[2] ?? null;
}

function inferStateFromLocation(city: string | null, state: string | null, zip: string | null) {
  const explicit = normalize(state);
  if (explicit && STATE_SET.has(explicit)) return explicit;
  const cityText = normalize(city);
  if (cityText) {
    const token = cityText.split(" ").find((part) => STATE_SET.has(part));
    if (token) return token;
  }
  return inferStateFromZip(zip);
}

type TransitConfidence = "HIGH" | "MILD" | "WRONG" | "";

function getTransitConfidence(row: AuditRow): TransitConfidence {
  const shipState = inferStateFromLocation(row.orderCity, row.orderState, row.orderZip);
  const scanState = inferStateFromLocation(row.scanCity, row.scanState, row.scanZip);
  if (!shipState || !scanState) return "";
  if (scanState === shipState) return "HIGH";
  if (scanState === "FL" || STATE_NEIGHBORS[shipState]?.includes(scanState)) return "MILD";
  return "WRONG";
}

function styleTransitConfidenceCell(cell: ExcelJS.Cell, confidence: TransitConfidence) {
  const colors: Record<Exclude<TransitConfidence, "">, string> = {
    HIGH: "FF1F8A4C",
    MILD: "FFF2C94C",
    WRONG: "FFE5484D",
  };
  if (!confidence) return;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors[confidence] } };
  cell.font = { bold: true, color: { argb: confidence === "MILD" ? "FF111827" : "FFFFFFFF" } };
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
  const headerSets =
    browserHeaderSets.length > 0 ? browserHeaderSets : [{ source: "none", headers: {} }];
  let lastResult: Awaited<ReturnType<typeof fetchTrackingDetailsOnce>> | null = null;
  for (const headerSet of headerSets) {
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
    notes: "No eBay tracking browser session was available.",
  };
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env.prod"));
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const host = databaseUrl ? new URL(databaseUrl).host : "";
  console.log(`[guard] DATABASE_URL host: ${host}`);
  if (!host.includes("little-fire")) {
    throw new Error("Refusing to inspect production order data because DATABASE_URL is not little-fire.");
  }

  const { db } = await import("@/lib/db");
  const trackingBrowserHeaders = CURL_FILES
    .map((file) => readCurlHeaders(file))
    .filter((item): item is BrowserHeaderSet => Boolean(item));
  console.log(
    `[tracking] browser cookie files: ${trackingBrowserHeaders.length} loaded (values hidden)`,
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(INPUT_FILE);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Workbook has no worksheets.");

  const sourceRows: Array<{ sourceRow: number; orderId: string }> = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const value = row.getCell(18).text.trim();
    if (value) sourceRows.push({ sourceRow: rowNumber, orderId: value });
  });
  const uniqueOrderIds = [...new Set(sourceRows.map((row) => row.orderId))];
  const ebayOrderIds = uniqueOrderIds.filter((orderId) => EBAY_ORDER_ID_PATTERN.test(orderId));
  console.log(`[input] rows with orderNumber: ${sourceRows.length}`);
  console.log(`[input] unique order numbers: ${uniqueOrderIds.length}`);
  console.log(`[input] eBay-shaped order numbers: ${ebayOrderIds.length}`);

  const integrations = await db.integration.findMany({
    where: { platform: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] }, enabled: true },
    select: { id: true, label: true, platform: true, config: true },
    orderBy: { platform: "asc" },
  });

  const foundOrders = new Map<string, OrderRecord>();
  for (const integration of integrations) {
    const store = integration.platform as EbayStore;
    const missing = ebayOrderIds.filter((orderId) => !foundOrders.has(orderId));
    if (missing.length === 0) break;
    const config = buildEbayConfig(integration);
    const token = await getAccessTokenNoPersist(config);
    for (const ids of chunk(missing, GET_ORDERS_BATCH_SIZE)) {
      const orders = await getOrdersBatch(ids, token);
      for (const order of orders) {
        const orderId = getOrderId(order);
        if (orderId && !foundOrders.has(orderId)) foundOrders.set(orderId, { store, order });
      }
      console.log(`[ebay] ${store}: checked ${ids.length}, found ${orders.length}`);
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
  await mapLimit(trackingInputs, TRACKING_FETCH_CONCURRENCY, async (item, index) => {
    const parsed = await fetchTrackingDetails(item.url, trackingBrowserHeaders);
    trackingPageByOrder.set(item.orderId, parsed);
    if ((index + 1) % 25 === 0 || index + 1 === trackingInputs.length) {
      console.log(`[tracking] fetched ${index + 1}/${trackingInputs.length}`);
    }
    return parsed;
  });

  const auditRows: AuditRow[] = sourceRows.map(({ sourceRow, orderId }) => {
    if (!EBAY_ORDER_ID_PATTERN.test(orderId)) {
      return {
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

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const outPath = path.join(REPORT_DIR, `labelcrow-ebay-tracking-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`);
  const out = new ExcelJS.Workbook();

  const deliveredMatchedRows = auditRows.filter((row) => row.trackingStatus === "DELIVERED" && row.overallMatch === "MATCH");
  const deliveredNoMatchRows = auditRows.filter((row) => row.trackingStatus === "DELIVERED" && row.overallMatch !== "MATCH");
  const inTransitRows = auditRows.filter((row) => row.trackingStatus === "IN_TRANSIT" || row.overallMatch === "NOT_DELIVERED");
  const needsReviewRows = auditRows.filter((row) =>
    !deliveredMatchedRows.includes(row) &&
    !deliveredNoMatchRows.includes(row) &&
    !inTransitRows.includes(row)
  );

  const addDeliveredSheet = (name: string, rows: AuditRow[]) => {
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
  };

  addDeliveredSheet("Delivered and Matched", deliveredMatchedRows);
  addDeliveredSheet("Delivered No Match", deliveredNoMatchRows);

  const inTransitSheet = out.addWorksheet("In Transit");
  inTransitSheet.columns = [
    { header: "eBay Store", key: "store", width: 14 },
    { header: "Order Number", key: "orderId", width: 18 },
    { header: "Tracking Number", key: "trackingNumber", width: 28 },
    { header: "Ship To City, State, ZIP", key: "shipTo", width: 34 },
    { header: "Latest eBay Tracking Event", key: "scanEvent", width: 34 },
    { header: "Latest Scan", key: "latestScan", width: 44 },
    { header: "Transit Confidence", key: "transitConfidence", width: 18 },
  ];
  inTransitRows.forEach((row) => {
    const transitConfidence = getTransitConfidence(row);
    const sheetRow = inTransitSheet.addRow({
      store: row.store,
      orderId: row.orderId,
      trackingNumber: row.trackingNumber,
      shipTo: formatLocation(row.orderCity, row.orderState, row.orderZip),
      scanEvent: row.scanEvent ?? row.trackingStatus,
      latestScan: formatLatestScan(row),
      transitConfidence,
    });
    styleTransitConfidenceCell(sheetRow.getCell(7), transitConfidence);
  });
  inTransitSheet.views = [{ state: "frozen", ySplit: 1 }];
  inTransitSheet.autoFilter = "A1:G1";

  const needsReviewSheet = out.addWorksheet("Non eBay Orders");
  needsReviewSheet.columns = [
    { header: "Source Row", key: "sourceRow", width: 12 },
    { header: "eBay Store", key: "store", width: 14 },
    { header: "Order Number", key: "orderId", width: 18 },
    { header: "Tracking Number", key: "trackingNumber", width: 28 },
    { header: "Tracking Status", key: "trackingStatus", width: 24 },
    { header: "Notes", key: "notes", width: 70 },
  ];
  needsReviewRows.forEach((row) => needsReviewSheet.addRow(row));
  needsReviewSheet.views = [{ state: "frozen", ySplit: 1 }];
  needsReviewSheet.autoFilter = "A1:F1";

  const auditSheet = out.addWorksheet("Full Audit");
  auditSheet.columns = [
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
    { header: "Scan Event", key: "scanEvent", width: 28 },
    { header: "Scan Date", key: "scanDate", width: 16 },
    { header: "Scan Time", key: "scanTime", width: 14 },
    { header: "Scan City", key: "scanCity", width: 18 },
    { header: "Scan State", key: "scanState", width: 12 },
    { header: "Scan ZIP", key: "scanZip", width: 12 },
    { header: "City Match", key: "cityMatch", width: 14 },
    { header: "State Match", key: "stateMatch", width: 14 },
    { header: "ZIP Match", key: "zipMatch", width: 14 },
    { header: "Overall Match", key: "overallMatch", width: 16 },
    { header: "Tracking URL", key: "trackingUrl", width: 70 },
    { header: "Notes", key: "notes", width: 50 },
  ];
  auditRows.forEach((row) => auditSheet.addRow(row));
  auditSheet.views = [{ state: "frozen", ySplit: 1 }];
  auditSheet.autoFilter = "A1:V1";

  const summarySheet = out.addWorksheet("Summary");
  const summary = [
    ["Input file", INPUT_FILE],
    ["Rows with orderNumber", sourceRows.length],
    ["Unique order numbers", uniqueOrderIds.length],
    ["eBay-shaped order numbers", ebayOrderIds.length],
    ["Found in TPP/TT eBay", foundOrders.size],
    ["Delivered and Matched sheet rows", deliveredMatchedRows.length],
    ["Delivered No Match sheet rows", deliveredNoMatchRows.length],
    ["In Transit sheet rows", inTransitRows.length],
    ["Needs Review sheet rows", needsReviewRows.length],
  ];
  summary.forEach((row) => summarySheet.addRow(row));
  summarySheet.getColumn(1).width = 28;
  summarySheet.getColumn(2).width = 90;

  await out.xlsx.writeFile(outPath);
  console.log(`[output] ${outPath}`);
  console.log(JSON.stringify({
    rows: sourceRows.length,
    unique: uniqueOrderIds.length,
    ebayShaped: ebayOrderIds.length,
    found: foundOrders.size,
    match: auditRows.filter((row) => row.overallMatch === "MATCH").length,
    mismatch: auditRows.filter((row) => row.overallMatch === "MISMATCH").length,
    notDelivered: auditRows.filter((row) => row.overallMatch === "NOT_DELIVERED").length,
    unknown: auditRows.filter((row) => row.overallMatch === "UNKNOWN").length,
  }, null, 2));
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
