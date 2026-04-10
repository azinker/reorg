/**
 * Ship Orders service — identifies which marketplace each order belongs to,
 * then marks them shipped with a tracking number and verifies the result.
 *
 * SAFETY: All writes pass through checkWriteSafety per integration.
 * SAFETY: Audit log entry created per fulfilled order.
 *
 * Scale notes:
 *  - eBay identification uses batched GetOrders (20 per call) so 900 eBay orders
 *    = ~45 API calls instead of 900.
 *  - CompleteSale runs at EXECUTE_CONCURRENCY concurrent calls.
 *  - Post-ship verification uses batched GetOrders to confirm tracking on the order.
 */

import { XMLParser } from "fast-xml-parser";
import { createHash, createHmac } from "crypto";
import { db } from "@/lib/db";
import { checkWriteSafety } from "@/lib/safety";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";
import type { Platform } from "@prisma/client";

// ─── Constants ────────────────────────────────────────────────────────────────

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const REQUEST_TIMEOUT_MS = 30_000;
const CARRIER = "USPS";

/** Max eBay order IDs per single GetOrders call. */
const EBAY_IDENTIFY_BATCH_SIZE = 20;
/** Max eBay order IDs per GetOrders verification call. */
const EBAY_VERIFY_BATCH_SIZE = 20;
/** Concurrent CompleteSale / shipment API calls during execute phase (eBay + BC). */
const EXECUTE_CONCURRENCY = 20;
/** Concurrent GetOrders batches during identify and verify phases. */
const IDENTIFY_CONCURRENCY = 10;
/** Shopify allows 2 calls/second sustained (leaky bucket 40). Keep concurrency low. */
const SHOPIFY_CONCURRENCY = 2;
/** Max Shopify 429 retries before giving up. */
const SHOPIFY_MAX_RETRIES = 5;
/** Max Amazon SP-API 429 retries (rate limit: 0.5 req/sec, burst 30). */
const AMAZON_MAX_RETRIES = 8;
/** Amazon identify concurrency — kept low to respect 0.5 req/sec rate limit. */
const AMAZON_CONCURRENCY = 1;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  isArray: (tagName) => ["Order", "Transaction", "ShipmentTrackingDetails", "Errors", "Error"].includes(tagName),
});

// ─── Types ────────────────────────────────────────────────────────────────────

export type ParsedLine = {
  orderNumber: string;
  trackingNumber: string;
};

export type IdentifiedOrder = {
  orderNumber: string;
  trackingNumber: string;
  platform: Platform;
  integrationId: string;
  /** Resolved API-level order ID (may differ from user-facing number for Shopify) */
  platformOrderId: string;
  /** For BC: cached products needed for shipment creation */
  bcProducts?: BcOrderProduct[];
  /** For BC: cached shipping address id */
  bcAddressId?: number;
  /** For Amazon: order items needed for confirmShipment */
  amazonOrderItems?: AmazonOrderItem[];
  /** For Amazon: marketplace ID (e.g. ATVPDKIKX0DER for US) */
  amazonMarketplaceId?: string;
  status: "found";
};

export type UnidentifiedOrder = {
  orderNumber: string;
  trackingNumber: string;
  status: "not_found" | "ambiguous" | "error";
  error?: string;
};

export type IdentifyResult = IdentifiedOrder | UnidentifiedOrder;

export type ShipResult = {
  orderNumber: string;
  trackingNumber: string;
  platform: Platform | null;
  success: boolean;
  error?: string;
  /** Non-fatal eBay warning messages returned alongside Ack=Warning (e.g. "tracking number invalid format"). */
  ebayWarnings?: string[];
  /** Tracking number confirmed on the marketplace after shipping (may differ if eBay silently ignores update). */
  verifiedTrackingNumber?: string | null;
  /** "verified" | "mismatch" | "unverified" */
  verificationStatus?: "verified" | "mismatch" | "unverified";
};

interface BcOrderProduct {
  order_product_id: number;
  quantity: number;
}

interface AmazonOrderItem {
  orderItemId: string;
  quantity: number;
}

interface EbayConfig {
  appId: string;
  certId: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
}

interface AmazonConfig {
  refreshToken: string;
  sellerId?: string | null;
}

// ─── Low-level helpers ────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Shopify-specific fetch that retries on 429 (rate limit) using the
 * Retry-After header value (or a default back-off).
 */
async function shopifyFetch(
  url: string,
  options: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  let attempt = 0;
  while (true) {
    const res = await fetchWithTimeout(url, options);
    if (res.status !== 429 || attempt >= SHOPIFY_MAX_RETRIES) return res;

    // Parse Retry-After (seconds) from body or use exponential backoff
    let waitMs = Math.min(1000 * 2 ** attempt, 16_000);
    try {
      const parsed = JSON.parse(res.body) as { retry_after?: number };
      if (typeof parsed.retry_after === "number") waitMs = parsed.retry_after * 1000;
    } catch { /* use default */ }

    await new Promise((r) => setTimeout(r, waitMs));
    attempt++;
  }
}

async function runConcurrently<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn));
  }
}

async function getEbayAccessToken(
  integrationId: string,
  config: EbayConfig,
): Promise<string> {
  if (
    config.accessToken &&
    config.accessTokenExpiresAt &&
    config.accessTokenExpiresAt > Date.now() + 60_000
  ) {
    return config.accessToken;
  }

  const credentials = Buffer.from(`${config.appId}:${config.certId}`).toString("base64");
  const res = await fetchWithTimeout("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
    }),
  });

  if (!res.ok) throw new Error(`eBay token refresh failed: ${res.status}`);

  const data = JSON.parse(res.body) as Record<string, unknown>;
  const accessToken = data.access_token as string;
  const expiresIn = (data.expires_in as number | undefined) ?? 7200;
  const expiresAt = Date.now() + expiresIn * 1000;

  const current = await db.integration.findUnique({
    where: { id: integrationId },
    select: { config: true },
  });
  const fullConfig =
    current?.config && typeof current.config === "object" && !Array.isArray(current.config)
      ? (current.config as Record<string, unknown>)
      : {};
  await db.integration.update({
    where: { id: integrationId },
    data: { config: { ...fullConfig, accessToken, accessTokenExpiresAt: expiresAt } as object },
  });

  config.accessToken = accessToken;
  config.accessTokenExpiresAt = expiresAt;
  return accessToken;
}

