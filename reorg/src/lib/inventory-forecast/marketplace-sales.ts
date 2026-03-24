import { XMLParser } from "fast-xml-parser";
import type { Integration, Platform } from "@prisma/client";
import { db } from "@/lib/db";
import type { ForecastSaleLine, SalesSyncIssue } from "@/lib/inventory-forecast/types";

type EbayIntegrationConfig = {
  appId: string;
  certId: string;
  refreshToken: string;
  environment: "PRODUCTION" | "SANDBOX";
};

type ShopifyIntegrationConfig = {
  storeDomain: string;
  accessToken: string;
  apiVersion: string;
};

type BigCommerceIntegrationConfig = {
  storeHash: string;
  accessToken: string;
};

type IntegrationConfig =
  | EbayIntegrationConfig
  | ShopifyIntegrationConfig
  | BigCommerceIntegrationConfig;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  isArray: (tagName) => {
    const alwaysArray = new Set([
      "Order",
      "Transaction",
      "NameValueList",
      "Variation",
      "OrderLineItemID",
      "Error",
      "Errors",
    ]);
    return alwaysArray.has(tagName);
  },
});

const EBAY_MAX_LOOKBACK_DAYS = 90;
const EBAY_PAGE_CONCURRENCY = 4;
const SHOPIFY_PAGE_LIMIT = 250;
const BIGCOMMERCE_PAGE_LIMIT = 50;
const BIGCOMMERCE_MAX_RETRIES = 3;
const BIGCOMMERCE_RETRY_FALLBACK_MS = 2_000;
type ForecastSalesFetchOptions = {
  signal?: AbortSignal;
};

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") return [value as T];
  return [];
}

