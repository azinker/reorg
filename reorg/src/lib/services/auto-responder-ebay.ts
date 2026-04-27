import { db } from "@/lib/db";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";
import type { Platform } from "@prisma/client";

// ΓöÇΓöÇΓöÇ eBay Trading API constants (shared with ship-orders) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const FULFILLMENT_API = "https://api.ebay.com/sell/fulfillment/v1/order";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const REQUEST_TIMEOUT_MS = 30_000;

// ΓöÇΓöÇΓöÇ Token registry ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface TokenDef {
  key: string;
  label: string;
  description: string;
  example: string;
  requiresTracking?: boolean;
}

export const SUPPORTED_TOKENS: TokenDef[] = [
  { key: "{buyer_name}", label: "Buyer Name", description: "Full buyer name from eBay", example: "John Smith" },
  { key: "{buyer_first_name}", label: "Buyer First Name", description: "First name derived from buyer name", example: "John" },
  { key: "{order_id}", label: "Order ID", description: "eBay order number", example: "13-14447-09753" },
  { key: "{item_name}", label: "Item Name", description: "Title of the first item in the order", example: "High Speed Memory Card" },
  { key: "{tracking_number}", label: "Tracking Number", description: "Shipment tracking number", example: "9401903308745112568932", requiresTracking: true },
  { key: "{carrier}", label: "Carrier", description: "Shipping carrier name", example: "USPS", requiresTracking: true },
  { key: "{store_name}", label: "Store Name", description: "Your eBay store name", example: "The Perfect Part" },
];

const SUPPORTED_TOKEN_KEYS = new Set(SUPPORTED_TOKENS.map((t) => t.key));
const TOKEN_REGEX = /\{[a-z_]+\}/g;

export const EBAY_SUBJECT_MAX_LENGTH = 200;
export const EBAY_BODY_MAX_LENGTH = 2000;

// ΓöÇΓöÇΓöÇ Validation ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface TemplateValidationError {
  field: "subject" | "body";
  message: string;
}

export function validateTemplates(
  subject: string,
  body: string,
): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];

  if (!subject.trim()) {
    errors.push({ field: "subject", message: "Subject is required" });
  }
  if (!body.trim()) {
    errors.push({ field: "body", message: "Body is required" });
  }
  if (subject.length > EBAY_SUBJECT_MAX_LENGTH) {
    errors.push({ field: "subject", message: `Subject exceeds ${EBAY_SUBJECT_MAX_LENGTH} characters` });
  }
  if (body.length > EBAY_BODY_MAX_LENGTH) {
    errors.push({ field: "body", message: `Body exceeds ${EBAY_BODY_MAX_LENGTH} characters` });
  }

  for (const match of subject.matchAll(TOKEN_REGEX)) {
    if (!SUPPORTED_TOKEN_KEYS.has(match[0])) {
      errors.push({ field: "subject", message: `Unsupported token: ${match[0]}` });
    }
  }
  for (const match of body.matchAll(TOKEN_REGEX)) {
    if (!SUPPORTED_TOKEN_KEYS.has(match[0])) {
      errors.push({ field: "body", message: `Unsupported token: ${match[0]}` });
    }
  }

  return errors;
}

export function templateUsesTrackingTokens(subject: string, body: string): boolean {
  const combined = subject + body;
  return SUPPORTED_TOKENS.filter((t) => t.requiresTracking).some((t) => combined.includes(t.key));
}

// ΓöÇΓöÇΓöÇ Token rendering ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface RenderContext {
  buyerName?: string | null;
  buyerFirstName?: string | null;
  orderId: string;
  itemName?: string | null;
  trackingNumber?: string | null;
  carrier?: string | null;
  storeName: string;
}

export interface EbayOrderTracking {
  number: string;
  carrier: string | null;
  shippedTime: string | null;
}