function buildEbayConfig(config: Record<string, unknown>): EbayConfig {
  return {
    appId: config.appId as string,
    certId: config.certId as string,
    refreshToken: config.refreshToken as string,
    accessToken: config.accessToken as string | undefined,
    accessTokenExpiresAt: config.accessTokenExpiresAt as number | undefined,
  };
}

// ─── Amazon SP-API ────────────────────────────────────────────────────────────

const SP_API_HOST = "sellingpartnerapi-na.amazon.com";
const SP_API_REGION = "us-east-1";
const SP_API_SERVICE = "execute-api";
const AMAZON_LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const AMAZON_MARKETPLACE_ID_US = "ATVPDKIKX0DER";

/** In-memory cache for LWA access tokens (per refreshToken). */
const amazonTokenCache = new Map<string, { token: string; expiresAt: number }>();

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Sign an SP-API request with AWS Signature V4.
 * Returns a headers object to merge into the fetch call.
 */
function awsSign(opts: {
  method: string;
  path: string;
  query: string;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Record<string, string> {
  const { method, path, query, body, accessKeyId, secretAccessKey } = opts;

  const now = new Date();
  const amzDate =
    now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "") + "";
  // amzDate is like "20260405T123456Z" after removing dashes/colons
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = sha256Hex(body);

  const canonHeaders: Record<string, string> = {
    host: SP_API_HOST,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const sortedKeys = Object.keys(canonHeaders).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${canonHeaders[k]}`).join("\n") + "\n";
  const signedHeaders = sortedKeys.join(";");

  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const credentialScope = `${dateStamp}/${SP_API_REGION}/${SP_API_SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmacSha256(
    hmacSha256(
      hmacSha256(hmacSha256(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), dateStamp), SP_API_REGION),
      SP_API_SERVICE,
    ),
    "aws4_request",
  );

  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    ...canonHeaders,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Get a short-lived LWA access token using the stored refresh token. */
async function getAmazonLwaToken(refreshToken: string): Promise<string> {
  const cached = amazonTokenCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const clientId = process.env.AMAZON_LWA_CLIENT_ID;
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Amazon LWA credentials not configured (AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET)");
  }

  const res = await fetchWithTimeout(AMAZON_LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) throw new Error(`Amazon LWA token refresh failed: ${res.status} ${res.body}`);

  const data = JSON.parse(res.body) as { access_token: string; expires_in: number };
  amazonTokenCache.set(refreshToken, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

/**
 * Call the SP-API with AWS Signature V4 + LWA token.
 */
/**
 * Call the SP-API with AWS Signature V4 + LWA token.
 * Retries automatically on 429 (rate limit) with exponential back-off.
 * NOTE: AWS Sig V4 must be recomputed on every retry because x-amz-date changes.
 */
async function spApiRequest(opts: {
  method: string;
  path: string;
  query?: string;
  body?: string;
  lwaToken: string;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const { method, path, query = "", body = "", lwaToken } = opts;
  const awsAccessKeyId = process.env.AMAZON_AWS_ACCESS_KEY_ID;
  const awsSecretAccessKey = process.env.AMAZON_AWS_SECRET_ACCESS_KEY;
  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error("Amazon AWS credentials not configured (AMAZON_AWS_ACCESS_KEY_ID / AMAZON_AWS_SECRET_ACCESS_KEY)");
  }

  const url = `https://${SP_API_HOST}${path}${query ? `?${query}` : ""}`;
  let attempt = 0;

  while (true) {
    // Recompute Sig V4 on every attempt — x-amz-date must match the actual send time
    const awsHeaders = awsSign({ method, path, query, body, accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey });

    const res = await fetchWithTimeout(url, {
      method,
      headers: {
        ...awsHeaders,
        "x-amz-access-token": lwaToken,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body || undefined,
    });

    if (res.status !== 429 || attempt >= AMAZON_MAX_RETRIES) return res;

    // Back off: respect Retry-After header or use exponential delay (2s, 4s, 8s…)
    let waitMs = Math.min(2000 * 2 ** attempt, 30_000);
    try {
      const parsed = JSON.parse(res.body) as { retryAfter?: number };
      if (typeof parsed.retryAfter === "number") waitMs = parsed.retryAfter * 1000;
    } catch { /* use default */ }

    await new Promise((r) => setTimeout(r, waitMs));
    attempt++;
  }
}

interface AmazonIdentifyResult {
  found: boolean;
  orderId?: string;
  marketplaceId?: string;
  orderItems?: AmazonOrderItem[];
  error?: string;
}

async function identifyAmazonOrder(
  refreshToken: string,
  orderNumber: string,
): Promise<AmazonIdentifyResult> {
  const lwaToken = await getAmazonLwaToken(refreshToken);

  // Use the single-order endpoint — no date filter required
  const ordersRes = await spApiRequest({
    method: "GET",
    path: `/orders/v0/orders/${orderNumber}`,
    lwaToken,
  });

  if (!ordersRes.ok) {
    return { found: false, error: `Amazon getOrder API error (${ordersRes.status}): ${ordersRes.body}` };
  }

  const ordersData = JSON.parse(ordersRes.body) as {
    payload?: { AmazonOrderId: string; OrderStatus: string; MarketplaceId: string };
  };

  const matched = ordersData.payload;
  if (!matched || matched.AmazonOrderId !== orderNumber) {
    return { found: false, error: `Order not found in Amazon account. API returned: ${ordersRes.body.slice(0, 300)}` };
  }

  const awaitingStatuses = new Set(["Unshipped", "PartiallyShipped"]);
  if (!awaitingStatuses.has(matched.OrderStatus)) {
    return { found: false, error: `Amazon order ${orderNumber} status is "${matched.OrderStatus}" (not awaiting shipment)` };
  }

  // Fetch order items (needed for confirmShipment)
  const itemsRes = await spApiRequest({
    method: "GET",
    path: `/orders/v0/orders/${orderNumber}/orderItems`,
    lwaToken,
  });

  if (!itemsRes.ok) {
    return { found: false, error: `Amazon orderItems API error (${itemsRes.status}): ${itemsRes.body}` };
  }

  const itemsData = JSON.parse(itemsRes.body) as {
    payload?: { OrderItems?: Array<{ OrderItemId: string; QuantityOrdered: number }> };
  };

  const orderItems: AmazonOrderItem[] = (itemsData.payload?.OrderItems ?? []).map((item) => ({
    orderItemId: item.OrderItemId,
    quantity: item.QuantityOrdered,
  }));

  return {
    found: true,
    orderId: matched.AmazonOrderId,
    marketplaceId: matched.MarketplaceId || AMAZON_MARKETPLACE_ID_US,
    orderItems,
  };
}

async function shipAmazon(
  refreshToken: string,
  orderId: string,
  trackingNumber: string,
  marketplaceId: string,
  orderItems: AmazonOrderItem[],
): Promise<void> {
  const lwaToken = await getAmazonLwaToken(refreshToken);

  const body = JSON.stringify({
    marketplaceId,
    packageDetail: {
      packageReferenceId: "1",
      carrierCode: CARRIER,
      shippingMethod: "Ground",
      trackingNumber,
      shipDate: new Date().toISOString(),
      orderItems: orderItems.map((item) => ({
        orderItemId: item.orderItemId,
        quantity: item.quantity,
      })),
    },
  });

  const res = await spApiRequest({
    method: "POST",
    path: `/orders/v0/orders/${orderId}/shipmentConfirmation`,
    body,
    lwaToken,
  });

  if (!res.ok) {
    let detail = res.body;
    try {
      const parsed = JSON.parse(res.body) as { errors?: Array<{ message?: string; code?: string }> };
      if (parsed.errors?.length) {
        detail = parsed.errors.map((e) => `${e.code ? `[${e.code}] ` : ""}${e.message ?? ""}`).join("; ");
      }
    } catch { /* use raw */ }
    throw new Error(`Amazon confirmShipment failed (${res.status}): ${detail}`);
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/** eBay order numbers look like: `01-14458-12363` */
const EBAY_ORDER_REGEX = /^\d{2}-\d{5}-\d{5}$/;

/** Amazon order numbers look like: `114-3941689-8772232` */
const AMAZON_ORDER_REGEX = /^\d{3}-\d{7}-\d{7}$/;

export function parseInputLines(raw: string): ParsedLine[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      // Split on any whitespace (single space, tab, multiple spaces) —
      // order numbers and tracking numbers never contain spaces themselves.
      const parts = line.split(/\s+/).filter(Boolean);
      if (parts.length < 2) return [];
      const orderNumber = parts[0]!;
      const trackingNumber = parts[1]!;
      return orderNumber && trackingNumber ? [{ orderNumber, trackingNumber }] : [];
    });
}

// ─── eBay batched GetOrders ───────────────────────────────────────────────────

/**
 * Call GetOrders with up to batchSize orderIDs at once.
 * Returns Map of userInputId → apiOrderId (the exact OrderID eBay returns,
 * which may be in extended format like "13-14447-09753!9876543210").
 * Using the API-returned ID for CompleteSale is more reliable than the user-typed format.
 */
async function ebayGetOrdersBatch(
  integrationId: string,
  config: EbayConfig,
  orderIds: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (orderIds.length === 0) return found;

  const accessToken = await getEbayAccessToken(integrationId, config);
  const idElements = orderIds.map((id) => `    <OrderID>${id}</OrderID>`).join("\n");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderIDArray>
${idElements}
  </OrderIDArray>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;

  const res = await fetchWithTimeout(TRADING_API, {
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

  if (!res.ok) return found;

  const parsed = parser.parse(res.body) as Record<string, unknown>;
  const root = parsed.GetOrdersResponse as Record<string, unknown> | undefined;
  const orderArray = root?.OrderArray as Record<string, unknown> | undefined;
  const orders = orderArray?.Order as Array<Record<string, unknown>> | undefined;
  if (!orders) return found;

  for (const order of orders) {
    const apiId = order.OrderID;
    if (typeof apiId !== "string" || !apiId.trim()) continue;
    const normalized = apiId.trim();

    // Match the returned API ID back to one of the user-typed IDs we sent.
    // The API may return "13-14447-09753!9876543210" for input "13-14447-09753".
    const userInputId = orderIds.find(
      (input) => normalized === input || normalized.startsWith(`${input}!`),
    );
    if (userInputId) {
      found.set(userInputId, normalized);
    }
  }
  return found;
}

/** Batch-identify which eBay account (TPP or TT) owns each order ID. */
async function identifyEbayOrders(
  orderIds: string[],
  tpp: { id: string; config: EbayConfig } | null,
  tt: { id: string; config: EbayConfig } | null,
): Promise<Map<string, { platform: "TPP_EBAY" | "TT_EBAY"; integrationId: string; apiOrderId: string }>> {
  const result = new Map<string, { platform: "TPP_EBAY" | "TT_EBAY"; integrationId: string; apiOrderId: string }>();
  if (orderIds.length === 0) return result;

  const batches: string[][] = [];
  for (let i = 0; i < orderIds.length; i += EBAY_IDENTIFY_BATCH_SIZE) {
    batches.push(orderIds.slice(i, i + EBAY_IDENTIFY_BATCH_SIZE));
  }

  const tppResults: Array<Map<string, string>> = [];
  const ttResults: Array<Map<string, string>> = [];

  await runConcurrently(batches, IDENTIFY_CONCURRENCY, async (batch) => {
    const [tppFound, ttFound] = await Promise.all([
      tpp ? ebayGetOrdersBatch(tpp.id, tpp.config, batch) : Promise.resolve(new Map<string, string>()),
      tt ? ebayGetOrdersBatch(tt.id, tt.config, batch) : Promise.resolve(new Map<string, string>()),
    ]);
    tppResults.push(tppFound);
    ttResults.push(ttFound);
  });

  const allTpp = new Map<string, string>();
  const allTt = new Map<string, string>();
  tppResults.forEach((m) => m.forEach((apiId, userInputId) => allTpp.set(userInputId, apiId)));
  ttResults.forEach((m) => m.forEach((apiId, userInputId) => allTt.set(userInputId, apiId)));

  for (const id of orderIds) {
    const inTpp = allTpp.has(id);
    const inTt = allTt.has(id);
    if (inTpp && !inTt && tpp) {
      result.set(id, { platform: "TPP_EBAY", integrationId: tpp.id, apiOrderId: allTpp.get(id)! });
    } else if (inTt && !inTpp && tt) {
      result.set(id, { platform: "TT_EBAY", integrationId: tt.id, apiOrderId: allTt.get(id)! });
    }
    // ambiguous (both) or not found — handled downstream
  }
  return result;
}

// ─── BigCommerce identification ───────────────────────────────────────────────

interface BcOrderResult {
  found: boolean;
  products: BcOrderProduct[];
  addressId: number | null;
}

async function queryBcOrder(
  storeHash: string,
  accessToken: string,
  orderId: string,
): Promise<BcOrderResult> {
  const numId = Number(orderId);
  if (!Number.isFinite(numId) || numId <= 0) return { found: false, products: [], addressId: null };

  const [orderRes, addrRes, prodRes] = await Promise.all([
    fetchWithTimeout(`https://api.bigcommerce.com/stores/${storeHash}/v2/orders/${numId}`, {
      headers: { "X-Auth-Token": accessToken, Accept: "application/json" },
    }),
    fetchWithTimeout(`https://api.bigcommerce.com/stores/${storeHash}/v2/orders/${numId}/shipping_addresses`, {
      headers: { "X-Auth-Token": accessToken, Accept: "application/json" },
    }),
    fetchWithTimeout(`https://api.bigcommerce.com/stores/${storeHash}/v2/orders/${numId}/products`, {
      headers: { "X-Auth-Token": accessToken, Accept: "application/json" },
    }),
  ]);

  if (!orderRes.ok) return { found: false, products: [], addressId: null };

  const addrData = addrRes.ok ? (JSON.parse(addrRes.body) as Array<Record<string, unknown>>) : [];
  const addressId = addrData.length > 0 ? (Number(addrData[0]!.id) || null) : null;
  const prodData = prodRes.ok ? (JSON.parse(prodRes.body) as Array<Record<string, unknown>>) : [];
  const products: BcOrderProduct[] = prodData.map((p) => ({
    order_product_id: Number(p.id),
    quantity: Number(p.quantity),
  }));

  return { found: true, products, addressId };
}

// ─── Shopify identification ───────────────────────────────────────────────────

async function queryShopifyOrder(
  storeDomain: string,
  accessToken: string,
  apiVersion: string,
  orderNumber: string,
): Promise<{ found: boolean; platformOrderId: string | null }> {
  const res = await shopifyFetch(
    `https://${storeDomain}/admin/api/${apiVersion}/orders.json?name=%23${encodeURIComponent(orderNumber)}&status=any&limit=5`,
    { headers: { "X-Shopify-Access-Token": accessToken, Accept: "application/json" } },
  );
  if (!res.ok) return { found: false, platformOrderId: null };
  const data = JSON.parse(res.body) as { orders?: Array<Record<string, unknown>> };
  const orders = data.orders ?? [];
  if (orders.length === 0) return { found: false, platformOrderId: null };
  return { found: true, platformOrderId: String(orders[0]!.id ?? "") };
}

// ─── identifyOrders ───────────────────────────────────────────────────────────

export async function identifyOrders(lines: ParsedLine[]): Promise<IdentifyResult[]> {
  if (lines.length === 0) return [];

  const integrations = await db.integration.findMany({
    where: { platform: { in: ["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY", "AMAZON"] }, enabled: true },
    select: { id: true, platform: true, config: true },
  });
  const byPlatform = new Map(integrations.map((i) => [i.platform, i]));

  const tppRow = byPlatform.get("TPP_EBAY");
  const ttRow = byPlatform.get("TT_EBAY");
  const bcRow = byPlatform.get("BIGCOMMERCE");
  const shopifyRow = byPlatform.get("SHOPIFY");
  const amazonRow = byPlatform.get("AMAZON");

  const tpp = tppRow ? { id: tppRow.id, config: buildEbayConfig(tppRow.config as Record<string, unknown>) } : null;
  const tt = ttRow ? { id: ttRow.id, config: buildEbayConfig(ttRow.config as Record<string, unknown>) } : null;

  // Separate eBay vs Amazon vs numeric lines
  const ebayLines = lines.filter((l) => EBAY_ORDER_REGEX.test(l.orderNumber));
  const amazonLines = lines.filter((l) => AMAZON_ORDER_REGEX.test(l.orderNumber));
  const numericLines = lines.filter(
    (l) => !EBAY_ORDER_REGEX.test(l.orderNumber) && !AMAZON_ORDER_REGEX.test(l.orderNumber),
  );

  // Batch-identify all eBay orders in parallel
  const ebayOrderIds = [...new Set(ebayLines.map((l) => l.orderNumber))];
  const ebayPlatformMap = await identifyEbayOrders(ebayOrderIds, tpp, tt);

  // Identify Amazon orders
  const amazonResultMap = new Map<string, IdentifyResult>();
  if (amazonRow && amazonLines.length > 0) {
    const amazonCfg = amazonRow.config as Record<string, unknown>;
    const refreshToken = amazonCfg.refreshToken as string | undefined;
    if (refreshToken) {
      await runConcurrently(amazonLines, AMAZON_CONCURRENCY, async (line) => {
        const { orderNumber, trackingNumber } = line;
        try {
          const result = await identifyAmazonOrder(refreshToken, orderNumber);
          if (result.found && result.orderId) {
            amazonResultMap.set(orderNumber, {
              orderNumber,
              trackingNumber,
              platform: "AMAZON",
              integrationId: amazonRow.id,
              platformOrderId: result.orderId,
              amazonOrderItems: result.orderItems,
              amazonMarketplaceId: result.marketplaceId,
              status: "found",
            });
          } else {
            // Use "error" status (not "not_found") when Amazon gave a specific reason,
            // so the UI surfaces the message instead of the generic "Not found on any store"
            amazonResultMap.set(orderNumber, {
              orderNumber,
              trackingNumber,
              status: result.error ? "error" : "not_found",
              error: result.error,
            });
          }
        } catch (err) {
          amazonResultMap.set(orderNumber, {
            orderNumber,
            trackingNumber,
            status: "error",
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });
    } else {
      for (const line of amazonLines) {
        amazonResultMap.set(line.orderNumber, {
          orderNumber: line.orderNumber,
          trackingNumber: line.trackingNumber,
          status: "error",
          error: "Amazon integration not connected (no refresh token).",
        });
      }
    }
  } else if (amazonLines.length > 0) {
    for (const line of amazonLines) {
      amazonResultMap.set(line.orderNumber, {
        orderNumber: line.orderNumber,
        trackingNumber: line.trackingNumber,
        status: "not_found",
        error: "Amazon integration not enabled.",
      });
    }
  }

  // Identify numeric (BC / Shopify) — Shopify rate limit applies here too,
  // so cap to SHOPIFY_CONCURRENCY even though BC is faster.
  const numericResultMap = new Map<string, IdentifyResult>();
  await runConcurrently(numericLines, SHOPIFY_CONCURRENCY, async (line) => {
    const { orderNumber, trackingNumber } = line;
    try {
      const [bcResult, shopifyResult] = await Promise.all([
        bcRow
          ? queryBcOrder(
              (bcRow.config as Record<string, unknown>).storeHash as string,
              (bcRow.config as Record<string, unknown>).accessToken as string,
              orderNumber,
            )
          : Promise.resolve({ found: false, products: [], addressId: null }),
        shopifyRow
          ? queryShopifyOrder(
              (shopifyRow.config as Record<string, unknown>).storeDomain as string,
              (shopifyRow.config as Record<string, unknown>).accessToken as string,
              ((shopifyRow.config as Record<string, unknown>).apiVersion as string) || "2026-01",
              orderNumber,
            )
          : Promise.resolve({ found: false, platformOrderId: null }),
      ]);

      const matches: IdentifiedOrder[] = [];
      if (bcResult.found && bcRow) {
        matches.push({
          orderNumber,
          trackingNumber,
          platform: "BIGCOMMERCE",
          integrationId: bcRow.id,
          platformOrderId: orderNumber,
          bcProducts: bcResult.products,
          bcAddressId: bcResult.addressId ?? undefined,
          status: "found",
        });
      }
      if (shopifyResult.found && shopifyRow && shopifyResult.platformOrderId) {
        matches.push({
          orderNumber,
          trackingNumber,
          platform: "SHOPIFY",
          integrationId: shopifyRow.id,
          platformOrderId: shopifyResult.platformOrderId,
          status: "found",
        });
      }

      if (matches.length === 1) {
        numericResultMap.set(orderNumber, matches[0]!);
      } else if (matches.length > 1) {
        numericResultMap.set(orderNumber, {
          orderNumber,
          trackingNumber,
          status: "ambiguous",
          error: "Order found on both BigCommerce and Shopify.",
        });
      } else {
        numericResultMap.set(orderNumber, { orderNumber, trackingNumber, status: "not_found" });
      }
    } catch (err) {
      numericResultMap.set(orderNumber, {
        orderNumber,
        trackingNumber,
        status: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  // Build results in original order
  return lines.map((line) => {
    const { orderNumber, trackingNumber } = line;

    if (EBAY_ORDER_REGEX.test(orderNumber)) {
      const match = ebayPlatformMap.get(orderNumber);
      if (!match) {
        return { orderNumber, trackingNumber, status: "not_found" as const };
      }
      return {
        orderNumber,
        trackingNumber,
        platform: match.platform as Platform,
        integrationId: match.integrationId,
        // Use the API-returned order ID (may be extended format) for CompleteSale reliability
        platformOrderId: match.apiOrderId,
        status: "found" as const,
      };
    }

    if (AMAZON_ORDER_REGEX.test(orderNumber)) {
      return (
        amazonResultMap.get(orderNumber) ?? {
          orderNumber,
          trackingNumber,
          status: "not_found" as const,
        }
      );
    }

    return (
      numericResultMap.get(orderNumber) ?? {
        orderNumber,
        trackingNumber,
        status: "not_found" as const,
      }
    );
  });
}

// ─── eBay verification (batched GetOrders after shipping) ─────────────────────

/** Pull a tracking number out of a ShipmentTrackingDetails value (array or single object). */
function trackingFromDetails(raw: unknown): string | null {
  if (!raw) return null;
  const arr = Array.isArray(raw) ? raw : [raw];
  for (const td of arr as Array<Record<string, unknown>>) {
    const num = td.ShipmentTrackingNumber;
    if (typeof num === "string" && num.trim()) return num.trim();
    // Sometimes the number is nested one level deeper
    if (num && typeof num === "object") {
      const inner = (num as Record<string, unknown>)["#text"] ?? (num as Record<string, unknown>).value;
      if (typeof inner === "string" && inner.trim()) return inner.trim();
    }
  }
  return null;
}

/**
 * Extract the tracking number from a parsed eBay GetOrders Order object.
 * eBay stores tracking in several locations depending on order age and type;
 * we check all known paths.
 */
function extractEbayTrackingFromOrder(order: Record<string, unknown>): string | null {
  // 1. Order-level ShippingDetails
  const sd = order.ShippingDetails as Record<string, unknown> | undefined;
  if (sd) {
    const t = trackingFromDetails(sd.ShipmentTrackingDetails);
    if (t) return t;
  }

  const ta = order.TransactionArray as Record<string, unknown> | undefined;
  const transactions = ta?.Transaction as Array<Record<string, unknown>> | undefined;
  if (transactions) {
    for (const tx of transactions) {
      // 2. Transaction.Shipment.ShipmentTrackingDetails  (set by CompleteSale with <Shipment>)
      const shipment = tx.Shipment as Record<string, unknown> | undefined;
      if (shipment) {
        const t = trackingFromDetails(shipment.ShipmentTrackingDetails);
        if (t) return t;
      }

      // 3. Transaction.ShippingDetails.ShipmentTrackingDetails
      const txSd = tx.ShippingDetails as Record<string, unknown> | undefined;
      if (txSd) {
        const t = trackingFromDetails(txSd.ShipmentTrackingDetails);
        if (t) return t;
      }
    }
  }

  return null;
}

/** Fetch tracking numbers for a batch of eBay order IDs. Returns Map of orderId → tracking. */
async function ebayVerifyBatch(
  integrationId: string,
  config: EbayConfig,
  orderIds: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (orderIds.length === 0) return result;

  const accessToken = await getEbayAccessToken(integrationId, config);
  const idElements = orderIds.map((id) => `    <OrderID>${id}</OrderID>`).join("\n");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderIDArray>
${idElements}
  </OrderIDArray>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;

  const res = await fetchWithTimeout(TRADING_API, {
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

  if (!res.ok) {
    for (const id of orderIds) result.set(id, null);
    return result;
  }

  const parsed = parser.parse(res.body) as Record<string, unknown>;
  const root = parsed.GetOrdersResponse as Record<string, unknown> | undefined;
  const orderArray = root?.OrderArray as Record<string, unknown> | undefined;
  const orders = orderArray?.Order as Array<Record<string, unknown>> | undefined;

  if (orders) {
    for (const order of orders) {
      const id = order.OrderID;
      if (typeof id === "string" && id.trim()) {
        result.set(id.trim(), extractEbayTrackingFromOrder(order));
      }
    }
  }
  // Orders not returned by eBay get null
  for (const id of orderIds) {
    if (!result.has(id)) result.set(id, null);
  }
  return result;
}

/** Verify tracking for a list of successfully shipped eBay orders.
 *  Uses platformOrderId (the API-returned ID) for the GetOrders query,
 *  and maps results back by orderNumber for the caller. */
async function verifyEbayShipments(
  orders: Array<{ orderNumber: string; trackingNumber: string; integrationId: string; platformOrderId: string }>,
  configByIntegrationId: Map<string, EbayConfig>,
): Promise<Map<string, string | null>> {
  // Group by integration ID; track apiId → orderNumber mapping
  const byIntegration = new Map<string, Array<{ apiId: string; orderNumber: string }>>();
  for (const o of orders) {
    const existing = byIntegration.get(o.integrationId) ?? [];
    existing.push({ apiId: o.platformOrderId, orderNumber: o.orderNumber });
    byIntegration.set(o.integrationId, existing);
  }

  // Result keyed by user-facing orderNumber
  const combined = new Map<string, string | null>();

  for (const [integrationId, entries] of byIntegration) {
    const config = configByIntegrationId.get(integrationId);
    if (!config) continue;

    const apiIds = entries.map((e) => e.apiId);
    const apiIdToOrderNumber = new Map(entries.map((e) => [e.apiId, e.orderNumber]));

    const batches: string[][] = [];
    for (let i = 0; i < apiIds.length; i += EBAY_VERIFY_BATCH_SIZE) {
      batches.push(apiIds.slice(i, i + EBAY_VERIFY_BATCH_SIZE));
    }

    const batchResults: Array<Map<string, string | null>> = [];
    await runConcurrently(batches, IDENTIFY_CONCURRENCY, async (batch) => {
      batchResults.push(await ebayVerifyBatch(integrationId, config, batch));
    });

    for (const m of batchResults) {
      for (const [apiId, tracking] of m) {
        const orderNumber = apiIdToOrderNumber.get(apiId);
        if (orderNumber) combined.set(orderNumber, tracking);
      }
    }
  }

  return combined;
}

// ─── Platform shipment execution ──────────────────────────────────────────────

async function shipEbay(
  integrationId: string,
  config: EbayConfig,
  orderId: string,
  trackingNumber: string,
): Promise<{ warnings: string[] }> {
  const accessToken = await getEbayAccessToken(integrationId, config);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<CompleteSaleRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderID>${orderId}</OrderID>
  <Shipped>true</Shipped>
  <Shipment>
    <ShipmentTrackingDetails>
      <ShippingCarrierUsed>${CARRIER}</ShippingCarrierUsed>
      <ShipmentTrackingNumber>${trackingNumber}</ShipmentTrackingNumber>
    </ShipmentTrackingDetails>
  </Shipment>
</CompleteSaleRequest>`;

  const res = await fetchWithTimeout(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": accessToken,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-CALL-NAME": "CompleteSale",
      "Content-Type": "text/xml",
    },
    body,
  });

  if (!res.ok) throw new Error(`eBay CompleteSale HTTP error: ${res.status}`);

  const parsed = parser.parse(res.body) as Record<string, unknown>;
  const root = parsed.CompleteSaleResponse as Record<string, unknown> | undefined;
  const ack = root?.Ack as string | undefined;

  // Extract all error/warning messages regardless of ack value
  const errorsRaw = root?.Errors;
  const errorsArr: Array<Record<string, unknown>> = Array.isArray(errorsRaw)
    ? errorsRaw
    : errorsRaw && typeof errorsRaw === "object"
      ? [errorsRaw as Record<string, unknown>]
      : [];

  const allMessages = errorsArr
    .map((e) => {
      const short = String(e.ShortMessage ?? "").trim();
      const long = String(e.LongMessage ?? "").trim();
      const code = e.ErrorCode ? ` [${e.ErrorCode}]` : "";
      return long ? `${long}${code}` : short ? `${short}${code}` : "";
    })
    .filter(Boolean);

  if (ack !== "Success" && ack !== "Warning") {
    throw new Error(
      `eBay CompleteSale failed (${ack ?? "no ack"}): ${allMessages.join("; ") || "unknown error"}`,
    );
  }

  // On Warning, surface all messages to the caller so they appear in the UI
  const warnings = ack === "Warning" ? allMessages : [];
  return { warnings };
}

async function shipBigCommerce(
  storeHash: string,
  accessToken: string,
  orderId: string,
  trackingNumber: string,
  products: BcOrderProduct[],
  addressId?: number,
): Promise<void> {
  const payload: Record<string, unknown> = {
    tracking_number: trackingNumber,
    tracking_carrier: CARRIER,
    items: products.map((p) => ({ order_product_id: p.order_product_id, quantity: p.quantity })),
  };
  if (addressId != null) payload.order_address_id = addressId;

  const url = `https://api.bigcommerce.com/stores/${storeHash}/v2/orders/${orderId}/shipments`;
  const reqInit = {
    method: "POST" as const,
    headers: { "X-Auth-Token": accessToken, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  };

  // Retry on 429 with up to 3 attempts and exponential back-off
  const MAX_BC_ATTEMPTS = 3;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_BC_ATTEMPTS; attempt++) {
    const res = await fetchWithTimeout(url, reqInit);
    if (res.ok) return;

    if (res.status === 429 && attempt < MAX_BC_ATTEMPTS) {
      const retryAfterMs = Math.min(
        Number(res.body.match(/"retry_after":(\d+)/)?.[1] ?? 0) * 1000 || 0,
        30_000,
      ) || attempt * 2_000;
      await new Promise((r) => setTimeout(r, retryAfterMs));
      continue;
    }

    let detail = res.body;
    try {
      const parsed = JSON.parse(res.body) as Array<Record<string, unknown>>;
      detail = parsed.map((e) => String(e.message ?? e.title ?? "")).join("; ");
    } catch { /* use raw */ }
    lastError = new Error(`BigCommerce shipment failed (${res.status}): ${detail}`);
    break;
  }
  if (lastError) throw lastError;
}

async function shipShopify(
  storeDomain: string,
  accessToken: string,
  apiVersion: string,
  platformOrderId: string,
  trackingNumber: string,
): Promise<void> {
  const headers = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // ── Strategy 1: Fulfillment Orders API (requires
  //    read_merchant_managed_fulfillment_orders scope) ──
  const foRes = await shopifyFetch(
    `https://${storeDomain}/admin/api/${apiVersion}/orders/${platformOrderId}/fulfillment_orders.json`,
    { headers },
  );

  if (foRes.ok) {
    const foData = JSON.parse(foRes.body) as {
      fulfillment_orders?: Array<{ id: number; status: string }>;
    };
    const allFo = foData.fulfillment_orders ?? [];
    const open = allFo.filter(
      (fo) =>
        fo.status === "open" ||
        fo.status === "in_progress" ||
        fo.status === "scheduled",
    );
    if (open.length === 0) {
      const statuses = allFo.map((fo) => fo.status).join(", ") || "none";
      throw new Error(
        `Shopify order ${platformOrderId} has no open fulfillment orders (statuses found: ${statuses}) — it may already be fulfilled.`,
      );
    }

    const res = await shopifyFetch(
      `https://${storeDomain}/admin/api/${apiVersion}/fulfillments.json`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          fulfillment: {
            line_items_by_fulfillment_order: open.map((fo) => ({
              fulfillment_order_id: fo.id,
            })),
            tracking_info: { number: trackingNumber, company: CARRIER },
            notify_customer: true,
          },
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`Shopify fulfillment failed (${res.status}): ${res.body}`);
    }
    return;
  }

  // fulfillment_orders endpoint failed — most likely missing scope
  if (foRes.status === 401 || foRes.status === 403) {
    throw new Error(
      `Shopify: token missing required scope "read_merchant_managed_fulfillment_orders". ` +
      `Add it to your Shopify app, release a new version, reinstall on your store, and update the token in reorG Integrations.`,
    );
  }

  throw new Error(
    `Shopify: fulfillment_orders endpoint returned ${foRes.status} for order ${platformOrderId}: ${foRes.body}`,
  );
}

// ─── executeShipments ─────────────────────────────────────────────────────────

export async function executeShipments(
  orders: IdentifiedOrder[],
  actorUserId: string,
  batchId?: string,
): Promise<{ results: ShipResult[]; autoResponderStatus: { queued: number; skipped: number; error?: string } }> {
  const integrationIds = [...new Set(orders.map((o) => o.integrationId))];
  const integrations = await db.integration.findMany({
    where: { id: { in: integrationIds } },
    select: { id: true, platform: true, config: true, writeLocked: true, enabled: true, label: true },
  });
  const byId = new Map(integrations.map((i) => [i.id, i]));

  // Build eBay config map for verification step
  const ebayConfigMap = new Map<string, EbayConfig>();
  for (const intg of integrations) {
    if (intg.platform === "TPP_EBAY" || intg.platform === "TT_EBAY") {
      ebayConfigMap.set(intg.id, buildEbayConfig(intg.config as Record<string, unknown>));
    }
  }

  const results: ShipResult[] = Array(orders.length).fill(null);
  const successfulEbayOrders: Array<{ orderNumber: string; trackingNumber: string; integrationId: string; platformOrderId: string; index: number }> = [];

  // Phase 1: Execute all shipments concurrently.
  // Shopify has a strict 2 calls/second rate limit so Shopify + Amazon orders run at
  // SHOPIFY_CONCURRENCY; eBay and BC run at the higher EXECUTE_CONCURRENCY.
  const fastOrders = orders.map((o, i) => ({ order: o, index: i })).filter(
    ({ order }) => order.platform !== "SHOPIFY" && order.platform !== "AMAZON",
  );
  const shopifyOrders = orders.map((o, i) => ({ order: o, index: i })).filter(
    ({ order }) => order.platform === "SHOPIFY",
  );
  const amazonOrders = orders.map((o, i) => ({ order: o, index: i })).filter(
    ({ order }) => order.platform === "AMAZON",
  );

  const executeOne = async ({ order, index }: { order: IdentifiedOrder; index: number }) => {
      const integration = byId.get(order.integrationId);

      if (!integration) {
        results[index] = { orderNumber: order.orderNumber, trackingNumber: order.trackingNumber, platform: order.platform, success: false, error: "Integration not found" };
        return;
      }

      const safety = await checkWriteSafety(order.platform);
      if (!safety.allowed) {
        results[index] = { orderNumber: order.orderNumber, trackingNumber: order.trackingNumber, platform: order.platform, success: false, error: safety.reason ?? "Write not allowed" };
        return;
      }

      try {
        const cfg = integration.config as Record<string, unknown>;

        if (order.platform === "TPP_EBAY" || order.platform === "TT_EBAY") {
          const ebayConfig = buildEbayConfig(cfg);
          ebayConfigMap.set(order.integrationId, ebayConfig);
          const { warnings } = await shipEbay(order.integrationId, ebayConfig, order.platformOrderId, order.trackingNumber);
          successfulEbayOrders.push({ orderNumber: order.orderNumber, trackingNumber: order.trackingNumber, integrationId: order.integrationId, platformOrderId: order.platformOrderId, index });
          results[index] = {
            orderNumber: order.orderNumber,
            trackingNumber: order.trackingNumber,
            platform: order.platform,
            success: true,
            verificationStatus: "unverified",
            ...(warnings.length > 0 ? { ebayWarnings: warnings } : {}),
          };
        } else if (order.platform === "BIGCOMMERCE") {
          await shipBigCommerce(
            cfg.storeHash as string,
            cfg.accessToken as string,
            order.platformOrderId,
            order.trackingNumber,
            order.bcProducts ?? [],
            order.bcAddressId,
          );
          results[index] = { orderNumber: order.orderNumber, trackingNumber: order.trackingNumber, platform: order.platform, success: true, verificationStatus: "unverified" };
        } else if (order.platform === "SHOPIFY") {
          await shipShopify(
            cfg.storeDomain as string,
            cfg.accessToken as string,
            (cfg.apiVersion as string) || "2026-01",
            order.platformOrderId,
            order.trackingNumber,
          );
          results[index] = { orderNumber: order.orderNumber, trackingNumber: order.trackingNumber, platform: order.platform, success: true, verificationStatus: "unverified" };
        } else if (order.platform === "AMAZON") {
          if (!order.amazonOrderItems?.length) {
            throw new Error("Amazon order items not cached — re-identify the order and try again.");
          }
          await shipAmazon(
            cfg.refreshToken as string,
            order.platformOrderId,
            order.trackingNumber,
            order.amazonMarketplaceId ?? AMAZON_MARKETPLACE_ID_US,
            order.amazonOrderItems,
          );
          results[index] = { orderNumber: order.orderNumber, trackingNumber: order.trackingNumber, platform: order.platform, success: true, verificationStatus: "unverified" };
        }

        // Record outbound push in Public Network Transfer
        const bodyEstimate = JSON.stringify({
          orderId: order.platformOrderId,
          trackingNumber: order.trackingNumber,
          carrier: CARRIER,
        }).length;
        void recordNetworkTransferSample({
          channel: "MARKETPLACE_OUTBOUND",
          label: `ship_order / ${order.platform}`,
          bytesEstimate: bodyEstimate,
          integrationId: order.integrationId,
          metadata: { platform: order.platform, orderNumber: order.orderNumber },
        });

        await db.auditLog.create({
          data: {
            action: "ship_order",
            entityType: "order",
            entityId: order.orderNumber,
            userId: actorUserId,
            details: { platform: order.platform, platformOrderId: order.platformOrderId, trackingNumber: order.trackingNumber, carrier: CARRIER },
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        results[index] = { orderNumber: order.orderNumber, trackingNumber: order.trackingNumber, platform: order.platform, success: false, error: message };
        await db.auditLog.create({
          data: {
            action: "ship_order_failed",
            entityType: "order",
            entityId: order.orderNumber,
            userId: actorUserId,
            details: { platform: order.platform, platformOrderId: order.platformOrderId, trackingNumber: order.trackingNumber, error: message },
          },
        });
      }
  };

  // eBay + BC: high concurrency (generous rate limits)
  await runConcurrently(fastOrders, EXECUTE_CONCURRENCY, executeOne);
  // Shopify: 2 concurrent to stay under 2 calls/sec
  await runConcurrently(shopifyOrders, SHOPIFY_CONCURRENCY, executeOne);
  // Amazon: 1 at a time with built-in 429 retry to respect 0.5 req/sec limit
  await runConcurrently(amazonOrders, AMAZON_CONCURRENCY, executeOne);

  // Phase 2: Verify eBay tracking in batches
  if (successfulEbayOrders.length > 0) {
    const verifiedMap = await verifyEbayShipments(successfulEbayOrders, ebayConfigMap);

    for (const { orderNumber, trackingNumber, index } of successfulEbayOrders) {
      const verified = verifiedMap.get(orderNumber);
      const current = results[index];
      if (!current) continue;

      const normalizeTracking = (t: string | null | undefined) => t?.trim().replace(/\s+/g, "").toUpperCase();
      const submittedNorm = normalizeTracking(trackingNumber);
      const verifiedNorm = normalizeTracking(verified ?? null);

      // Determine verification status:
      //  "verified"   – eBay returned the exact tracking we submitted
      //  "mismatch"   – eBay returned a DIFFERENT (non-empty) tracking, or returned
      //                 nothing AND CompleteSale had warnings (likely rejected)
      //  "unverified" – eBay returned nothing but CompleteSale had no warnings
      //                 (update likely succeeded but tracking isn't readable via GetOrders yet)
      const hasWarnings = !!(current.ebayWarnings?.length);
      const verificationStatus: "verified" | "mismatch" | "unverified" =
        verifiedNorm && verifiedNorm === submittedNorm
          ? "verified"
          : verified != null
            ? "mismatch"
            : hasWarnings
              ? "mismatch"
              : "unverified";

      results[index] = {
        ...current,
        verifiedTrackingNumber: verified ?? null,
        verificationStatus,
      };
    }
  }

  // ── Auto Responder: bulk-enqueue jobs for successfully shipped eBay orders ──
  let autoResponderStatus: { queued: number; skipped: number; error?: string } = { queued: 0, skipped: 0 };
  try {
    const { bulkEnqueueAutoResponderJobs } = await import("@/lib/services/auto-responder");
    const ebayPlatforms = new Set<Platform>(["TPP_EBAY", "TT_EBAY"]);

    const ebayOrders: Array<{ channel: Platform; orderNumber: string; trackingNumber?: string; carrier?: string }> = [];
    for (const r of results) {
      if (!r || !r.success || !r.platform || !ebayPlatforms.has(r.platform)) continue;
      ebayOrders.push({
        channel: r.platform,
        orderNumber: r.orderNumber,
        trackingNumber: r.trackingNumber,
        carrier: CARRIER,
      });
    }

    console.log(`[auto-responder] eligible eBay orders for enqueue: ${ebayOrders.length}`);

    if (ebayOrders.length > 0) {
      const result = await bulkEnqueueAutoResponderJobs(ebayOrders, batchId);
      autoResponderStatus = { queued: result.queued, skipped: result.skipped };
      if (Object.keys(result.reasons).length > 0) {
        autoResponderStatus.error = JSON.stringify(result.reasons);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[auto-responder] bulk enqueue failed:", msg, err);
    autoResponderStatus.error = msg;
  }

  return { results: results as ShipResult[], autoResponderStatus };
}