function readText(source: unknown, key: string): string | undefined {
  const record = asRecord(source);
  if (!record) return undefined;
  const value = record[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const nested = asRecord(value);
  if (!nested) return undefined;
  const text = nested["#text"];
  if (typeof text === "string") return text;
  if (typeof text === "number" && Number.isFinite(text)) return String(text);
  return undefined;
}

function readNumber(source: unknown, key: string): number | undefined {
  const text = readText(source, key);
  if (text == null) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getEnvConfig(platform: Platform) {
  switch (platform) {
    case "TPP_EBAY":
      return {
        appId: process.env.EBAY_TPP_APP_ID,
        certId: process.env.EBAY_TPP_CERT_ID,
        refreshToken: process.env.EBAY_TPP_REFRESH_TOKEN,
        environment: process.env.EBAY_TPP_ENVIRONMENT ?? "PRODUCTION",
      };
    case "TT_EBAY":
      return {
        appId: process.env.EBAY_TT_APP_ID ?? process.env.EBAY_TPP_APP_ID,
        certId: process.env.EBAY_TT_CERT_ID ?? process.env.EBAY_TPP_CERT_ID,
        refreshToken: process.env.EBAY_TT_REFRESH_TOKEN,
        environment: process.env.EBAY_TT_ENVIRONMENT ?? process.env.EBAY_TPP_ENVIRONMENT ?? "PRODUCTION",
      };
    case "SHOPIFY":
      return {
        storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
        accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
        apiVersion: process.env.SHOPIFY_API_VERSION ?? "2026-01",
      };
    case "BIGCOMMERCE":
      return {
        storeHash: process.env.BIGCOMMERCE_STORE_HASH,
        accessToken: process.env.BIGCOMMERCE_ACCESS_TOKEN,
      };
  }
}

function resolveIntegrationConfig(
  integration: Pick<Integration, "platform" | "config" | "label">,
): IntegrationConfig {
  const rawConfig = asRecord(integration.config) ?? {};
  const envConfig = getEnvConfig(integration.platform);

  switch (integration.platform) {
    case "TPP_EBAY":
    case "TT_EBAY": {
      const appId = getString(rawConfig.appId) ?? getString(envConfig.appId);
      const certId = getString(rawConfig.certId) ?? getString(envConfig.certId);
      const refreshToken =
        getString(rawConfig.refreshToken) ?? getString(envConfig.refreshToken);
      const environment = (getString(rawConfig.environment) ??
        getString(envConfig.environment) ??
        "PRODUCTION") as "PRODUCTION" | "SANDBOX";

      if (!appId || !certId || !refreshToken) {
        throw new Error(`Missing eBay credentials for ${integration.label}.`);
      }

      return { appId, certId, refreshToken, environment };
    }
    case "SHOPIFY": {
      const storeDomain =
        getString(rawConfig.storeDomain) ?? getString(envConfig.storeDomain);
      const accessToken =
        getString(rawConfig.accessToken) ?? getString(envConfig.accessToken);
      const apiVersion =
        getString(rawConfig.apiVersion) ?? getString(envConfig.apiVersion) ?? "2026-01";
      if (!storeDomain || !accessToken) {
        throw new Error("Missing Shopify credentials.");
      }
      return { storeDomain, accessToken, apiVersion };
    }
    case "BIGCOMMERCE": {
      const storeHash =
        getString(rawConfig.storeHash) ?? getString(envConfig.storeHash);
      const accessToken =
        getString(rawConfig.accessToken) ?? getString(envConfig.accessToken);
      if (!storeHash || !accessToken) {
        throw new Error("Missing BigCommerce credentials.");
      }
      return { storeHash, accessToken };
    }
  }
}

function isEbayIntegrationConfig(config: IntegrationConfig): config is EbayIntegrationConfig {
  return "appId" in config;
}

function isShopifyIntegrationConfig(
  config: IntegrationConfig,
): config is ShopifyIntegrationConfig {
  return "storeDomain" in config;
}

function isBigCommerceIntegrationConfig(
  config: IntegrationConfig,
): config is BigCommerceIntegrationConfig {
  return "storeHash" in config;
}

function getBigCommerceRetryDelayMs(response: Response) {
  const resetMs = Number(response.headers.get("X-Rate-Limit-Time-Reset-Ms") ?? "");
  if (Number.isFinite(resetMs) && resetMs > 0) {
    return resetMs;
  }

  const retryAfterRaw = response.headers.get("Retry-After");
  if (!retryAfterRaw) {
    return BIGCOMMERCE_RETRY_FALLBACK_MS;
  }

  const retryAfterSeconds = Number(retryAfterRaw);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  const retryAfterDate = Date.parse(retryAfterRaw);
  if (!Number.isNaN(retryAfterDate)) {
    return Math.max(retryAfterDate - Date.now(), BIGCOMMERCE_RETRY_FALLBACK_MS);
  }

  return BIGCOMMERCE_RETRY_FALLBACK_MS;
}

async function getEbayAccessToken(config: EbayIntegrationConfig) {
  const baseUrl =
    config.environment === "PRODUCTION"
      ? "https://api.ebay.com"
      : "https://api.sandbox.ebay.com";
  const credentials = Buffer.from(`${config.appId}:${config.certId}`).toString("base64");
  const response = await fetch(`${baseUrl}/identity/v1/oauth2/token`, {
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

  if (!response.ok) {
    throw new Error(`eBay token refresh failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { access_token: string };
  return json.access_token;
}

async function fetchEbaySales(
  integration: Pick<Integration, "platform" | "config" | "label">,
  lookbackDays: number,
  options?: ForecastSalesFetchOptions,
): Promise<{ lines: ForecastSaleLine[]; issues: SalesSyncIssue[]; truncated: boolean }> {
  const config = resolveIntegrationConfig(integration);
  if (!isEbayIntegrationConfig(config)) {
    throw new Error(`Invalid eBay config for ${integration.label}.`);
  }

  const issues: SalesSyncIssue[] = [];
  const cappedLookbackDays = Math.min(lookbackDays, EBAY_MAX_LOOKBACK_DAYS);
  const truncated = lookbackDays > EBAY_MAX_LOOKBACK_DAYS;
  if (truncated) {
    issues.push({
      platform: integration.platform,
      level: "warning",
      message: `eBay order history API only supports ${EBAY_MAX_LOOKBACK_DAYS} days per sync window. Older coverage will build forward from saved history.`,
    });
  }

  const token = await getEbayAccessToken(config);
  const tradingUrl =
    config.environment === "PRODUCTION"
      ? "https://api.ebay.com/ws/api.dll"
      : "https://api.sandbox.ebay.com/ws/api.dll";
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - cappedLookbackDays * 24 * 60 * 60 * 1000);
  const lines: ForecastSaleLine[] = [];

  async function fetchOrdersPage(pageNumber: number) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <CreateTimeFrom>${startTime.toISOString()}</CreateTimeFrom>
  <CreateTimeTo>${endTime.toISOString()}</CreateTimeTo>
  <OrderRole>Seller</OrderRole>
  <OrderStatus>All</OrderStatus>
  <Pagination>
    <EntriesPerPage>100</EntriesPerPage>
    <PageNumber>${pageNumber}</PageNumber>
  </Pagination>
</GetOrdersRequest>`;
    const response = await fetch(tradingUrl, {
      method: "POST",
      headers: {
        "X-EBAY-API-IAF-TOKEN": token,
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "1199",
        "X-EBAY-API-CALL-NAME": "GetOrders",
        "Content-Type": "text/xml",
      },
      body,
      signal: options?.signal,
    });
    const xml = await response.text();
    if (!response.ok) {
      throw new Error(`GetOrders failed for ${integration.label}: ${response.status} ${xml.slice(0, 300)}`);
    }
    const parsed = parser.parse(xml);
    const payload = asRecord(parsed?.GetOrdersResponse);
    const errors = asArray<Record<string, unknown>>(payload?.Errors);
    const failure = errors.find(
      (entry) => (readText(entry, "SeverityCode") ?? "Error").toLowerCase() !== "warning",
    );
    if (failure) {
      throw new Error(readText(failure, "LongMessage") ?? "eBay GetOrders failed.");
    }

    return {
      totalPages: Number(readText(payload?.PaginationResult, "TotalNumberOfPages") ?? 1),
      orders: asArray<Record<string, unknown>>(
        payload?.OrderArray ? asRecord(payload.OrderArray)?.Order : [],
      ),
    };
  }

  function appendOrders(orders: Array<Record<string, unknown>>) {
    for (const order of orders) {
      const externalOrderId = readText(order, "OrderID") ?? readText(order, "ExtendedOrderID");
      const orderDateText = readText(order, "CreatedTime") ?? readText(order, "CheckoutStatus.LastModifiedTime");
      const orderDate = orderDateText ? new Date(orderDateText) : null;
      if (!externalOrderId || !orderDate || Number.isNaN(orderDate.getTime())) continue;

      const cancelState = readText(order, "CancelStatus.CancelState") ?? "";
      const orderStatus = readText(order, "OrderStatus") ?? null;
      const isCancelled =
        cancelState.toLowerCase().includes("cancel") ||
        (orderStatus?.toLowerCase().includes("cancel") ?? false);

      const transactionArray = asRecord(order.TransactionArray);
      const transactions = asArray<Record<string, unknown>>(transactionArray?.Transaction);

      for (let index = 0; index < transactions.length; index += 1) {
        const transaction = transactions[index];
        const item = asRecord(transaction.Item);
        const variation = asRecord(transaction.Variation);
        const sku =
          readText(transaction, "SKU") ??
          readText(variation, "SKU") ??
          readText(item, "SKU") ??
          "";
        if (!sku.trim()) continue;
        const quantity = readNumber(transaction, "QuantityPurchased") ?? 0;
        if (quantity <= 0) continue;
        const lineId =
          readText(transaction, "OrderLineItemID") ??
          `${externalOrderId}:${readText(item, "ItemID") ?? "line"}:${index}`;

        lines.push({
          platform: integration.platform,
          externalOrderId,
          externalLineId: lineId,
          orderDate,
          sku,
          title: readText(item, "Title") ?? null,
          quantity,
          platformItemId: readText(item, "ItemID") ?? null,
          platformVariantId: readText(variation, "SKU") ?? readText(transaction, "SKU") ?? null,
          isCancelled,
          isReturn: false,
          rawData: { order, transaction },
        });
      }
    }
  }

  const firstPage = await fetchOrdersPage(1);
  appendOrders(firstPage.orders);

  if (firstPage.totalPages > 1) {
    const remainingPages = Array.from(
      { length: firstPage.totalPages - 1 },
      (_unused, index) => index + 2,
    );

    for (let index = 0; index < remainingPages.length; index += EBAY_PAGE_CONCURRENCY) {
      const batch = remainingPages.slice(index, index + EBAY_PAGE_CONCURRENCY);
      const batchPages = await Promise.all(batch.map((pageNumber) => fetchOrdersPage(pageNumber)));
      for (const page of batchPages) {
        appendOrders(page.orders);
      }
    }
  }

  return { lines, issues, truncated };
}

async function fetchShopifySales(
  integration: Pick<Integration, "platform" | "config" | "label">,
  lookbackDays: number,
  options?: ForecastSalesFetchOptions,
): Promise<{ lines: ForecastSaleLine[]; issues: SalesSyncIssue[]; truncated: boolean }> {
  const config = resolveIntegrationConfig(integration);
  if (!isShopifyIntegrationConfig(config)) {
    throw new Error("Invalid Shopify config.");
  }

  const minDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const baseUrl = `https://${config.storeDomain}/admin/api/${config.apiVersion}`;
  const lines: ForecastSaleLine[] = [];
  let nextUrl = `${baseUrl}/orders.json?status=any&limit=${SHOPIFY_PAGE_LIMIT}&order=created_at%20asc&created_at_min=${encodeURIComponent(minDate)}&fields=id,created_at,cancelled_at,updated_at,line_items`;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        "X-Shopify-Access-Token": config.accessToken,
        Accept: "application/json",
      },
      signal: options?.signal,
    });

    if (!response.ok) {
      throw new Error(`Shopify orders fetch failed: ${response.status} ${await response.text()}`);
    }

    const json = (await response.json()) as {
      orders?: Array<Record<string, unknown>>;
    };
    const orders = json.orders ?? [];
    for (const order of orders) {
      const externalOrderId = String(order.id ?? "");
      const orderDate = new Date(String(order.created_at ?? ""));
      if (!externalOrderId || Number.isNaN(orderDate.getTime())) continue;
      const cancelledAt = getString(order.cancelled_at);
      const isCancelled = Boolean(cancelledAt);
      const lineItems = asArray<Record<string, unknown>>(order.line_items);
      for (let index = 0; index < lineItems.length; index += 1) {
        const lineItem = lineItems[index];
        const sku = getString(lineItem.sku) ?? "";
        const quantity = Number(lineItem.quantity ?? 0);
        if (!sku.trim() || quantity <= 0) continue;
        lines.push({
          platform: integration.platform,
          externalOrderId,
          externalLineId: String(lineItem.id ?? `${externalOrderId}:${index}`),
          orderDate,
          sku,
          title: getString(lineItem.title) ?? null,
          quantity,
          platformItemId: lineItem.product_id != null ? String(lineItem.product_id) : null,
          platformVariantId: lineItem.variant_id != null ? String(lineItem.variant_id) : null,
          isCancelled,
          isReturn: false,
          rawData: { order, lineItem },
        });
      }
    }

    const linkHeader = response.headers.get("Link") ?? "";
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : "";
  }

  return { lines, issues: [], truncated: false };
}

async function fetchBigCommerceOrderProducts(
  storeHash: string,
  accessToken: string,
  orderId: number,
  options?: ForecastSalesFetchOptions,
) {
  for (let attempt = 0; attempt <= BIGCOMMERCE_MAX_RETRIES; attempt += 1) {
    const response = await fetch(
      `https://api.bigcommerce.com/stores/${storeHash}/v2/orders/${orderId}/products`,
      {
        headers: {
          "X-Auth-Token": accessToken,
          Accept: "application/json",
        },
        signal: options?.signal,
      },
    );

    if (response.status === 429 && attempt < BIGCOMMERCE_MAX_RETRIES) {
      await sleep(getBigCommerceRetryDelayMs(response));
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `BigCommerce order products failed: ${response.status} ${await response.text()}`,
      );
    }

    return (await response.json()) as Array<Record<string, unknown>>;
  }

  throw new Error("BigCommerce order products failed after retry attempts.");
}

