import { getManageOrderDetail } from "@/lib/manage-orders/ebay";
import { db } from "@/lib/db";
import type { EbayStore, ManageOrder } from "@/lib/manage-orders/types";
import type { LabelFormatterRow, LabelFormatterSourceStore } from "@/lib/label-formatter/types";
import type { Platform } from "@prisma/client";

export type LabelFormatterLookupResult =
  | { status: "found"; order: LabelFormatterRow }
  | { status: "conflict"; matches: LabelFormatterRow[] }
  | { status: "not_found"; errors: Array<{ store: Platform; message: string }> };

const STORE_LOOKUP = [
  { ebayStore: "TPP_EBAY", sourceStore: "EBAY_TPP" },
  { ebayStore: "TT_EBAY", sourceStore: "EBAY_TT" },
] as const satisfies ReadonlyArray<{ ebayStore: EbayStore; sourceStore: LabelFormatterSourceStore }>;

function normalizeOrder(order: ManageOrder, sourceStore: LabelFormatterSourceStore): LabelFormatterRow {
  const address = order.shippingAddress;
  return {
    note: "",
    orderNumber: order.orderId,
    sourceStore,
    buyerName: address?.name ?? order.buyerName ?? order.buyerUsername ?? "",
    addressLine1: address?.street1 ?? "",
    addressLine2: address?.street2 ?? "",
    city: address?.cityName ?? "",
    state: address?.stateOrProvince ?? "",
    zipCode: address?.postalCode ?? order.shippingPostalCode ?? "",
    lineItems: order.lines.map((line) => ({
      sku: line.sku?.trim() || "UNKNOWN_SKU",
      quantity: Math.max(1, Number(line.quantity) || 1),
    })),
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fullName(...parts: Array<unknown>) {
  return parts.map(stringValue).filter(Boolean).join(" ").trim();
}

function lineItemsOrUnknown(items: LabelFormatterRow["lineItems"]) {
  return items.length > 0 ? items : [{ sku: "UNKNOWN_SKU", quantity: 1 }];
}

async function fetchWithTimeout(url: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
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

async function bigCommerceFetchWithRetry(url: string, headers: Record<string, string>) {
  const maxAttempts = 6;
  let result = await fetchWithTimeout(url, { headers });
  for (let attempt = 2; attempt <= maxAttempts && result.status === 429; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(1500 * attempt, 10_000)));
    result = await fetchWithTimeout(url, { headers });
  }
  return result;
}

async function lookupBigCommerceOrder(config: Record<string, unknown>, orderNumber: string) {
  const orderId = numberValue(orderNumber);
  const storeHash = stringValue(config.storeHash);
  const accessToken = stringValue(config.accessToken);
  if (!orderId || orderId <= 0 || !storeHash || !accessToken) return null;

  const headers = { "X-Auth-Token": accessToken, Accept: "application/json" };
  const base = `https://api.bigcommerce.com/stores/${storeHash}`;
  const [orderRes, addressRes, productsRes] = await Promise.all([
    bigCommerceFetchWithRetry(`${base}/v2/orders/${orderId}`, headers),
    bigCommerceFetchWithRetry(`${base}/v2/orders/${orderId}/shipping_addresses`, headers),
    bigCommerceFetchWithRetry(`${base}/v2/orders/${orderId}/products`, headers),
  ]);

  if (orderRes.status === 404) return null;
  if (!orderRes.ok) {
    throw new Error(`BigCommerce order lookup failed (${orderRes.status}).`);
  }

  const order = JSON.parse(orderRes.body) as Record<string, unknown>;
  const addresses = addressRes.ok ? (JSON.parse(addressRes.body) as Array<Record<string, unknown>>) : [];
  const products = productsRes.ok ? (JSON.parse(productsRes.body) as Array<Record<string, unknown>>) : [];
  const shipping = addresses[0];
  const billing = typeof order.billing_address === "object" && order.billing_address
    ? (order.billing_address as Record<string, unknown>)
    : null;
  const address = shipping ?? billing;

  if (!address) {
    throw new Error(`BigCommerce order ${orderNumber} has no shipping address.`);
  }

  const buyerName =
    fullName(address.first_name, address.last_name) ||
    fullName(order.billing_address && typeof order.billing_address === "object" ? (order.billing_address as Record<string, unknown>).first_name : "", order.billing_address && typeof order.billing_address === "object" ? (order.billing_address as Record<string, unknown>).last_name : "") ||
    stringValue(order.customer_message);

  return {
    note: "",
    orderNumber: String(order.id ?? orderNumber),
    sourceStore: "BIGCOMMERCE" as const,
    buyerName,
    addressLine1: stringValue(address.street_1),
    addressLine2: stringValue(address.street_2),
    city: stringValue(address.city),
    state: stringValue(address.state) || stringValue(address.state_iso2),
    zipCode: stringValue(address.zip),
    lineItems: lineItemsOrUnknown(products.map((product) => ({
      sku: stringValue(product.sku) || "UNKNOWN_SKU",
      quantity: Math.max(1, numberValue(product.quantity) ?? 1),
    }))),
  } satisfies LabelFormatterRow;
}

async function shopifyFetch(url: string, accessToken: string) {
  const maxAttempts = 5;
  let attempt = 0;
  while (true) {
    const result = await fetchWithTimeout(url, {
      headers: { "X-Shopify-Access-Token": accessToken, Accept: "application/json" },
    });
    if (result.status !== 429 || attempt >= maxAttempts) return result;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 12_000)));
    attempt++;
  }
}