export function deriveFirstName(fullName: string | null | undefined): string {
  if (!fullName?.trim()) return "";
  const parts = fullName.trim().split(/\s+/);
  const first = parts[0] ?? "";
  if (first.length < 2) return "";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

export function renderTemplate(template: string, ctx: RenderContext): string {
  const firstName = ctx.buyerFirstName ?? deriveFirstName(ctx.buyerName);

  let result = template;
  result = result.replace(/\{buyer_name\}/g, ctx.buyerName?.trim() || "Valued Customer");
  result = result.replace(/\{order_id\}/g, ctx.orderId);
  result = result.replace(/\{item_name\}/g, ctx.itemName?.trim() || "your item");
  result = result.replace(/\{tracking_number\}/g, ctx.trackingNumber?.trim() || "");
  result = result.replace(/\{carrier\}/g, ctx.carrier?.trim() || "USPS");
  result = result.replace(/\{store_name\}/g, ctx.storeName);

  // buyer_first_name: handle "Hi {buyer_first_name}," ΓåÆ "Hi," when name unavailable
  if (firstName) {
    result = result.replace(/\{buyer_first_name\}/g, firstName);
  } else {
    result = result.replace(/\{buyer_first_name\},?\s*/g, "");
    result = result.replace(/\{buyer_first_name\}/g, "");
  }

  return result;
}

// ΓöÇΓöÇΓöÇ eBay token refresh (reuses ship-orders pattern) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface EbayConfig {
  appId: string;
  certId: string;
  devId: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  environment?: string;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { method?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function getEbayAccessToken(
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
    }).toString(),
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

export function buildEbayConfig(integration: { config: unknown }): EbayConfig {
  const raw = (integration.config ?? {}) as Record<string, unknown>;
  const envPrefix =
    raw.environment === "PRODUCTION" || !raw.environment ? "" : "SANDBOX_";
  return {
    appId: (raw.appId as string) || "",
    certId: (raw.certId as string) || "",
    devId: (raw.devId as string) || "",
    refreshToken: (raw.refreshToken as string) || "",
    accessToken: (raw[`${envPrefix}accessToken`] as string) ?? (raw.accessToken as string) ?? undefined,
    accessTokenExpiresAt: (raw.accessTokenExpiresAt as number) ?? undefined,
    environment: (raw.environment as string) ?? "PRODUCTION",
  };
}

// ΓöÇΓöÇΓöÇ XML parser (lightweight, same as ship-orders) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export function parseXmlSimple(xml: string): Record<string, unknown> {
  // Reuse fast-xml-parser if available, else simple regex extraction.
  // `isArray` forces the listed tags to always parse as arrays so single-
  // element collections (e.g. one ShipmentTrackingDetails) still walk the
  // same code path as multi-element ones ΓÇö this keeps the tracking lookup
  // code below from having to defensively wrap-or-unwrap on every read.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { XMLParser } = require("fast-xml-parser");
    // CRITICAL: `parseTagValue: false` keeps every text node as a string.
    // eBay tracking numbers are 22 digits (USPS) and the parser would
    // otherwise coerce them into JS numbers, losing precision
    // (9401903308746074110125 -> 9.401903308746074e+21). Same risk for
    // OrderID, ItemID, SKU, postal codes, and any other "looks numeric but
    // isn't a number" field.
    const parser = new XMLParser({
      ignoreAttributes: true,
      trimValues: true,
      parseTagValue: false,
      isArray: (tagName: string) =>
        [
          "Order",
          "Transaction",
          "ShipmentTrackingDetails",
          "Errors",
          "Error",
        ].includes(tagName),
    });
    return parser.parse(xml) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Pull a tracking number / carrier out of the various places eBay can stash
 * them on a GetOrders response. eBay returns shipment details on three
 * different paths depending on how the seller marked the order shipped:
 *
 *   1. Order.ShippingDetails.ShipmentTrackingDetails        (rare, legacy)
 *   2. Transaction.Shipment.ShipmentTrackingDetails         (CompleteSale)
 *   3. Transaction.ShippingDetails.ShipmentTrackingDetails  (older sellers)
 *
 * We walk all three and return the first hit. Without this fallback the
 * tracking number disappears from the Help Desk right-rail for any order
 * shipped via CompleteSale (which is most of TPP's volume ΓÇö eDesk picks it
 * up via the same broader walk).
 */
function readXmlText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const inner = (value as Record<string, unknown>)["#text"];
    if (typeof inner === "string" && inner.trim()) return inner.trim();
  }
  return null;
}

