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

interface EbayConfig {
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
  // Reuse fast-xml-parser if available, else simple regex extraction
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { XMLParser } = require("fast-xml-parser");
    const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
    return parser.parse(xml) as Record<string, unknown>;
  } catch {
    return {};
  }
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