async function lookupShopifyOrder(config: Record<string, unknown>, orderNumber: string) {
  const storeDomain = stringValue(config.storeDomain);
  const accessToken = stringValue(config.accessToken);
  const apiVersion = stringValue(config.apiVersion) || "2026-01";
  if (!storeDomain || !accessToken) return null;

  const normalizedName = orderNumber.trim().replace(/^#/, "");
  const url = `https://${storeDomain}/admin/api/${apiVersion}/orders.json?name=%23${encodeURIComponent(normalizedName)}&status=any&limit=5`;
  const res = await shopifyFetch(url, accessToken);
  if (!res.ok) {
    throw new Error(`Shopify order lookup failed (${res.status}).`);
  }

  const data = JSON.parse(res.body) as { orders?: Array<Record<string, unknown>> };
  const order = data.orders?.[0];
  if (!order) return null;
  const shipping = typeof order.shipping_address === "object" && order.shipping_address
    ? (order.shipping_address as Record<string, unknown>)
    : null;
  const billing = typeof order.billing_address === "object" && order.billing_address
    ? (order.billing_address as Record<string, unknown>)
    : null;
  const customer = typeof order.customer === "object" && order.customer
    ? (order.customer as Record<string, unknown>)
    : null;
  const address = shipping ?? billing;
  if (!address) {
    throw new Error(`Shopify order ${orderNumber} has no shipping address.`);
  }

  const lineItems = Array.isArray(order.line_items)
    ? (order.line_items as Array<Record<string, unknown>>)
    : [];

  return {
    note: "",
    orderNumber: stringValue(order.name) || `#${normalizedName}`,
    sourceStore: "SHOPIFY" as const,
    buyerName:
      stringValue(address.name) ||
      fullName(address.first_name, address.last_name) ||
      fullName(customer?.first_name, customer?.last_name),
    addressLine1: stringValue(address.address1),
    addressLine2: stringValue(address.address2),
    city: stringValue(address.city),
    state: stringValue(address.province_code) || stringValue(address.province),
    zipCode: stringValue(address.zip),
    lineItems: lineItemsOrUnknown(lineItems.map((line) => ({
      sku: stringValue(line.sku) || "UNKNOWN_SKU",
      quantity: Math.max(1, numberValue(line.quantity) ?? 1),
    }))),
  } satisfies LabelFormatterRow;
}

export async function lookupLabelFormatterOrder(orderNumber: string): Promise<LabelFormatterLookupResult> {
  const trimmed = orderNumber.trim();
  const integrations = await db.integration.findMany({
    where: { platform: { in: ["BIGCOMMERCE", "SHOPIFY"] }, enabled: true },
    select: { platform: true, config: true },
  });
  const byPlatform = new Map(integrations.map((integration) => [integration.platform, integration]));

  const ebaySettled = await Promise.allSettled(
    STORE_LOOKUP.map(async ({ ebayStore, sourceStore }) => {
      const order = await getManageOrderDetail(ebayStore, trimmed);
      return order ? normalizeOrder(order, sourceStore) : null;
    }),
  );
  const commerceLookup = [
    {
      platform: "BIGCOMMERCE" as const,
      run: () => {
        const integration = byPlatform.get("BIGCOMMERCE");
        return integration ? lookupBigCommerceOrder(integration.config as Record<string, unknown>, trimmed) : Promise.resolve(null);
      },
    },
    {
      platform: "SHOPIFY" as const,
      run: () => {
        const integration = byPlatform.get("SHOPIFY");
        return integration ? lookupShopifyOrder(integration.config as Record<string, unknown>, trimmed) : Promise.resolve(null);
      },
    },
  ];
  const commerceSettled = await Promise.allSettled(commerceLookup.map((lookup) => lookup.run()));

  const matches: LabelFormatterRow[] = [];
  const errors: Array<{ store: Platform; message: string }> = [];

  ebaySettled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      if (result.value) matches.push(result.value);
      return;
    }
    const store = STORE_LOOKUP[index]?.ebayStore ?? "TPP_EBAY";
    errors.push({
      store,
      message: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
    console.warn("[label-formatter/lookup] store lookup failed", { store, error: errors.at(-1)?.message });
  });

  commerceSettled.forEach((result, index) => {
    const store = commerceLookup[index]?.platform ?? "BIGCOMMERCE";
    if (result.status === "fulfilled") {
      if (result.value) matches.push(result.value);
      return;
    }
    errors.push({
      store,
      message: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
    console.warn("[label-formatter/lookup] store lookup failed", { store, error: errors.at(-1)?.message });
  });

  if (matches.length === 1) return { status: "found", order: matches[0]! };
  if (matches.length > 1) return { status: "conflict", matches };
  return { status: "not_found", errors };
}