async function fetchBigCommerceSales(
  integration: Pick<Integration, "platform" | "config" | "label">,
  lookbackDays: number,
  options?: ForecastSalesFetchOptions,
): Promise<{ lines: ForecastSaleLine[]; issues: SalesSyncIssue[]; truncated: boolean }> {
  const config = resolveIntegrationConfig(integration);
  if (!isBigCommerceIntegrationConfig(config)) {
    throw new Error("Invalid BigCommerce config.");
  }

  const minDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const lines: ForecastSaleLine[] = [];
  let page = 1;
  let keepGoing = true;

  while (keepGoing) {
    let ordersResponse: Response | null = null;
    for (let attempt = 0; attempt <= BIGCOMMERCE_MAX_RETRIES; attempt += 1) {
      const response = await fetch(
        `https://api.bigcommerce.com/stores/${config.storeHash}/v2/orders?min_date_created=${encodeURIComponent(minDate)}&page=${page}&limit=${BIGCOMMERCE_PAGE_LIMIT}&sort=date_created:asc`,
        {
          headers: {
            "X-Auth-Token": config.accessToken,
            Accept: "application/json",
          },
          signal: options?.signal,
        },
      );

      if (response.status === 429 && attempt < BIGCOMMERCE_MAX_RETRIES) {
        await sleep(getBigCommerceRetryDelayMs(response));
        continue;
      }

      ordersResponse = response;
      break;
    }

    if (!ordersResponse) {
      throw new Error("BigCommerce orders fetch failed after retry attempts.");
    }

    if (!ordersResponse.ok) {
      throw new Error(
        `BigCommerce orders fetch failed: ${ordersResponse.status} ${await ordersResponse.text()}`,
      );
    }

    const orders = (await ordersResponse.json()) as Array<Record<string, unknown>>;
    keepGoing = orders.length === BIGCOMMERCE_PAGE_LIMIT;

    for (const order of orders) {
      const orderId = Number(order.id ?? 0);
      const orderDate = new Date(String(order.date_created ?? ""));
      if (!Number.isFinite(orderId) || Number.isNaN(orderDate.getTime())) continue;
      const statusLabel = getString(order.status) ?? "";
      const isCancelled = statusLabel.toLowerCase().includes("cancel");
      const products = await fetchBigCommerceOrderProducts(
        config.storeHash,
        config.accessToken,
        orderId,
        options,
      );
      for (let index = 0; index < products.length; index += 1) {
        const product = products[index];
        const sku = getString(product.sku) ?? "";
        const quantity = Number(product.quantity ?? 0);
        if (!sku.trim() || quantity <= 0) continue;
        lines.push({
          platform: integration.platform,
          externalOrderId: String(orderId),
          externalLineId: String(product.id ?? `${orderId}:${index}`),
          orderDate,
          sku,
          title: getString(product.name) ?? null,
          quantity,
          platformItemId: product.product_id != null ? String(product.product_id) : null,
          platformVariantId: product.product_options != null ? String(product.variant_id ?? "") || null : null,
          isCancelled,
          isReturn: false,
          rawData: { order, product },
        });
      }
    }

    page += 1;
  }

  return { lines, issues: [], truncated: false };
}

export async function fetchMarketplaceSales(
  integration: Pick<Integration, "platform" | "config" | "label">,
  lookbackDays: number,
  options?: ForecastSalesFetchOptions,
) {
  switch (integration.platform) {
    case "TPP_EBAY":
    case "TT_EBAY":
      return fetchEbaySales(integration, lookbackDays, options);
    case "SHOPIFY":
      return fetchShopifySales(integration, lookbackDays, options);
    case "BIGCOMMERCE":
      return fetchBigCommerceSales(integration, lookbackDays, options);
    default:
      return { lines: [], issues: [], truncated: false };
  }
}

export async function getEnabledForecastIntegrations() {
  return db.integration.findMany({
    where: {
      enabled: true,
      platform: {
        in: ["TPP_EBAY", "TT_EBAY", "SHOPIFY", "BIGCOMMERCE"],
      },
    },
    select: {
      id: true,
      platform: true,
      label: true,
      config: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  });
}
