import { db } from "@/lib/db";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";
import type { Platform } from "@prisma/client";

// ─── eBay Trading API constants (shared with ship-orders) ────────────────────

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const REQUEST_TIMEOUT_MS = 30_000;

// ─── Token registry ──────────────────────────────────────────────────────────

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

// ─── Validation ──────────────────────────────────────────────────────────────

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

// ─── Token rendering ─────────────────────────────────────────────────────────

export interface RenderContext {
  buyerName?: string | null;
  buyerFirstName?: string | null;
  orderId: string;
  itemName?: string | null;
  trackingNumber?: string | null;
  carrier?: string | null;
  storeName: string;
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

  // buyer_first_name: handle "Hi {buyer_first_name}," → "Hi," when name unavailable
  if (firstName) {
    result = result.replace(/\{buyer_first_name\}/g, firstName);
  } else {
    result = result.replace(/\{buyer_first_name\},?\s*/g, "");
    result = result.replace(/\{buyer_first_name\}/g, "");
  }

  return result;
}

// ─── eBay token refresh (reuses ship-orders pattern) ─────────────────────────

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

// ─── XML parser (lightweight, same as ship-orders) ───────────────────────────

function parseXmlSimple(xml: string): Record<string, unknown> {
  // Reuse fast-xml-parser if available, else simple regex extraction.
  // `isArray` forces the listed tags to always parse as arrays so single-
  // element collections (e.g. one ShipmentTrackingDetails) still walk the
  // same code path as multi-element ones — this keeps the tracking lookup
  // code below from having to defensively wrap-or-unwrap on every read.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { XMLParser } = require("fast-xml-parser");
    const parser = new XMLParser({
      ignoreAttributes: true,
      trimValues: true,
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
 * shipped via CompleteSale (which is most of TPP's volume — eDesk picks it
 * up via the same broader walk).
 */
function extractTrackingFromOrder(
  order: Record<string, unknown>,
): { number: string | null; carrier: string | null } {
  const pickFromDetails = (
    raw: unknown,
  ): { number: string | null; carrier: string | null } => {
    if (!raw) return { number: null, carrier: null };
    const arr = Array.isArray(raw) ? raw : [raw];
    for (const td of arr as Array<Record<string, unknown>>) {
      const rawNum = td.ShipmentTrackingNumber;
      let num: string | null = null;
      if (typeof rawNum === "string" && rawNum.trim()) {
        num = rawNum.trim();
      } else if (rawNum && typeof rawNum === "object") {
        const inner = (rawNum as Record<string, unknown>)["#text"];
        if (typeof inner === "string" && inner.trim()) num = inner.trim();
      }
      const carrier = td.ShippingCarrierUsed
        ? String(td.ShippingCarrierUsed)
        : null;
      if (num) return { number: num, carrier };
    }
    return { number: null, carrier: null };
  };

  // 1. Order-level ShippingDetails
  const sd = order.ShippingDetails as Record<string, unknown> | undefined;
  if (sd) {
    const t = pickFromDetails(sd.ShipmentTrackingDetails);
    if (t.number) return t;
  }

  // 2. Order-level ShippingServiceSelected (eBay shipping label path)
  const sss = order.ShippingServiceSelected as Record<string, unknown> | undefined;
  if (sss) {
    const t = pickFromDetails(sss.ShipmentTrackingDetails);
    if (t.number) return t;
  }

  // 3 + 4 + 5. Transaction-level
  const ta = order.TransactionArray as Record<string, unknown> | undefined;
  const rawTx = ta?.Transaction;
  const transactions = Array.isArray(rawTx) ? rawTx : rawTx ? [rawTx] : [];
  for (const tx of transactions as Array<Record<string, unknown>>) {
    const shipment = tx.Shipment as Record<string, unknown> | undefined;
    if (shipment) {
      const t = pickFromDetails(shipment.ShipmentTrackingDetails);
      if (t.number) return t;
    }
    const txSd = tx.ShippingDetails as Record<string, unknown> | undefined;
    if (txSd) {
      const t = pickFromDetails(txSd.ShipmentTrackingDetails);
      if (t.number) return t;
    }
    const txSss = tx.ShippingServiceSelected as Record<string, unknown> | undefined;
    if (txSss) {
      const t = pickFromDetails(txSss.ShipmentTrackingDetails);
      if (t.number) return t;
    }
  }

  return { number: null, carrier: null };
}

// ─── GetOrders enrichment (buyer + item data) ────────────────────────────────

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
    const itemTitle = String(item?.Title ?? "").trim();
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

// ─── Fetch full order context (tracking, address, line items) ───────────────

/**
 * Help-Desk-friendly read of a single eBay order. Pulls tracking number,
 * carrier, shipping address, line items, totals, and dates so the agent's
 * context panel can show everything they'd otherwise have to flip into
 * Seller Hub for. Read-only — never writes back to eBay.
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
   * eBay's Selling Manager Sales Record Number — the "(5149769)" companion
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
  /** Shipping service summary, e.g. "USPS Ground Advantage". */
  shippingService: string | null;
  /** First tracking number found, plus carrier when eBay sent one. */
  trackingNumber: string | null;
  trackingCarrier: string | null;
  /** Total in cents (subtotal + shipping + tax). */
  totalCents: number | null;
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

  if (!res.ok) return null;

  const parsed = parseXmlSimple(res.body);
  const root = parsed.GetOrdersResponse as Record<string, unknown> | undefined;
  const orderArray = root?.OrderArray as Record<string, unknown> | undefined;
  const rawOrders = orderArray?.Order;
  const orders = Array.isArray(rawOrders) ? rawOrders : rawOrders ? [rawOrders] : [];
  if (orders.length === 0) return null;

  const order = orders[0] as Record<string, unknown>;
  const ta = order.TransactionArray as Record<string, unknown> | undefined;
  const rawTx = ta?.Transaction;
  const transactions = Array.isArray(rawTx) ? rawTx : rawTx ? [rawTx] : [];

  const firstTx = transactions[0] as Record<string, unknown> | undefined;
  const buyer = firstTx?.Buyer as Record<string, unknown> | undefined;
  const buyerName =
    String(buyer?.UserFirstName ?? "").trim() +
    (buyer?.UserLastName ? ` ${String(buyer.UserLastName).trim()}` : "");

  // Shipping address — eBay returns it on the order, not per transaction.
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
        // the buyer hasn't authorised contact info exposure — treat that as
        // null so we don't render the literal string in the UI.
        phone: ship.Phone && String(ship.Phone) !== "Invalid Request"
          ? String(ship.Phone)
          : null,
      }
    : null;

  // Tracking — walk all three eBay locations (order shipping details,
  // transaction shipment, transaction shipping details). See
  // `extractTrackingFromOrder` for the precedence rationale.
  const shippingDetails = order.ShippingDetails as Record<string, unknown> | undefined;
  const tracking = extractTrackingFromOrder(order);
  const trackingNumber = tracking.number;
  const trackingCarrier = tracking.carrier;
  // Shipping service — try both the order-level summary and the transaction.
  const shippingServiceSelected = shippingDetails?.ShippingServiceOptions as
    | Record<string, unknown>
    | undefined;
  const shippingService = shippingServiceSelected?.ShippingService
    ? String(shippingServiceSelected.ShippingService)
    : null;

  // Line items
  const lineItems: EbayOrderContextLineItem[] = transactions
    .map((tx) => tx as Record<string, unknown>)
    .map((tx) => {
      const item = tx.Item as Record<string, unknown> | undefined;
      const itemId = item?.ItemID ? String(item.ItemID) : "";
      const title = item?.Title ? String(item.Title) : "";
      const sku = (item?.SKU ?? tx.SKU) ? String(item?.SKU ?? tx.SKU) : null;
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

  // Estimated delivery — multiple eBay shapes; capture both ends if present.
  const ed = order.ShippingServiceSelected as Record<string, unknown> | undefined;
  // eBay also exposes EstimatedDeliveryDateMin/Max on the order itself.
  const estimatedDeliveryMin = order.EstimatedDeliveryDateMin
    ? String(order.EstimatedDeliveryDateMin)
    : ed?.EstimatedDeliveryDateMin
      ? String(ed.EstimatedDeliveryDateMin)
      : null;
  const estimatedDeliveryMax = order.EstimatedDeliveryDateMax
    ? String(order.EstimatedDeliveryDateMax)
    : ed?.EstimatedDeliveryDateMax
      ? String(ed.EstimatedDeliveryDateMax)
      : null;

  const totalCents = parseDollarsToCents(order.Total ?? order.AmountPaid);
  const currency = pickCurrency(order.Total) ?? pickCurrency(order.AmountPaid);

  // Sales Record Number (Selling Manager). Optional — only present when the
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
    shippingService,
    trackingNumber,
    trackingCarrier,
    totalCents,
    currency,
    shippingAddress,
    lineItems,
  };
}

// ─── Fetch recently shipped orders (reconciliation) ──────────────────────────

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

// ─── Send eBay message ───────────────────────────────────────────────────────

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

// ─── Check integration health ────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