export function extractTrackingNumbersFromOrder(
  order: Record<string, unknown>,
): EbayOrderTracking[] {
  const out: EbayOrderTracking[] = [];
  const seen = new Set<string>();
  const orderShippedTime = readXmlText(order.ShippedTime);

  const addFromDetails = (
    raw: unknown,
    fallbackShippedTime: string | null,
  ): void => {
    if (!raw) return;
    const arr = Array.isArray(raw) ? raw : [raw];
    for (const td of arr as Array<Record<string, unknown>>) {
      const num = readXmlText(td.ShipmentTrackingNumber);
      if (!num) continue;
      const carrier = readXmlText(td.ShippingCarrierUsed);
      const shippedTime =
        readXmlText(td.ShippedTime) ??
        readXmlText(td.CreatedTime) ??
        readXmlText(td.EventTime) ??
        fallbackShippedTime;
      const key = `${carrier ?? ""}|${num}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ number: num, carrier, shippedTime });
    }
  };

  // 1. Order-level ShippingDetails
  const sd = order.ShippingDetails as Record<string, unknown> | undefined;
  if (sd) {
    addFromDetails(sd.ShipmentTrackingDetails, orderShippedTime);
  }

  // 2. Order-level ShippingServiceSelected (eBay shipping label path)
  const sss = order.ShippingServiceSelected as Record<string, unknown> | undefined;
  if (sss) {
    addFromDetails(sss.ShipmentTrackingDetails, orderShippedTime);
  }

  // 3 + 4 + 5. Transaction-level
  const ta = order.TransactionArray as Record<string, unknown> | undefined;
  const rawTx = ta?.Transaction;
  const transactions = Array.isArray(rawTx) ? rawTx : rawTx ? [rawTx] : [];
  for (const tx of transactions as Array<Record<string, unknown>>) {
    const txShippedTime = readXmlText(tx.ShippedTime) ?? orderShippedTime;
    const shipment = tx.Shipment as Record<string, unknown> | undefined;
    if (shipment) {
      addFromDetails(
        shipment.ShipmentTrackingDetails,
        readXmlText(shipment.ShippedTime) ?? txShippedTime,
      );
    }
    const txSd = tx.ShippingDetails as Record<string, unknown> | undefined;
    if (txSd) {
      addFromDetails(txSd.ShipmentTrackingDetails, txShippedTime);
    }
    const txSss = tx.ShippingServiceSelected as Record<string, unknown> | undefined;
    if (txSss) {
      addFromDetails(txSss.ShipmentTrackingDetails, txShippedTime);
    }
  }

  return out;
}

export function extractTrackingFromOrder(
  order: Record<string, unknown>,
): { number: string | null; carrier: string | null } {
  const first = extractTrackingNumbersFromOrder(order)[0];
  if (first) return { number: first.number, carrier: first.carrier };
  return { number: null, carrier: null };
}

/**
 * Pull estimated delivery + actual delivery from the GetOrders response.
 *
 * eBay exposes delivery info in three different shapes depending on the order
 * vintage and shipping path:
 *   a) Order.EstimatedDeliveryDateMin / Max                            (rare)
 *   b) Order.ShippingServiceSelected.EstimatedDeliveryDateMin / Max    (legacy)
 *   c) Transaction.ShippingServiceSelected.ShippingPackageInfo
 *        .EstimatedDeliveryTimeMin / Max                               (current)
 *
 * Most TPP volume lands in (c) because eBay returns the package-level
 * estimate once handling time is configured. Without that fallback the
 * right-rail showed "TBD" even when eBay had a window the buyer was seeing.
 *
 * `ActualDeliveryTime` lives on the same package-info nodes once the carrier
 * confirms delivery; we surface it so the panel can swap "Estimated" for
 * "Delivered <date>".
 */
export function extractDeliveryDates(
  order: Record<string, unknown>,
  firstTx: Record<string, unknown> | undefined,
): {
  estimatedMin: string | null;
  estimatedMax: string | null;
  actualDeliveryTime: string | null;
} {
  const pickFirstString = (...candidates: unknown[]): string | null => {
    for (const c of candidates) {
      if (c == null) continue;
      const s = String(c).trim();
      if (s) return s;
    }
    return null;
  };
  const orderSss = order.ShippingServiceSelected as
    | Record<string, unknown>
    | undefined;
  const orderPkg = orderSss?.ShippingPackageInfo as
    | Record<string, unknown>
    | undefined;
  const txSss = firstTx?.ShippingServiceSelected as
    | Record<string, unknown>
    | undefined;
  const txPkg = txSss?.ShippingPackageInfo as
    | Record<string, unknown>
    | undefined;

  return {
    estimatedMin: pickFirstString(
      order.EstimatedDeliveryDateMin,
      orderSss?.EstimatedDeliveryDateMin,
      txPkg?.EstimatedDeliveryTimeMin,
    ),
    estimatedMax: pickFirstString(
      order.EstimatedDeliveryDateMax,
      orderSss?.EstimatedDeliveryDateMax,
      txPkg?.EstimatedDeliveryTimeMax,
    ),
    actualDeliveryTime: pickFirstString(
      orderPkg?.ActualDeliveryTime,
      txPkg?.ActualDeliveryTime,
    ),
  };
}

// ΓöÇΓöÇΓöÇ GetOrders enrichment (buyer + item data) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface EbayOrderDetails {
  orderId: string;
  buyerUserId: string;
  buyerName: string;
  itemId: string;
  itemTitle: string;
  shippedTime?: string;
  orderStatus?: string;
}

export async function fetchEbayOrderDetails(
  integrationId: string,
  config: EbayConfig,
  orderIds: string[],
): Promise<Map<string, EbayOrderDetails>> {
  const result = new Map<string, EbayOrderDetails>();
  if (orderIds.length === 0) return result;

  const accessToken = await getEbayAccessToken(integrationId, config);
  const idElements = orderIds.map((id) => `    <OrderID>${escapeXml(id)}</OrderID>`).join("\n");
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

  void recordNetworkTransferSample({
    channel: "AUTO_RESPONDER",
    label: `get_orders_enrich / ${integrationId}`,
    bytesEstimate: Buffer.byteLength(body) + Buffer.byteLength(res.body),
    integrationId,
  });

  if (!res.ok) return result;

  const parsed = parseXmlSimple(res.body);
  const root = parsed.GetOrdersResponse as Record<string, unknown> | undefined;
  const orderArray = root?.OrderArray as Record<string, unknown> | undefined;
  const rawOrders = orderArray?.Order;
  const orders = Array.isArray(rawOrders) ? rawOrders : rawOrders ? [rawOrders] : [];

  for (const order of orders as Array<Record<string, unknown>>) {
    const orderId = String(order.OrderID ?? "").trim();
    if (!orderId) continue;

    const buyerUserId = String(order.BuyerUserID ?? "").trim();

    const ta = order.TransactionArray as Record<string, unknown> | undefined;
    const rawTx = ta?.Transaction;
    const transactions = Array.isArray(rawTx) ? rawTx : rawTx ? [rawTx] : [];
    const firstTx = transactions[0] as Record<string, unknown> | undefined;

    const buyer = firstTx?.Buyer as Record<string, unknown> | undefined;
    const buyerName = String(buyer?.UserFirstName ?? "").trim() +
      (buyer?.UserLastName ? ` ${String(buyer.UserLastName).trim()}` : "");

    const item = firstTx?.Item as Record<string, unknown> | undefined;
    const itemId = String(item?.ItemID ?? "").trim();
    const itemTitle = firstTx ? orderLineItemTitle(firstTx, item) : String(item?.Title ?? "").trim();
    const shippedTime = order.ShippedTime ? String(order.ShippedTime) : undefined;
    const orderStatus = order.OrderStatus ? String(order.OrderStatus) : undefined;

    const userInputId = orderIds.find(
      (input) => orderId === input || orderId.startsWith(`${input}!`),
    );

    if (userInputId) {
      result.set(userInputId, {
        orderId,
        buyerUserId: buyerUserId || (buyer?.UserID ? String(buyer.UserID) : ""),
        buyerName: buyerName || String(buyer?.UserID ?? ""),
        itemId,
        itemTitle,
        shippedTime,
        orderStatus,
      });
    }
  }

  return result;
}

// ΓöÇΓöÇΓöÇ Fetch full order context (tracking, address, line items) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * Help-Desk-friendly read of a single eBay order. Pulls tracking number,
 * carrier, shipping address, line items, totals, and dates so the agent's
 * context panel can show everything they'd otherwise have to flip into
 * Seller Hub for. Read-only ΓÇö never writes back to eBay.
 *
 * Failure mode: returns `null` if the order can't be loaded (network error,
 * permission issue, eBay returning Failure ack). Callers should degrade
 * gracefully and rely on whatever metadata already lives on the ticket.
 */
export interface EbayOrderContextLineItem {
  itemId: string;
  title: string;
  sku: string | null;
  quantity: number;
  unitPriceCents: number | null;
  pictureUrl: string | null;
}

export interface EbayOrderContextAddress {
  name: string | null;
  street1: string | null;
  street2: string | null;
  cityName: string | null;
  stateOrProvince: string | null;
  postalCode: string | null;
  countryName: string | null;
  /**
   * Buyer phone number captured at checkout. eBay returns this on
   * `Order.ShippingAddress.Phone`; we surface it on the Customer card so the
   * agent can call the buyer when SMS / message reach-out has stalled.
   */
  phone: string | null;
}

export interface EbayOrderContext {
  orderId: string;
  /**
   * eBay's Selling Manager Sales Record Number ΓÇö the "(5149769)" companion
   * number agents recognise from the eBay seller hub. Optional because
   * not every order has SM Pro enabled, but when present we render it
   * inline next to the order id (eDesk does the same).
   */
  salesRecordNumber: string | null;
  buyerUserId: string;
  buyerName: string;
  buyerEmail: string | null;
  orderStatus: string | null;
  /** Created / paid / shipped timestamps in ISO-8601 (eBay returns these in UTC). */
  createdTime: string | null;
  paidTime: string | null;
  shippedTime: string | null;
  estimatedDeliveryMin: string | null;
  estimatedDeliveryMax: string | null;
  /**
   * Confirmed delivery timestamp (eBay's `ActualDeliveryTime`). Populated
   * once the carrier reports the package as delivered. We surface this so
   * the agent immediately sees "Delivered Mar 2" instead of a stale
   * "estimated by Mar 2" window.
   */
  actualDeliveryTime: string | null;
  /** Shipping service summary, e.g. "USPS Ground Advantage". */
  shippingService: string | null;
  /** First tracking number found, plus carrier when eBay sent one. */
  trackingNumber: string | null;
  trackingCarrier: string | null;
  /** Every tracking number eBay returns for the order. */
  trackingNumbers: EbayOrderTracking[];
  /** Total in cents (subtotal + shipping + tax). */
  totalCents: number | null;
  /**
   * Shipping fee charged to the buyer in cents, when eBay surfaces it on
   * the chosen shipping service. Renders in the ContextPanel right above
   * the order Total so agents can answer "how much shipping did I pay?"
   * without opening eBay. Null when the buyer used free shipping or eBay
   * doesn't expose a per-order shipping line.
   */
  shippingCents: number | null;
  currency: string | null;
  shippingAddress: EbayOrderContextAddress | null;
  lineItems: EbayOrderContextLineItem[];
}

function parseDollarsToCents(raw: unknown): number | null {
  if (raw == null) return null;
  // eBay sometimes returns { "#text": "11.89", "@_currencyID": "USD" } or just "11.89"
  let text: string;
  if (typeof raw === "object" && raw !== null && "#text" in (raw as Record<string, unknown>)) {
    text = String((raw as Record<string, unknown>)["#text"] ?? "");
  } else {
    text = String(raw);
  }
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function pickCurrency(raw: unknown): string | null {
  // Mirrors parseDollarsToCents; when the parser strips attributes (our default
  // does) we lose currency. Fall back to USD when anything was present.
  if (raw == null) return null;
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const cur = obj["@_currencyID"] ?? obj.currencyID;
    if (cur) return String(cur);
  }
  return "USD";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asList<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return value == null ? [] : [value as T];
}

function nonEmptyString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function variationValues(variation: Record<string, unknown> | null): string[] {
  const specifics = asRecord(variation?.VariationSpecifics);
  const values: string[] = [];
  for (const row of asList<Record<string, unknown>>(specifics?.NameValueList)) {
    const rowRecord = asRecord(row);
    if (!rowRecord) continue;
    for (const value of asList(rowRecord.Value)) {
      const text = nonEmptyString(value);
      if (text) values.push(text);
    }
  }
  return values;
}

function orderLineItemTitle(
  tx: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
): string {
  const variation = asRecord(tx.Variation);
  const base =
    nonEmptyString(variation?.VariationTitle) ??
    nonEmptyString(item?.Title) ??
    nonEmptyString(tx.Title) ??
    "";
  const values = variationValues(variation);
  if (values.length === 0) return base;

  const normalizedBase = base.toLowerCase();
  const missingValues = values.filter(
    (value) => !normalizedBase.includes(value.toLowerCase()),
  );
  if (missingValues.length === 0) return base;
  return base ? `${base} [${missingValues.join(", ")}]` : missingValues.join(", ");
}

function parseFulfillmentMoneyToCents(raw: unknown): number | null {
  const obj = asRecord(raw);
  return parseDollarsToCents(obj?.value ?? raw);
}

function pickFulfillmentCurrency(raw: unknown): string | null {
  const obj = asRecord(raw);
  return nonEmptyString(obj?.currency) ?? pickCurrency(raw);
}

function firstDate(...values: Array<unknown>): string | null {
  for (const value of values) {
    const text = nonEmptyString(value);
    if (text) return text;
  }
  return null;
}

function fulfillmentLineItemTitle(line: Record<string, unknown>): string {
  const base = nonEmptyString(line.title) ?? nonEmptyString(line.legacyItemId) ?? "";
  const aspects = asList<Record<string, unknown>>(line.variationAspects)
    .map((aspect) => nonEmptyString(aspect.value))
    .filter((value): value is string => !!value);
  if (aspects.length === 0) return base;

  const normalizedBase = base.toLowerCase();
  const missingAspects = aspects.filter(
    (value) => !normalizedBase.includes(value.toLowerCase()),
  );
  if (missingAspects.length === 0) return base;
  return base ? `${base} [${missingAspects.join(", ")}]` : missingAspects.join(", ");
}

function inferCarrierFromTracking(number: string | null, fallback: string | null): string | null {
  if (fallback && !/^shippingmethod/i.test(fallback)) return fallback;
  const compact = number?.replace(/\s+/g, "") ?? "";
  if (/^9\d{18,}$/.test(compact)) return "USPS";
  if (/^1Z[0-9A-Z]{16}$/i.test(compact)) return "UPS";
  return fallback;
}

function trackingNumberFromFulfillmentHref(href: string): string | null {
  try {
    const url = new URL(href);
    const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
    return last.length >= 8 ? last : null;
  } catch {
    const last = href.split("/").filter(Boolean).at(-1) ?? "";
    return last.length >= 8 ? decodeURIComponent(last) : null;
  }
}

function fulfillmentAddress(
  instruction: Record<string, unknown> | null,
): EbayOrderContextAddress | null {
  const shippingStep = asRecord(instruction?.shippingStep);
  const shipTo = asRecord(shippingStep?.shipTo);
  const address = asRecord(shipTo?.contactAddress);
  if (!shipTo && !address) return null;

  const phone = asRecord(shipTo?.primaryPhone);
  const result: EbayOrderContextAddress = {
    name:
      nonEmptyString(shipTo?.fullName) ??
      nonEmptyString(shipTo?.name) ??
      nonEmptyString(address?.name),
    street1:
      nonEmptyString(address?.addressLine1) ??
      nonEmptyString(address?.street1),
    street2:
      nonEmptyString(address?.addressLine2) ??
      nonEmptyString(address?.street2),
    cityName: nonEmptyString(address?.city) ?? nonEmptyString(address?.cityName),
    stateOrProvince:
      nonEmptyString(address?.stateOrProvince) ??
      nonEmptyString(address?.state),
    postalCode: nonEmptyString(address?.postalCode),
    countryName:
      nonEmptyString(address?.country) ??
      nonEmptyString(address?.countryCode),
    phone:
      nonEmptyString(phone?.phoneNumber) ??
      nonEmptyString(shipTo?.phoneNumber),
  };

  return Object.values(result).some(Boolean) ? result : null;
}

async function fetchFulfillmentShipment(
  accessToken: string,
  href: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetchWithTimeout(href, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  void recordNetworkTransferSample({
    channel: "AUTO_RESPONDER",
    label: "helpdesk_fulfillment_shipment",
    bytesEstimate: Buffer.byteLength(href) + Buffer.byteLength(res.body),
  });

  if (!res.ok) return null;
  try {
    return JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fetchEbayFulfillmentOrderContext(
  integrationId: string,
  orderId: string,
  accessToken: string,
): Promise<EbayOrderContext | null> {
  const url = `${FULFILLMENT_API}/${encodeURIComponent(orderId)}`;
  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  void recordNetworkTransferSample({
    channel: "AUTO_RESPONDER",
    label: `helpdesk_fulfillment_order_context / ${integrationId}`,
    bytesEstimate: Buffer.byteLength(url) + Buffer.byteLength(res.body),
    integrationId,
  });

  if (!res.ok) return null;

  let order: Record<string, unknown>;
  try {
    order = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    return null;
  }

  const fulfillmentHrefs = asList(order.fulfillmentHrefs)
    .map((href) => nonEmptyString(href))
    .filter((href): href is string => !!href);
  const shipments = (
    await Promise.all(
      fulfillmentHrefs.map((href) => fetchFulfillmentShipment(accessToken, href)),
    )
  ).filter((shipment): shipment is Record<string, unknown> => !!shipment);

  const instructions = asList<Record<string, unknown>>(order.fulfillmentStartInstructions)
    .map((instruction) => asRecord(instruction))
    .filter((instruction): instruction is Record<string, unknown> => !!instruction);
  const firstInstruction = instructions[0] ?? null;
  const firstShippingStep = asRecord(firstInstruction?.shippingStep);
  const firstLine = asRecord(asList(order.lineItems)[0]);
  const firstLineInstructions = asRecord(firstLine?.lineItemFulfillmentInstructions);

  const trackingNumbers = shipments
    .map((shipment) => {
      const number =
        nonEmptyString(shipment.shipmentTrackingNumber) ??
        nonEmptyString(shipment.trackingNumber) ??
        trackingNumberFromFulfillmentHref(nonEmptyString(shipment.href) ?? "");
      if (!number) return null;
      const carrier = inferCarrierFromTracking(
        number,
        nonEmptyString(shipment.shippingCarrierCode) ??
          nonEmptyString(shipment.carrierCode) ??
          nonEmptyString(shipment.shippingServiceCode),
      );
      return {
        number,
        carrier,
        shippedTime: firstDate(shipment.shippedDate, shipment.shippedTime),
      } satisfies EbayOrderTracking;
    })
    .filter((tracking): tracking is EbayOrderTracking => !!tracking);
  for (const href of fulfillmentHrefs) {
    const number = trackingNumberFromFulfillmentHref(href);
    if (!number || trackingNumbers.some((tracking) => tracking.number === number)) continue;
    trackingNumbers.push({
      number,
      carrier: inferCarrierFromTracking(number, null),
      shippedTime: null,
    });
  }

  const firstTracking = trackingNumbers[0] ?? { number: null, carrier: null };
  const pricing = asRecord(order.pricingSummary);
  const paymentSummary = asRecord(order.paymentSummary);
  const firstPayment = asRecord(asList(paymentSummary?.payments)[0]);
  const deliveryCost = asRecord(pricing?.deliveryCost);
  const total = asRecord(pricing?.total);
  const subtotal = asRecord(pricing?.priceSubtotal);

  const lineItems: EbayOrderContextLineItem[] = asList<Record<string, unknown>>(order.lineItems)
    .map((line) => asRecord(line))
    .filter((line): line is Record<string, unknown> => !!line)
    .map((line) => {
      const quantityRaw = Number(line.quantity ?? 1);
      const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0 ? quantityRaw : 1;
      const totalCents = parseFulfillmentMoneyToCents(line.total);
      return {
        itemId:
          nonEmptyString(line.legacyItemId) ??
          nonEmptyString(line.itemId) ??
          nonEmptyString(line.lineItemId) ??
          "",
        title: fulfillmentLineItemTitle(line),
        sku: nonEmptyString(line.sku),
        quantity,
        unitPriceCents:
          parseFulfillmentMoneyToCents(line.lineItemCost) ??
          (totalCents != null ? Math.round(totalCents / quantity) : null),
        pictureUrl: nonEmptyString(line.imageUrl) ?? nonEmptyString(line.pictureUrl),
      };
    })
    .filter((line) => line.itemId);

  const shippingService =
    nonEmptyString(firstTracking.carrier) ??
    nonEmptyString(firstShippingStep?.shippingServiceCode) ??
    nonEmptyString(firstInstruction?.shippingServiceCode);

  return {
    orderId:
      nonEmptyString(order.legacyOrderId) ??
      nonEmptyString(order.orderId) ??
      orderId,
    salesRecordNumber: nonEmptyString(order.salesRecordReference),
    buyerUserId: nonEmptyString(asRecord(order.buyer)?.username) ?? "",
    buyerName: nonEmptyString(asRecord(order.buyer)?.username) ?? "",
    buyerEmail: null,
    orderStatus:
      nonEmptyString(order.orderFulfillmentStatus) ??
      nonEmptyString(order.orderPaymentStatus),
    createdTime: firstDate(order.creationDate),
    paidTime: firstDate(firstPayment?.paymentDate),
    shippedTime: firstDate(
      ...trackingNumbers.map((tracking) => tracking.shippedTime),
    ),
    estimatedDeliveryMin: firstDate(
      firstInstruction?.minEstimatedDeliveryDate,
      firstLineInstructions?.minEstimatedDeliveryDate,
    ),
    estimatedDeliveryMax: firstDate(
      firstInstruction?.maxEstimatedDeliveryDate,
      firstLineInstructions?.maxEstimatedDeliveryDate,
    ),
    actualDeliveryTime: null,
    shippingService,
    trackingNumber: firstTracking.number,
    trackingCarrier: firstTracking.carrier,
    trackingNumbers,
    totalCents:
      parseFulfillmentMoneyToCents(total) ??
      parseFulfillmentMoneyToCents(subtotal),
    shippingCents: parseFulfillmentMoneyToCents(deliveryCost),
    currency:
      pickFulfillmentCurrency(total) ??
      pickFulfillmentCurrency(subtotal) ??
      pickFulfillmentCurrency(deliveryCost),
    shippingAddress: fulfillmentAddress(firstInstruction),
    lineItems,
  };
}

export async function fetchEbayOrderContext(
  integrationId: string,
  config: EbayConfig,
  orderId: string,
): Promise<EbayOrderContext | null> {
  const accessToken = await getEbayAccessToken(integrationId, config);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderIDArray>
    <OrderID>${escapeXml(orderId)}</OrderID>
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

  void recordNetworkTransferSample({
    channel: "AUTO_RESPONDER",
    label: `helpdesk_order_context / ${integrationId}`,
    bytesEstimate: Buffer.byteLength(body) + Buffer.byteLength(res.body),
    integrationId,
  });

  if (!res.ok) {
    return fetchEbayFulfillmentOrderContext(integrationId, orderId, accessToken);
  }

  const parsed = parseXmlSimple(res.body);
  const root = parsed.GetOrdersResponse as Record<string, unknown> | undefined;
  const orderArray = root?.OrderArray as Record<string, unknown> | undefined;
  const rawOrders = orderArray?.Order;
  const orders = Array.isArray(rawOrders) ? rawOrders : rawOrders ? [rawOrders] : [];
  if (orders.length === 0) {
    return fetchEbayFulfillmentOrderContext(integrationId, orderId, accessToken);
  }

  const order = orders[0] as Record<string, unknown>;
  const ta = order.TransactionArray as Record<string, unknown> | undefined;
  const rawTx = ta?.Transaction;
  const transactions = Array.isArray(rawTx) ? rawTx : rawTx ? [rawTx] : [];

  const firstTx = transactions[0] as Record<string, unknown> | undefined;
  const buyer = firstTx?.Buyer as Record<string, unknown> | undefined;
  const buyerName =
    String(buyer?.UserFirstName ?? "").trim() +
    (buyer?.UserLastName ? ` ${String(buyer.UserLastName).trim()}` : "");

  // Shipping address ΓÇö eBay returns it on the order, not per transaction.
  const ship = order.ShippingAddress as Record<string, unknown> | undefined;
  const shippingAddress: EbayOrderContextAddress | null = ship
    ? {
        name: ship.Name ? String(ship.Name) : null,
        street1: ship.Street1 ? String(ship.Street1) : null,
        street2: ship.Street2 ? String(ship.Street2) : null,
        cityName: ship.CityName ? String(ship.CityName) : null,
        stateOrProvince: ship.StateOrProvince ? String(ship.StateOrProvince) : null,
        postalCode: ship.PostalCode ? String(ship.PostalCode) : null,
        countryName: (ship.CountryName ?? ship.Country) ? String(ship.CountryName ?? ship.Country) : null,
        // eBay sometimes returns "Invalid Request" for the phone field when
        // the buyer hasn't authorised contact info exposure ΓÇö treat that as
        // null so we don't render the literal string in the UI.
        phone: ship.Phone && String(ship.Phone) !== "Invalid Request"
          ? String(ship.Phone)
          : null,
      }
    : null;

  // Tracking ΓÇö walk all three eBay locations (order shipping details,
  // transaction shipment, transaction shipping details). See
  // `extractTrackingFromOrder` for the precedence rationale.
  const shippingDetails = order.ShippingDetails as Record<string, unknown> | undefined;
  const trackingNumbers = extractTrackingNumbersFromOrder(order);
  const tracking = trackingNumbers[0] ?? { number: null, carrier: null };
  const trackingNumber = tracking.number;
  const trackingCarrier = tracking.carrier;
  // Shipping service ΓÇö try both the order-level summary and the transaction.
  const shippingServiceSelected = shippingDetails?.ShippingServiceOptions as
    | Record<string, unknown>
    | undefined;
  const shippingService = shippingServiceSelected?.ShippingService
    ? String(shippingServiceSelected.ShippingService)
    : null;
  // Shipping cost — eBay puts this in two places depending on whether the
  // seller charged for shipping. Try the chosen service first (most
  // accurate), then fall back to the order-level summary. Free shipping =
  // null so the UI can hide the row.
  const orderSss = order.ShippingServiceSelected as
    | Record<string, unknown>
    | undefined;
  const shippingCents =
    parseDollarsToCents(orderSss?.ShippingServiceCost) ??
    parseDollarsToCents(shippingServiceSelected?.ShippingServiceCost) ??
    parseDollarsToCents(shippingDetails?.ShippingServiceCost);

  // Line items
  const lineItems: EbayOrderContextLineItem[] = transactions
    .map((tx) => tx as Record<string, unknown>)
    .map((tx) => {
      const item = tx.Item as Record<string, unknown> | undefined;
      const variation = asRecord(tx.Variation);
      const itemId = item?.ItemID ? String(item.ItemID) : "";
      const title = orderLineItemTitle(tx, item);
      const sku = (variation?.SKU ?? item?.SKU ?? tx.SKU)
        ? String(variation?.SKU ?? item?.SKU ?? tx.SKU)
        : null;
      const qty = Number(tx.QuantityPurchased ?? 1);
      const unitPriceCents = parseDollarsToCents(tx.TransactionPrice);
      const pictureUrl =
        item?.PictureDetails && typeof item.PictureDetails === "object"
          ? (() => {
              const pd = item.PictureDetails as Record<string, unknown>;
              const galleryUrl = pd.GalleryURL;
              if (typeof galleryUrl === "string") return galleryUrl;
              const picUrl = pd.PictureURL;
              if (typeof picUrl === "string") return picUrl;
              if (Array.isArray(picUrl) && picUrl[0]) return String(picUrl[0]);
              return null;
            })()
          : null;
      return {
        itemId,
        title,
        sku,
        quantity: Number.isFinite(qty) ? qty : 1,
        unitPriceCents,
        pictureUrl,
      };
    })
    .filter((li) => li.itemId);

  const delivery = extractDeliveryDates(order, firstTx);
  const estimatedDeliveryMin = delivery.estimatedMin;
  const estimatedDeliveryMax = delivery.estimatedMax;
  const actualDeliveryTime = delivery.actualDeliveryTime;

  const totalCents = parseDollarsToCents(order.Total ?? order.AmountPaid);
  const currency = pickCurrency(order.Total) ?? pickCurrency(order.AmountPaid);

  // Sales Record Number (Selling Manager). Optional ΓÇö only present when the
  // seller subscribes to SM Pro. Stringified so we don't lose any leading
  // zeroes if eBay ever changes the shape.
  const salesRecordNumber = order.SellingManagerSalesRecordNumber
    ? String(order.SellingManagerSalesRecordNumber)
    : null;

  return {
    orderId: String(order.OrderID ?? orderId),
    salesRecordNumber,
    buyerUserId: String(order.BuyerUserID ?? buyer?.UserID ?? "").trim(),
    buyerName: buyerName || String(buyer?.UserID ?? ""),
    buyerEmail: buyer?.Email && String(buyer.Email) !== "Invalid Request" ? String(buyer.Email) : null,
    orderStatus: order.OrderStatus ? String(order.OrderStatus) : null,
    createdTime: order.CreatedTime ? String(order.CreatedTime) : null,
    paidTime: order.PaidTime ? String(order.PaidTime) : null,
    shippedTime: order.ShippedTime ? String(order.ShippedTime) : null,
    estimatedDeliveryMin,
    estimatedDeliveryMax,
    actualDeliveryTime,
    shippingService,
    trackingNumber,
    trackingCarrier,
    trackingNumbers,
    totalCents,
    shippingCents,
    currency,
    shippingAddress,
    lineItems,
  };
}

// ΓöÇΓöÇΓöÇ Fetch recently shipped orders (reconciliation) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export async function fetchRecentlyShippedOrders(
  integrationId: string,
  config: EbayConfig,
  from: Date,
  to: Date,
): Promise<EbayOrderDetails[]> {
  const accessToken = await getEbayAccessToken(integrationId, config);
  const results: EbayOrderDetails[] = [];
  let pageNumber = 1;
  const maxPages = 10;

  while (pageNumber <= maxPages) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderStatus>Completed</OrderStatus>
  <ModTimeFrom>${from.toISOString()}</ModTimeFrom>
  <ModTimeTo>${to.toISOString()}</ModTimeTo>
  <Pagination>
    <EntriesPerPage>100</EntriesPerPage>
    <PageNumber>${pageNumber}</PageNumber>
  </Pagination>
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

    void recordNetworkTransferSample({
      channel: "AUTO_RESPONDER",
      label: `reconciliation_get_orders / ${integrationId}`,
      bytesEstimate: Buffer.byteLength(body) + Buffer.byteLength(res.body),
      integrationId,
    });

    if (!res.ok) break;

    const parsed = parseXmlSimple(res.body);
    const root = parsed.GetOrdersResponse as Record<string, unknown> | undefined;
    const orderArray = root?.OrderArray as Record<string, unknown> | undefined;
    const rawOrders = orderArray?.Order;
    const orders = Array.isArray(rawOrders) ? rawOrders : rawOrders ? [rawOrders] : [];

    for (const order of orders as Array<Record<string, unknown>>) {
      const orderId = String(order.OrderID ?? "").trim();
      if (!orderId) continue;

      // Only include orders that have been shipped
      const shippedTime = order.ShippedTime ? String(order.ShippedTime) : undefined;
      if (!shippedTime) continue;

      const buyerUserId = String(order.BuyerUserID ?? "").trim();
      const ta = order.TransactionArray as Record<string, unknown> | undefined;
      const rawTx = ta?.Transaction;
      const transactions = Array.isArray(rawTx) ? rawTx : rawTx ? [rawTx] : [];
      const firstTx = transactions[0] as Record<string, unknown> | undefined;
      const buyer = firstTx?.Buyer as Record<string, unknown> | undefined;
      const buyerName = String(buyer?.UserFirstName ?? "").trim() +
        (buyer?.UserLastName ? ` ${String(buyer.UserLastName).trim()}` : "");
      const item = firstTx?.Item as Record<string, unknown> | undefined;

      results.push({
        orderId,
        buyerUserId: buyerUserId || (buyer?.UserID ? String(buyer.UserID) : ""),
        buyerName: buyerName || String(buyer?.UserID ?? ""),
        itemId: String(item?.ItemID ?? "").trim(),
        itemTitle: String(item?.Title ?? "").trim(),
        shippedTime,
        orderStatus: order.OrderStatus ? String(order.OrderStatus) : undefined,
      });
    }

    const totalPages = Number(
      (root?.PaginationResult as Record<string, unknown>)?.TotalNumberOfPages ?? 1,
    );
    if (pageNumber >= totalPages) break;
    pageNumber++;
  }

  return results;
}

// ΓöÇΓöÇΓöÇ Send eBay message ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface SendMessageResult {
  success: boolean;
  error?: string;
}

export async function sendEbayMessage(
  integrationId: string,
  config: EbayConfig,
  itemId: string,
  recipientId: string,
  subject: string,
  messageBody: string,
): Promise<SendMessageResult> {
  const accessToken = await getEbayAccessToken(integrationId, config);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<AddMemberMessageAAQToPartnerRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${escapeXml(itemId)}</ItemID>
  <MemberMessage>
    <Subject>${escapeXml(subject)}</Subject>
    <Body>${escapeXml(messageBody)}</Body>
    <QuestionType>CustomizedSubject</QuestionType>
    <RecipientID>${escapeXml(recipientId)}</RecipientID>
  </MemberMessage>
</AddMemberMessageAAQToPartnerRequest>`;

  const res = await fetchWithTimeout(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": accessToken,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-CALL-NAME": "AddMemberMessageAAQToPartner",
      "Content-Type": "text/xml",
    },
    body,
  });

  void recordNetworkTransferSample({
    channel: "AUTO_RESPONDER",
    label: `send_message / ${integrationId}`,
    bytesEstimate: Buffer.byteLength(body) + Buffer.byteLength(res.body),
    integrationId,
  });

  if (!res.ok) {
    return { success: false, error: `HTTP ${res.status}` };
  }

  const parsed = parseXmlSimple(res.body);
  const root = parsed.AddMemberMessageAAQToPartnerResponse as Record<string, unknown> | undefined;
  const ack = String(root?.Ack ?? "").trim();

  if (ack === "Success" || ack === "Warning") {
    return { success: true };
  }

  const errors = root?.Errors as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  const errorList = Array.isArray(errors) ? errors : errors ? [errors] : [];
  const errorMessages = errorList
    .map((e) => String(e.LongMessage ?? e.ShortMessage ?? "Unknown error"))
    .join("; ");

  return { success: false, error: errorMessages || `Ack: ${ack}` };
}

// ΓöÇΓöÇΓöÇ Check integration health ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export type IntegrationHealth = "connected" | "degraded" | "disconnected";

export async function checkEbayIntegrationHealth(
  integrationId: string,
  config: EbayConfig,
): Promise<IntegrationHealth> {
  try {
    await getEbayAccessToken(integrationId, config);
    return "connected";
  } catch {
    return "disconnected";
  }
}

// ΓöÇΓöÇΓöÇ Helpers ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
