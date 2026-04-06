import { XMLParser } from "fast-xml-parser";
import type { Integration, Platform } from "@prisma/client";
import { createHash, createHmac } from "crypto";
import type {
  ForecastSaleLine,
  RevenueFinancialEventInput,
} from "@/lib/inventory-forecast/types";
import type { RevenueSourceSummary, RevenueSyncStageSummary } from "@/lib/revenue";
import { addMarketplaceInboundBytes } from "@/lib/server/marketplace-telemetry";

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

export type RevenueFetchOptions = {
  signal?: AbortSignal;
  onSyncStagesChange?: (stages: RevenueSyncStageSummary[]) => Promise<void> | void;
};

export type RevenueFetchResult = {
  lines: ForecastSaleLine[];
  financialEvents: RevenueFinancialEventInput[];
  exactSummary: RevenueSourceSummary | null;
  syncStages: RevenueSyncStageSummary[];
  warnings: string[];
};

type RevenueIntegration = Pick<Integration, "id" | "platform" | "config" | "label">;

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
      "Fee",
      "TaxLine",
      "ShippingServiceOptions",
    ]);
    return alwaysArray.has(tagName);
  },
});

const EBAY_ORDER_PAGE_CONCURRENCY = 8;
const EBAY_FINANCE_PAGE_CONCURRENCY = 8;
const EBAY_TRANSIENT_RETRY_ATTEMPTS = 3;
const EBAY_TRANSIENT_RETRY_DELAY_MS = 1_500;
const SHOPIFY_PAGE_LIMIT = 250;
const BIGCOMMERCE_PAGE_LIMIT = 250;
const BIGCOMMERCE_MAX_RETRIES = 3;
const BIGCOMMERCE_RETRY_FALLBACK_MS = 2_000;
const BIGCOMMERCE_PRODUCT_CONCURRENCY = 5;

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryEbayResponse(status: number) {
  return status === 429 || status >= 500;
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

function pickNestedAmount(value: unknown): number | null {
  const record = asRecord(value);
  if (!record) return getNumber(value);
  return (
    getNumber(record.amount) ??
    getNumber(asRecord(record.shop_money)?.amount) ??
    getNumber(asRecord(record.presentment_money)?.amount) ??
    getNumber(record.value) ??
    null
  );
}

function nonEmptyString(...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function readTrackedText(response: Response): Promise<string> {
  const text = await response.text();
  addMarketplaceInboundBytes(Buffer.byteLength(text, "utf8"));
  return text;
}

async function readTrackedJson<T>(response: Response): Promise<T> {
  const text = await readTrackedText(response);
  return JSON.parse(text) as T;
}

function buildSyncStages(keys: Array<{ key: string; label: string }>): MutableRevenueStage[] {
  return keys.map((entry) => ({
    key: entry.key,
    label: entry.label,
    status: "PENDING",
    detail: null,
    updatedAt: null,
  }));
}

function snapshotSyncStages(stages: MutableRevenueStage[]): RevenueSyncStageSummary[] {
  return stages.map((stage) => ({ ...stage }));
}

async function updateSyncStage(
  stages: MutableRevenueStage[],
  key: string,
  status: MutableRevenueStage["status"],
  detail?: string | null,
  options?: RevenueFetchOptions,
) {
  const stage = stages.find((entry) => entry.key === key);
  if (!stage) return;
  stage.status = status;
  stage.detail = detail ?? null;
  stage.updatedAt = new Date().toISOString();
  await options?.onSyncStagesChange?.(snapshotSyncStages(stages));
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
    case "AMAZON":
      return {};
  }
}

function resolveIntegrationConfig(integration: RevenueIntegration): IntegrationConfig {
  const rawConfig = asRecord(integration.config) ?? {};
  const envConfig = getEnvConfig(integration.platform) as Record<string, unknown>;

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
    case "AMAZON":
      throw new Error("Amazon does not support revenue sync in v1.");
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
    throw new Error(`eBay token refresh failed: ${response.status} ${await readTrackedText(response)}`);
  }

  const json = await readTrackedJson<{ access_token: string }>(response);
  return json.access_token;
}

type EbayFinanceLineSummary = {
  feeBasisAmount: number | null;
  marketplaceFeeAmount: number | null;
  advertisingFeeAmount: number | null;
  otherFeeAmount: number | null;
  raw: Record<string, unknown>;
};

type EbayFinanceOrderSummary = {
  buyerIdentifier: string | null;
  buyerDisplayLabel: string | null;
  orderGrossRevenueAmount: number;
  orderTaxCollectedAmount: number;
  currencyCode: string | null;
  lineFees: Map<string, EbayFinanceLineSummary>;
};

type MutableRevenueStage = RevenueSyncStageSummary;

function classifyEbayFeeType(
  feeType: string | null,
  feeTypeDescription?: string | null,
  hasOrderOrListingAssociation = false,
) {
  const normalized = `${feeType ?? ""} ${feeTypeDescription ?? ""}`.toUpperCase();

  if (
    normalized.includes("PROMOTED") ||
    normalized.includes("ADS EXPRESS") ||
    normalized.includes("OFFSITE") ||
    normalized.includes("ADVERT")
  ) {
    return "ADVERTISING_FEE" as const;
  }

  if (normalized.includes("LABEL") || normalized.includes("POSTAGE")) {
    return "SHIPPING_LABEL" as const;
  }

  if (normalized.includes("CREDIT")) {
    return "CREDIT" as const;
  }

  if (
    normalized.includes("STORE SUBSCRIPTION") ||
    normalized.includes("SUBSCRIPTION") ||
    normalized.includes("ACCOUNT") ||
    normalized.includes("STORE") ||
    (!hasOrderOrListingAssociation && normalized.includes("NON SALE"))
  ) {
    return "ACCOUNT_LEVEL_FEE" as const;
  }

  if (
    normalized.includes("FINAL VALUE") ||
    normalized.includes("INSERTION") ||
    normalized.includes("UPGRADE") ||
    normalized.includes("INTERNATIONAL") ||
    normalized.includes("REGULATORY") ||
    normalized.includes("PER_ORDER")
  ) {
    return "MARKETPLACE_FEE" as const;
  }

  return hasOrderOrListingAssociation ? ("MARKETPLACE_FEE" as const) : ("OTHER" as const);
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

async function fetchEbayFinanceTransactions(
  token: string,
  config: EbayIntegrationConfig,
  from: Date,
  to: Date,
  options?: RevenueFetchOptions,
) {
  const baseUrl =
    config.environment === "PRODUCTION"
      ? "https://apiz.ebay.com"
      : "https://apiz.sandbox.ebay.com";
  const limit = 200;
  const fetchPage = async (offset: number) => {
    const url = new URL(`${baseUrl}/sell/finances/v1/transaction`);
    url.searchParams.set("filter", `transactionDate:[${from.toISOString()}..${to.toISOString()}]`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      signal: options?.signal,
    });

    if (!response.ok) {
      throw new Error(
        `eBay finances fetch failed: ${response.status} ${await readTrackedText(response)}`,
      );
    }

    const json = await readTrackedJson<{
      transactions?: Array<Record<string, unknown>>;
      total?: number;
    }>(response);
    return {
      batch: json.transactions ?? [],
      total: Number(json.total ?? 0),
    };
  };

  const firstPage = await fetchPage(0);
  const transactions = [...firstPage.batch];
  const total = Number.isFinite(firstPage.total) && firstPage.total > 0 ? firstPage.total : null;

  if (total != null && total > firstPage.batch.length) {
    const offsets: number[] = [];
    for (let offset = limit; offset < total; offset += limit) {
      offsets.push(offset);
    }
    for (let index = 0; index < offsets.length; index += EBAY_FINANCE_PAGE_CONCURRENCY) {
      const batchOffsets = offsets.slice(index, index + EBAY_FINANCE_PAGE_CONCURRENCY);
      const pages = await Promise.all(batchOffsets.map((offset) => fetchPage(offset)));
      for (const page of pages) {
        transactions.push(...page.batch);
      }
    }
    return transactions;
  }

  let offset = firstPage.batch.length;
  let lastBatchLength = firstPage.batch.length;
  while (lastBatchLength === limit && offset > 0) {
    const page = await fetchPage(offset);
    if (page.batch.length === 0) break;
    transactions.push(...page.batch);
    offset += page.batch.length;
    lastBatchLength = page.batch.length;
  }

  return transactions;
}

async function fetchEbayBillingActivities(
  token: string,
  config: EbayIntegrationConfig,
  from: Date,
  to: Date,
  options?: RevenueFetchOptions,
) {
  const baseUrl =
    config.environment === "PRODUCTION"
      ? "https://api.ebay.com"
      : "https://api.sandbox.ebay.com";
  const limit = 200;
  const fetchPage = async (offset: number) => {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < EBAY_TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
      const url = new URL(`${baseUrl}/sell/finances/v1/billing_activity`);
      url.searchParams.set("filter", `transactionDate:[${from.toISOString()}..${to.toISOString()}]`);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("sort", "transactionDate");

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
        signal: options?.signal,
      });

      if (response.ok) {
        const json = await readTrackedJson<{
          billingActivities?: Array<Record<string, unknown>>;
          total?: number;
          limit?: number;
        }>(response);
        return {
          batch: json.billingActivities ?? [],
          total: Number(json.total ?? 0),
        };
      }

      const body = await readTrackedText(response);
      lastError = new Error(`eBay billing activity fetch failed: ${response.status} ${body}`);
      if (!shouldRetryEbayResponse(response.status) || attempt === EBAY_TRANSIENT_RETRY_ATTEMPTS - 1) {
        throw lastError;
      }
      await sleep(EBAY_TRANSIENT_RETRY_DELAY_MS * (attempt + 1));
    }

    throw lastError ?? new Error("eBay billing activity fetch failed.");
  };

  const firstPage = await fetchPage(0);
  const billingActivities = [...firstPage.batch];
  const total = Number.isFinite(firstPage.total) && firstPage.total > 0 ? firstPage.total : null;

  if (total != null && total > firstPage.batch.length) {
    const offsets: number[] = [];
    for (let offset = limit; offset < total; offset += limit) {
      offsets.push(offset);
    }
    for (let index = 0; index < offsets.length; index += EBAY_FINANCE_PAGE_CONCURRENCY) {
      const batchOffsets = offsets.slice(index, index + EBAY_FINANCE_PAGE_CONCURRENCY);
      const pages = await Promise.all(batchOffsets.map((offset) => fetchPage(offset)));
      for (const page of pages) {
        billingActivities.push(...page.batch);
      }
    }
    return billingActivities;
  }

  let offset = firstPage.batch.length;
  let lastBatchLength = firstPage.batch.length;
  while (lastBatchLength === limit && offset > 0) {
    const page = await fetchPage(offset);
    if (page.batch.length === 0) break;
    billingActivities.push(...page.batch);
    offset += page.batch.length;
    lastBatchLength = page.batch.length;
  }

  return billingActivities;
}

async function fetchEbayTransactionSummary(
  token: string,
  config: EbayIntegrationConfig,
  from: Date,
  to: Date,
  options?: RevenueFetchOptions,
) {
  const baseUrl =
    config.environment === "PRODUCTION"
      ? "https://apiz.ebay.com"
      : "https://apiz.sandbox.ebay.com";
  const url = new URL(`${baseUrl}/sell/finances/v1/transaction_summary`);
  url.searchParams.append("filter", "transactionStatus:{PAYOUT}");
  url.searchParams.append("filter", `transactionDate:[${from.toISOString()}..${to.toISOString()}]`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new Error(
      `eBay transaction summary fetch failed: ${response.status} ${await readTrackedText(response)}`,
    );
  }

  return await readTrackedJson<Record<string, unknown>>(response);
}

async function fetchEbayOrders(
  token: string,
  config: EbayIntegrationConfig,
  from: Date,
  to: Date,
  options?: RevenueFetchOptions,
) {
  const tradingUrl =
    config.environment === "PRODUCTION"
      ? "https://api.ebay.com/ws/api.dll"
      : "https://api.sandbox.ebay.com/ws/api.dll";

  async function fetchOrdersPage(pageNumber: number) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <CreateTimeFrom>${from.toISOString()}</CreateTimeFrom>
  <CreateTimeTo>${to.toISOString()}</CreateTimeTo>
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
    const xml = await readTrackedText(response);
    if (!response.ok) {
      throw new Error(`GetOrders failed for eBay: ${response.status} ${xml.slice(0, 300)}`);
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

  const firstPage = await fetchOrdersPage(1);
  const orders = [...firstPage.orders];
  if (firstPage.totalPages > 1) {
    const remainingPages = Array.from(
      { length: firstPage.totalPages - 1 },
      (_unused, index) => index + 2,
    );
    for (let index = 0; index < remainingPages.length; index += EBAY_ORDER_PAGE_CONCURRENCY) {
      const batch = remainingPages.slice(index, index + EBAY_ORDER_PAGE_CONCURRENCY);
      const pages = await Promise.all(batch.map((pageNumber) => fetchOrdersPage(pageNumber)));
      for (const page of pages) {
        orders.push(...page.orders);
      }
    }
  }

  return orders;
}

function buildEbayFinanceMap(transactions: Array<Record<string, unknown>>) {
  const financeByOrder = new Map<string, EbayFinanceOrderSummary>();

  for (const transaction of transactions) {
    if (getString(transaction.transactionType) !== "SALE") continue;
    const orderId = nonEmptyString(
      getString(transaction.orderId),
      getString(transaction.salesRecordReference),
    );
    if (!orderId) continue;
    const summary =
      financeByOrder.get(orderId) ??
      {
        buyerIdentifier: nonEmptyString(
          getString(asRecord(transaction.buyer)?.username),
          getString(asRecord(transaction.buyer)?.userId),
        ),
        buyerDisplayLabel: nonEmptyString(getString(asRecord(transaction.buyer)?.username)),
        orderGrossRevenueAmount: 0,
        orderTaxCollectedAmount: 0,
        currencyCode:
          getString(asRecord(transaction.totalFeeBasisAmount)?.currency) ??
          getString(asRecord(transaction.amount)?.currency) ??
          "USD",
        lineFees: new Map<string, EbayFinanceLineSummary>(),
      };

    const basisAmount =
      getNumber(asRecord(transaction.totalFeeBasisAmount)?.value) ??
      getNumber(asRecord(transaction.amount)?.value) ??
      0;
    const ebayCollectedTaxAmount =
      getNumber(asRecord(transaction.ebayCollectedTaxAmount)?.value) ?? 0;
    summary.orderGrossRevenueAmount += basisAmount + ebayCollectedTaxAmount;
    summary.orderTaxCollectedAmount += ebayCollectedTaxAmount;

    const orderLineItems = asArray<Record<string, unknown>>(transaction.orderLineItems);
    for (const lineItem of orderLineItems) {
      const lineItemId = nonEmptyString(
        getString(lineItem.lineItemId),
        getString(lineItem.orderLineItemId),
      );
      if (!lineItemId) continue;

      let marketplaceFeeAmount = 0;
      let advertisingFeeAmount = 0;
      let otherFeeAmount = 0;
      const marketplaceFees = asArray<Record<string, unknown>>(lineItem.marketplaceFees);

      for (const fee of marketplaceFees) {
        const amount =
          pickNestedAmount(fee.amount) ??
          pickNestedAmount(fee.convertedFromAmount) ??
          getNumber(fee.value) ??
          0;
        const classification = classifyEbayFeeType(getString(fee.feeType) ?? null, null, true);
        if (classification === "ADVERTISING_FEE") {
          advertisingFeeAmount += amount;
        } else if (
          classification === "SHIPPING_LABEL" ||
          classification === "ACCOUNT_LEVEL_FEE" ||
          classification === "OTHER" ||
          classification === "CREDIT"
        ) {
          otherFeeAmount += amount;
        } else {
          marketplaceFeeAmount += amount;
        }
      }

      summary.lineFees.set(lineItemId, {
        feeBasisAmount:
          pickNestedAmount(lineItem.feeBasisAmount) ??
          getNumber(lineItem.feeBasisAmount) ??
          null,
        marketplaceFeeAmount: marketplaceFees.length ? marketplaceFeeAmount : null,
        advertisingFeeAmount: marketplaceFees.length ? advertisingFeeAmount : null,
        otherFeeAmount: marketplaceFees.length ? otherFeeAmount : null,
        raw: {
          transactionId: getString(transaction.transactionId) ?? null,
          feeCount: marketplaceFees.length,
          marketplaceFees,
        },
      });
    }

    financeByOrder.set(orderId, summary);
  }

  return financeByOrder;
}

async function fetchEbayRevenue(
  integration: RevenueIntegration,
  from: Date,
  to: Date,
  options?: RevenueFetchOptions,
): Promise<RevenueFetchResult> {
  const config = resolveIntegrationConfig(integration);
  if (!isEbayIntegrationConfig(config)) {
    throw new Error(`Invalid eBay config for ${integration.label}.`);
  }

  const syncStages = buildSyncStages([
    { key: "token", label: "Token Refresh" },
    { key: "transactions", label: "Transactions" },
    { key: "orders", label: "Orders" },
    { key: "billing", label: "Billing Activities" },
    { key: "summary", label: "Transaction Summary" },
  ]);
  const warnings: string[] = [];

  await updateSyncStage(syncStages, "token", "RUNNING", "Refreshing eBay access token.", options);
  const token = await getEbayAccessToken(config);
  await updateSyncStage(syncStages, "token", "COMPLETED", "eBay access token refreshed.", options);

  await updateSyncStage(syncStages, "transactions", "RUNNING", "Pulling eBay transaction revenue.", options);
  await updateSyncStage(syncStages, "orders", "RUNNING", "Pulling eBay order metadata.", options);
  const [transactions, orders] = await Promise.all([
    fetchEbayFinanceTransactions(token, config, from, to, options),
    fetchEbayOrders(token, config, from, to, options),
  ]);
  await updateSyncStage(
    syncStages,
    "transactions",
    "COMPLETED",
    `${transactions.length.toLocaleString()} finance transactions fetched.`,
    options,
  );
  await updateSyncStage(
    syncStages,
    "orders",
    "COMPLETED",
    `${orders.length.toLocaleString()} orders fetched.`,
    options,
  );

  let billingActivities: Array<Record<string, unknown>> = [];
  await updateSyncStage(syncStages, "billing", "RUNNING", "Pulling billing activities.", options);
  try {
    billingActivities = await fetchEbayBillingActivities(token, config, from, to, options);
    await updateSyncStage(
      syncStages,
      "billing",
      "COMPLETED",
      `${billingActivities.length.toLocaleString()} billing activities fetched.`,
      options,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Billing activity fetch failed.";
    await updateSyncStage(
      syncStages,
      "billing",
      "FAILED",
      `Optional feed unavailable. ${message}`,
      options,
    );
  }

  let transactionSummary: Record<string, unknown> | null = null;
  await updateSyncStage(syncStages, "summary", "RUNNING", "Pulling transaction summary.", options);
  try {
    transactionSummary = await fetchEbayTransactionSummary(token, config, from, to, options);
    await updateSyncStage(syncStages, "summary", "COMPLETED", "Transaction summary fetched.", options);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Transaction summary fetch failed.";
    warnings.push(message);
    await updateSyncStage(syncStages, "summary", "FAILED", message, options);
  }

  const financeByOrder = buildEbayFinanceMap(transactions);
  const lines: ForecastSaleLine[] = [];
  const financialEvents: RevenueFinancialEventInput[] = [];

  for (const transaction of transactions) {
    const transactionId = getString(transaction.transactionId);
    const occurredAtText = getString(transaction.transactionDate);
    const orderId = nonEmptyString(
      getString(transaction.orderId),
      getString(transaction.salesRecordReference),
    );
    const occurredAt = occurredAtText ? new Date(occurredAtText) : null;
    if (!transactionId || !occurredAt || Number.isNaN(occurredAt.getTime())) continue;

    const transactionType = getString(transaction.transactionType) ?? "UNKNOWN";
    const basisAmount =
      pickNestedAmount(transaction.totalFeeBasisAmount) ??
      pickNestedAmount(transaction.amount) ??
      0;
    const taxCollectedAmount = pickNestedAmount(transaction.ebayCollectedTaxAmount) ?? 0;
    const grossRevenueAmount = basisAmount + taxCollectedAmount;
    const totalFeeAmount = pickNestedAmount(transaction.totalFeeAmount) ?? 0;
    const currencyCode =
      getString(asRecord(transaction.totalFeeBasisAmount)?.currency) ??
      getString(asRecord(transaction.amount)?.currency) ??
      "USD";

    if (transactionType === "SALE" && grossRevenueAmount > 0) {
      financialEvents.push({
        integrationId: integration.id,
        platform: integration.platform,
        eventType: "TRANSACTION",
        classification: "SALE",
        externalEventId: `${transactionId}:sale`,
        externalOrderId: orderId,
        occurredAt,
        amount: grossRevenueAmount,
        currencyCode,
        bookingEntry: getString(transaction.bookingEntry) ?? null,
        rawData: transaction,
      });
    }

    if (transactionType === "SALE" && taxCollectedAmount > 0) {
      financialEvents.push({
        integrationId: integration.id,
        platform: integration.platform,
        eventType: "TRANSACTION",
        classification: "TAX",
        externalEventId: `${transactionId}:tax`,
        externalOrderId: orderId,
        occurredAt,
        amount: taxCollectedAmount,
        currencyCode,
        bookingEntry: getString(transaction.bookingEntry) ?? null,
        rawData: transaction,
      });
    }

    if (transactionType === "SALE" && totalFeeAmount > 0) {
      financialEvents.push({
        integrationId: integration.id,
        platform: integration.platform,
        eventType: "TRANSACTION",
        classification: "MARKETPLACE_FEE",
        externalEventId: `${transactionId}:sale-fee`,
        externalOrderId: orderId,
        occurredAt,
        amount: totalFeeAmount,
        currencyCode,
        bookingEntry: getString(transaction.bookingEntry) ?? null,
        rawData: transaction,
      });
      continue;
    }

    if (transactionType === "NON_SALE_CHARGE") {
      const bookingEntry = getString(transaction.bookingEntry) ?? "DEBIT";
      const amount = pickNestedAmount(transaction.amount) ?? 0;
      const signedAmount = bookingEntry === "CREDIT" ? -amount : amount;
      const classification = classifyEbayFeeType(
        getString(transaction.feeType) ?? null,
        getString(transaction.transactionMemo) ?? null,
        Boolean(orderId),
      );

      financialEvents.push({
        integrationId: integration.id,
        platform: integration.platform,
        eventType: "TRANSACTION",
        classification,
        externalEventId: `${transactionId}:non-sale-charge`,
        externalOrderId: orderId,
        occurredAt,
        amount: signedAmount,
        currencyCode,
        feeType: getString(transaction.feeType) ?? null,
        feeTypeDescription: getString(transaction.transactionMemo) ?? null,
        bookingEntry,
        rawData: transaction,
      });
      continue;
    }

    if (transactionType === "CREDIT" || transactionType === "REFUND" || transactionType === "DISPUTE") {
      const bookingEntry = getString(transaction.bookingEntry) ?? "DEBIT";
      const amount = pickNestedAmount(transaction.amount) ?? 0;
      const signedAmount = bookingEntry === "CREDIT" ? -amount : amount;
      financialEvents.push({
        integrationId: integration.id,
        platform: integration.platform,
        eventType: "TRANSACTION",
        classification: transactionType === "CREDIT" ? "CREDIT" : "OTHER",
        externalEventId: `${transactionId}:${transactionType.toLowerCase()}`,
        externalOrderId: orderId,
        occurredAt,
        amount: signedAmount,
        currencyCode,
        bookingEntry,
        rawData: transaction,
      });
    }
  }

  for (const order of orders) {
    const externalOrderId = nonEmptyString(
      readText(order, "OrderID"),
      readText(order, "ExtendedOrderID"),
    );
    const orderDateText =
      readText(order, "CreatedTime") ?? readText(order, "CheckoutStatus.LastModifiedTime");
    const orderDate = orderDateText ? new Date(orderDateText) : null;
    if (!externalOrderId || !orderDate || Number.isNaN(orderDate.getTime())) continue;

    const cancelState = readText(order, "CancelStatus.CancelState") ?? "";
    const orderStatus = readText(order, "OrderStatus") ?? null;
    const isCancelled =
      cancelState.toLowerCase().includes("cancel") ||
      (orderStatus?.toLowerCase().includes("cancel") ?? false);

    const transactionArray = asRecord(order.TransactionArray);
    const transactionsForOrder = asArray<Record<string, unknown>>(transactionArray?.Transaction);
    const financeSummary = financeByOrder.get(externalOrderId);
    const buyerIdentifier = nonEmptyString(
      readText(order, "BuyerUserID"),
      readText(order, "Buyer.UserID"),
      financeSummary?.buyerIdentifier,
    );

    for (let index = 0; index < transactionsForOrder.length; index += 1) {
      const transaction = transactionsForOrder[index];
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

      const unitPriceAmount =
        readNumber(transaction, "TransactionPrice") ??
        readNumber(transaction, "AmountPaid") ??
        null;
      const grossRevenueAmount =
        financeSummary?.lineFees.get(lineId)?.feeBasisAmount ??
        (unitPriceAmount != null ? unitPriceAmount * quantity : readNumber(order, "Subtotal") ?? null);
      const financeLine = financeSummary?.lineFees.get(lineId);
      const marketplaceFeeAmount = financeLine?.marketplaceFeeAmount ?? null;
      const advertisingFeeAmount = financeLine?.advertisingFeeAmount ?? null;
      const otherFeeAmount = financeLine?.otherFeeAmount ?? null;
      const netRevenueAmount =
        grossRevenueAmount != null && marketplaceFeeAmount != null && advertisingFeeAmount != null
          ? grossRevenueAmount - marketplaceFeeAmount - advertisingFeeAmount
          : null;

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
        orderStatus,
        cancelledAt: isCancelled ? orderDate : null,
        currencyCode: "USD",
        unitPriceAmount,
        grossRevenueAmount,
        marketplaceFeeAmount,
        advertisingFeeAmount,
        otherFeeAmount,
        taxAmount: null,
        shippingAmount: null,
        netRevenueAmount,
        orderGrossRevenueAmount:
          financeSummary?.orderGrossRevenueAmount ??
          readNumber(order, "Subtotal") ??
          grossRevenueAmount,
        orderShippingCollectedAmount:
          readNumber(order, "ShippingServiceSelected.ShippingServiceCost") ?? null,
        orderTaxCollectedAmount:
          financeSummary?.orderTaxCollectedAmount ??
          readNumber(order, "TotalTaxAmount") ??
          null,
        orderDiscountAmount: readNumber(order, "AmountSaved") ?? null,
        orderNetRevenueAmount: null,
        buyerIdentifier,
        buyerDisplayLabel: buyerIdentifier,
        buyerEmail: null,
        isCancelled,
        isReturn: false,
        rawData: {
          orderId: externalOrderId,
          itemId: readText(item, "ItemID") ?? null,
          lineId,
        },
        financialRawData: financeLine?.raw ?? {},
        orderFinancialRawData: {
          financeTransactionFound: Boolean(financeSummary),
          totalTaxAmount: readNumber(order, "TotalTaxAmount") ?? null,
          shippingCost: readNumber(order, "ShippingServiceSelected.ShippingServiceCost") ?? null,
        },
      });
    }
  }

  const summaryCreditAmount = pickNestedAmount(transactionSummary?.creditAmount) ?? null;
  const summaryShippingLabelAmount = pickNestedAmount(transactionSummary?.shippingLabelAmount) ?? null;
  const summaryNonSaleChargeAmount = pickNestedAmount(transactionSummary?.nonSaleChargeAmount) ?? null;
  const summaryRefundAmount = pickNestedAmount(transactionSummary?.refundAmount) ?? null;
  const summaryDisputeAmount = pickNestedAmount(transactionSummary?.disputeAmount) ?? null;
  const summarySellingCosts =
    (
      [
        summaryShippingLabelAmount ?? 0,
        summaryNonSaleChargeAmount ?? 0,
        summaryRefundAmount ?? 0,
        summaryDisputeAmount ?? 0,
      ] as number[]
    ).reduce((sum, value) => sum + value, 0) || null;

  const grossFromTransactions = financialEvents
    .filter((event) => event.classification === "SALE")
    .reduce((sum, event) => sum + event.amount, 0);
  const taxFromTransactions = financialEvents
    .filter((event) => event.classification === "TAX")
    .reduce((sum, event) => sum + event.amount, 0);
  const marketplaceFees = financialEvents
    .filter((event) => event.classification === "MARKETPLACE_FEE")
    .reduce((sum, event) => sum + event.amount, 0);
  const advertisingFees = financialEvents
    .filter((event) => event.classification === "ADVERTISING_FEE")
    .reduce((sum, event) => sum + event.amount, 0);
  const shippingLabels = financialEvents
    .filter((event) => event.classification === "SHIPPING_LABEL")
    .reduce((sum, event) => sum + event.amount, 0);
  const accountLevelFees = financialEvents
    .filter((event) => event.classification === "ACCOUNT_LEVEL_FEE")
    .reduce((sum, event) => sum + event.amount, 0);
  const otherCosts = financialEvents
    .filter((event) => event.classification === "OTHER" || event.classification === "CREDIT")
    .reduce((sum, event) => sum + event.amount, 0);
  const sellingCosts = marketplaceFees + advertisingFees + shippingLabels + accountLevelFees + otherCosts;
  const exactSummary: RevenueSourceSummary = {
    grossRevenue: grossFromTransactions || null,
    taxCollected: taxFromTransactions || null,
    sellingCosts: summarySellingCosts ?? (sellingCosts || null),
    marketplaceFees: marketplaceFees || null,
    advertisingFees: advertisingFees || null,
    shippingLabels: shippingLabels || null,
    accountLevelFees: accountLevelFees || null,
    netRevenue:
      grossFromTransactions > 0
        ? grossFromTransactions -
          taxFromTransactions -
          (summarySellingCosts ?? sellingCosts)
        : null,
    currencyCode:
      lines[0]?.currencyCode ??
      financialEvents[0]?.currencyCode ??
      (summaryCreditAmount != null ? "USD" : null),
  };

  return {
    lines,
    financialEvents,
    exactSummary,
    syncStages,
    warnings:
      transactions.length === 0
        ? ["No eBay finance transactions were returned for this range.", ...warnings]
        : warnings,
  };
}

async function fetchShopifyRevenue(
  integration: RevenueIntegration,
  from: Date,
  to: Date,
  options?: RevenueFetchOptions,
): Promise<RevenueFetchResult> {
  const config = resolveIntegrationConfig(integration);
  if (!isShopifyIntegrationConfig(config)) {
    throw new Error("Invalid Shopify config.");
  }

  const baseUrl = `https://${config.storeDomain}/admin/api/${config.apiVersion}`;
  const fields = [
    "id",
    "created_at",
    "cancelled_at",
    "updated_at",
    "currency",
    "current_total_tax",
    "current_total_discounts",
    "email",
    "contact_email",
    "customer",
    "shipping_lines",
    "line_items",
  ].join(",");
  let nextUrl =
    `${baseUrl}/orders.json?status=any&limit=${SHOPIFY_PAGE_LIMIT}&order=created_at%20asc` +
    `&created_at_min=${encodeURIComponent(from.toISOString())}` +
    `&created_at_max=${encodeURIComponent(to.toISOString())}` +
    `&fields=${encodeURIComponent(fields)}`;
  const lines: ForecastSaleLine[] = [];

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        "X-Shopify-Access-Token": config.accessToken,
        Accept: "application/json",
      },
      signal: options?.signal,
    });

    if (!response.ok) {
      throw new Error(`Shopify orders fetch failed: ${response.status} ${await readTrackedText(response)}`);
    }

    const json = await readTrackedJson<{
      orders?: Array<Record<string, unknown>>;
    }>(response);
    const orders = json.orders ?? [];

    for (const order of orders) {
      const externalOrderId = String(order.id ?? "");
      const orderDate = new Date(String(order.created_at ?? ""));
      if (!externalOrderId || Number.isNaN(orderDate.getTime())) continue;
      const cancelledAt = getString(order.cancelled_at);
      const isCancelled = Boolean(cancelledAt);
      const customer = asRecord(order.customer);
      const shippingLines = asArray<Record<string, unknown>>(order.shipping_lines);
      const orderShippingCollectedAmount = shippingLines.reduce((sum, shippingLine) => {
        return sum + (getNumber(shippingLine.discounted_price) ?? getNumber(shippingLine.price) ?? 0);
      }, 0);
      const orderTaxCollectedAmount = getNumber(order.current_total_tax) ?? getNumber(order.total_tax);
      const orderDiscountAmount =
        getNumber(order.current_total_discounts) ?? getNumber(order.total_discounts);
      const buyerEmail = nonEmptyString(
        getString(order.email),
        getString(order.contact_email),
        getString(customer?.email),
      );
      const buyerIdentifier = nonEmptyString(
        customer?.id != null ? String(customer.id) : null,
        buyerEmail,
      );
      const buyerDisplayLabel = nonEmptyString(
        [getString(customer?.first_name), getString(customer?.last_name)]
          .filter(Boolean)
          .join(" ")
          .trim(),
        buyerEmail,
        buyerIdentifier,
      );
      const lineItems = asArray<Record<string, unknown>>(order.line_items);
      const activeLineItems = lineItems.filter((lineItem) => {
        const sku = getString(lineItem.sku) ?? "";
        const quantity = getNumber(lineItem.current_quantity) ?? getNumber(lineItem.quantity) ?? 0;
        return Boolean(sku.trim()) && quantity > 0;
      });
      const orderGrossRevenueAmount = activeLineItems.reduce((sum, lineItem) => {
        const quantity = getNumber(lineItem.current_quantity) ?? getNumber(lineItem.quantity) ?? 0;
        const unitPrice = getNumber(lineItem.price) ?? 0;
        const totalDiscount = getNumber(lineItem.total_discount) ?? 0;
        return sum + unitPrice * quantity - totalDiscount;
      }, 0);

      for (let index = 0; index < lineItems.length; index += 1) {
        const lineItem = lineItems[index];
        const sku = getString(lineItem.sku) ?? "";
        const quantity = getNumber(lineItem.current_quantity) ?? getNumber(lineItem.quantity) ?? 0;
        if (!sku.trim() || quantity <= 0) continue;

        const unitPriceAmount = getNumber(lineItem.price);
        const totalDiscount = getNumber(lineItem.total_discount) ?? 0;
        const grossRevenueAmount =
          unitPriceAmount != null ? unitPriceAmount * quantity - totalDiscount : null;

        lines.push({
          platform: integration.platform,
          externalOrderId,
          externalLineId: String(lineItem.id ?? `${externalOrderId}:${index}`),
          orderDate,
          sku,
          title: getString(lineItem.name) ?? getString(lineItem.title) ?? null,
          quantity,
          platformItemId: lineItem.product_id != null ? String(lineItem.product_id) : null,
          platformVariantId: lineItem.variant_id != null ? String(lineItem.variant_id) : null,
          orderStatus: isCancelled ? "cancelled" : "completed",
          cancelledAt: cancelledAt ? new Date(cancelledAt) : null,
          currencyCode: getString(order.currency) ?? "USD",
          unitPriceAmount,
          grossRevenueAmount,
          marketplaceFeeAmount: null,
          advertisingFeeAmount: null,
          otherFeeAmount: null,
          taxAmount: null,
          shippingAmount: null,
          netRevenueAmount: null,
          orderGrossRevenueAmount,
          orderShippingCollectedAmount,
          orderTaxCollectedAmount,
          orderDiscountAmount,
          orderNetRevenueAmount: null,
          buyerIdentifier,
          buyerDisplayLabel,
          buyerEmail,
          isCancelled,
          isReturn: false,
          rawData: {
            orderId: externalOrderId,
            lineItemId: String(lineItem.id ?? `${externalOrderId}:${index}`),
          },
          financialRawData: {
            totalDiscount,
          },
          orderFinancialRawData: {
            current_total_tax: orderTaxCollectedAmount,
            current_total_discounts: orderDiscountAmount,
            shipping_lines_count: shippingLines.length,
          },
        });
      }
    }

    const linkHeader = response.headers.get("Link") ?? "";
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : "";
  }

  return { lines, financialEvents: [], exactSummary: null, syncStages: [], warnings: [] };
}

async function fetchBigCommerceOrderProducts(
  storeHash: string,
  accessToken: string,
  orderId: number,
  options?: RevenueFetchOptions,
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
        `BigCommerce order products failed: ${response.status} ${await readTrackedText(response)}`,
      );
    }

    return await readTrackedJson<Array<Record<string, unknown>>>(response);
  }

  throw new Error("BigCommerce order products failed after retry attempts.");
}

async function fetchBigCommerceRevenue(
  integration: RevenueIntegration,
  from: Date,
  to: Date,
  options?: RevenueFetchOptions,
): Promise<RevenueFetchResult> {
  const config = resolveIntegrationConfig(integration);
  if (!isBigCommerceIntegrationConfig(config)) {
    throw new Error("Invalid BigCommerce config.");
  }

  const lines: ForecastSaleLine[] = [];
  let page = 1;
  let keepGoing = true;

  while (keepGoing) {
    let ordersResponse: Response | null = null;
    for (let attempt = 0; attempt <= BIGCOMMERCE_MAX_RETRIES; attempt += 1) {
      const response = await fetch(
        `https://api.bigcommerce.com/stores/${config.storeHash}/v2/orders?min_date_created=${encodeURIComponent(from.toISOString())}&max_date_created=${encodeURIComponent(to.toISOString())}&page=${page}&limit=${BIGCOMMERCE_PAGE_LIMIT}&sort=date_created:asc`,
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
        `BigCommerce orders fetch failed: ${ordersResponse.status} ${await readTrackedText(ordersResponse)}`,
      );
    }

    const orders = await readTrackedJson<Array<Record<string, unknown>>>(ordersResponse);
    keepGoing = orders.length === BIGCOMMERCE_PAGE_LIMIT;

    const validOrders = orders
      .map((order) => ({
        order,
        orderId: Number(order.id ?? 0),
        orderDate: new Date(String(order.date_created ?? "")),
        isCancelled: (getString(order.status) ?? "").toLowerCase().includes("cancel"),
      }))
      .filter((entry) => Number.isFinite(entry.orderId) && !Number.isNaN(entry.orderDate.getTime()));

    for (let batch = 0; batch < validOrders.length; batch += BIGCOMMERCE_PRODUCT_CONCURRENCY) {
      const chunk = validOrders.slice(batch, batch + BIGCOMMERCE_PRODUCT_CONCURRENCY);
      const productResults = await Promise.all(
        chunk.map((entry) =>
          fetchBigCommerceOrderProducts(config.storeHash, config.accessToken, entry.orderId, options),
        ),
      );

      for (let ci = 0; ci < chunk.length; ci += 1) {
        const entry = chunk[ci];
        const order = entry.order;
        const products = productResults[ci];
        const billingAddress = asRecord(order.billing_address);
        const buyerEmail = nonEmptyString(
          getString(order.email),
          getString(billingAddress?.email),
        );
        const buyerIdentifier = nonEmptyString(
          order.customer_id != null ? String(order.customer_id) : null,
          buyerEmail,
        );
        const buyerDisplayLabel = nonEmptyString(
          [getString(billingAddress?.first_name), getString(billingAddress?.last_name)]
            .filter(Boolean)
            .join(" ")
            .trim(),
          buyerEmail,
          buyerIdentifier,
        );
        const orderGrossRevenueAmount = products.reduce((sum, product) => {
          return (
            sum +
            (getNumber(product.total_ex_tax) ??
              getNumber(product.total_inc_tax) ??
              (getNumber(product.base_price) ?? getNumber(product.price_ex_tax) ?? 0) *
                (getNumber(product.quantity) ?? 0))
          );
        }, 0);

        for (let index = 0; index < products.length; index += 1) {
          const product = products[index];
          const sku = getString(product.sku) ?? "";
          const quantity = getNumber(product.quantity) ?? 0;
          if (!sku.trim() || quantity <= 0) continue;

          const unitPriceAmount =
            getNumber(product.price_ex_tax) ??
            getNumber(product.base_price) ??
            getNumber(product.price_inc_tax);
          const grossRevenueAmount =
            getNumber(product.total_ex_tax) ??
            (unitPriceAmount != null ? unitPriceAmount * quantity : null);

          lines.push({
            platform: integration.platform,
            externalOrderId: String(entry.orderId),
            externalLineId: String(product.id ?? `${entry.orderId}:${index}`),
            orderDate: entry.orderDate,
            sku,
            title: getString(product.name) ?? null,
            quantity,
            platformItemId: product.product_id != null ? String(product.product_id) : null,
            platformVariantId: product.variant_id != null ? String(product.variant_id) : null,
            orderStatus: getString(order.status) ?? (entry.isCancelled ? "cancelled" : "completed"),
            cancelledAt: entry.isCancelled ? entry.orderDate : null,
            currencyCode: getString(order.currency_code) ?? "USD",
            unitPriceAmount,
            grossRevenueAmount,
            marketplaceFeeAmount: null,
            advertisingFeeAmount: null,
            otherFeeAmount: null,
            taxAmount: null,
            shippingAmount: null,
            netRevenueAmount: null,
            orderGrossRevenueAmount,
            orderShippingCollectedAmount:
              getNumber(order.shipping_cost_ex_tax) ??
              getNumber(order.shipping_cost_inc_tax) ??
              getNumber(order.shipping_cost_tax),
            orderTaxCollectedAmount: getNumber(order.total_tax),
            orderDiscountAmount: getNumber(order.discount_amount),
            orderNetRevenueAmount: null,
            buyerIdentifier,
            buyerDisplayLabel,
            buyerEmail,
            isCancelled: entry.isCancelled,
            isReturn: false,
            rawData: {
              orderId: String(entry.orderId),
              lineItemId: String(product.id ?? `${entry.orderId}:${index}`),
            },
            financialRawData: {
              total_ex_tax: getNumber(product.total_ex_tax),
              total_inc_tax: getNumber(product.total_inc_tax),
            },
            orderFinancialRawData: {
              total_tax: getNumber(order.total_tax),
              discount_amount: getNumber(order.discount_amount),
              shipping_cost_inc_tax: getNumber(order.shipping_cost_inc_tax),
            },
          });
        }
      }
    }

    page += 1;
  }

  return { lines, financialEvents: [], exactSummary: null, syncStages: [], warnings: [] };
}

// ─── Amazon SP-API revenue ────────────────────────────────────────────────────

function hmacSha256Rev(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}
function sha256HexRev(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function awsSignRev(opts: {
  method: string; path: string; query: string;
  accessKeyId: string; secretAccessKey: string;
}): Record<string, string> {
  const { method, path, query, accessKeyId, secretAccessKey } = opts;
  const host = "sellingpartnerapi-na.amazon.com";
  const region = "us-east-1";
  const service = "execute-api";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256HexRev("");
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-date";
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256HexRev(canonicalRequest)].join("\n");
  const signingKey = hmacSha256Rev(
    hmacSha256Rev(hmacSha256Rev(hmacSha256Rev(`AWS4${secretAccessKey}`, dateStamp), region), service),
    "aws4_request",
  );
  const signature = hmacSha256Rev(signingKey, stringToSign).toString("hex");
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date": amzDate,
    host,
  };
}

async function getAmazonLwaTokenRev(refreshToken: string): Promise<string> {
  const clientId     = process.env.AMAZON_LWA_CLIENT_ID;
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Amazon LWA credentials not configured.");
  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`Amazon LWA token refresh failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

type SpApiResponse = { payload?: { FinancialEvents?: AmazonFinancialEvents; NextToken?: string }; errors?: unknown[] };
type AmazonMoney = { CurrencyCode?: string; CurrencyAmount?: number };
type AmazonFinancialEvents = {
  ShipmentEventList?: AmazonShipmentEvent[];
  RefundEventList?: AmazonShipmentEvent[];
  AdvertisingTransactionEventList?: AmazonAdvertisingEvent[];
};
type AmazonShipmentEvent = {
  AmazonOrderId?: string;
  PostedDate?: string;
  ShipmentItemList?: AmazonShipmentItem[];
};
type AmazonShipmentItem = {
  ASIN?: string;
  SellerSKU?: string;
  OrderItemIdentifier?: string;
  QuantityShipped?: number;
  ItemChargeList?: Array<{ ChargeType?: string; ChargeAmount?: AmazonMoney }>;
  ItemFeeList?: Array<{ FeeType?: string; FeeAmount?: AmazonMoney }>;
};
type AmazonAdvertisingEvent = {
  PostedDate?: string;
  TransactionType?: string;
  InvoiceId?: string;
  BaseValue?: AmazonMoney;
  TaxValue?: AmazonMoney;
  TransactionValue?: AmazonMoney;
};

/**
 * Classify an Amazon fee type string into revenue categories.
 * Amazon returns negative CurrencyAmount values for costs; callers should
 * Math.abs() before accumulating.
 */
function classifyAmazonFeeType(feeType: string | null | undefined): "ADVERTISING_FEE" | "MARKETPLACE_FEE" | "OTHER" {
  const n = (feeType ?? "").toUpperCase();
  if (n.includes("ADVERTIS") || n.includes("SPONSOR") || n.includes("PROMOTED")) return "ADVERTISING_FEE";
  // FBA/fulfillment fees are a marketplace cost but shown separately in KPIs
  if (n.includes("FBA") || n.includes("FULFILLMENT") || n.includes("WEIGHT_BASED") || n.includes("PLACEMENT")) return "OTHER";
  // Everything else (ReferralFee, Commission, VariableClosingFee, PerItemFee, FixedClosingFee, etc.) is a marketplace fee
  return "MARKETPLACE_FEE";
}

async function spApiPagedFinancialEvents(
  lwaToken: string,
  from: Date,
  toRaw: Date,
  signal?: AbortSignal,
): Promise<AmazonFinancialEvents> {
  // SP-API rejects PostedBefore values that are within 2 minutes of now — cap to 3 min ago.
  const safeMax = new Date(Date.now() - 3 * 60 * 1000);
  const to = toRaw > safeMax ? safeMax : toRaw;
  const accessKeyId     = process.env.AMAZON_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AMAZON_AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("Amazon AWS credentials not configured.");

  const spHost = "sellingpartnerapi-na.amazon.com";
  const path   = "/finances/v0/financialEvents";
  const allShipments: AmazonShipmentEvent[] = [];
  const allRefunds:   AmazonShipmentEvent[] = [];
  const allAdEvents:  AmazonAdvertisingEvent[] = [];
  let nextToken: string | undefined;
  let page = 0;
  const MAX_PAGES = 20;

  do {
    const query = nextToken
      ? `NextToken=${encodeURIComponent(nextToken)}`
      : `PostedAfter=${encodeURIComponent(from.toISOString())}&PostedBefore=${encodeURIComponent(to.toISOString())}&MaxResultsPerPage=100`;

    const awsHeaders = awsSignRev({ method: "GET", path, query, accessKeyId, secretAccessKey });
    const res = await fetch(`https://${spHost}${path}?${query}`, {
      headers: { ...awsHeaders, "x-amz-access-token": lwaToken, Accept: "application/json" },
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Amazon SP-API financial events failed: ${res.status} — ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as SpApiResponse;
    if (json.errors?.length) throw new Error(`Amazon SP-API error: ${JSON.stringify(json.errors).slice(0, 200)}`);
    allShipments.push(...(json.payload?.FinancialEvents?.ShipmentEventList ?? []));
    allRefunds.push(...(json.payload?.FinancialEvents?.RefundEventList ?? []));
    allAdEvents.push(...(json.payload?.FinancialEvents?.AdvertisingTransactionEventList ?? []));
    nextToken = json.payload?.NextToken;
    page++;
  } while (nextToken && page < MAX_PAGES);

  return { ShipmentEventList: allShipments, RefundEventList: allRefunds, AdvertisingTransactionEventList: allAdEvents };
}

function mapAmazonItemsToLines(
  events: AmazonShipmentEvent[],
  integrationId: string,
  isRefund: boolean,
): { lines: ForecastSaleLine[]; financialEvents: RevenueFinancialEventInput[] } {
  const lines: ForecastSaleLine[] = [];
  const financialEvents: RevenueFinancialEventInput[] = [];

  for (const event of events) {
    const orderId  = event.AmazonOrderId ?? "";
    const postedAt = event.PostedDate ? new Date(event.PostedDate) : new Date();
    const sign     = isRefund ? -1 : 1;

    for (const [idx, item] of (event.ShipmentItemList ?? []).entries()) {
      const sku    = item.SellerSKU ?? item.ASIN ?? "";
      const lineId = item.OrderItemIdentifier ?? `${orderId}-${idx}`;
      const qty    = (item.QuantityShipped ?? 1) * sign;

      const principal = (item.ItemChargeList ?? []).find(c => c.ChargeType === "Principal")?.ChargeAmount?.CurrencyAmount ?? 0;
      const tax       = (item.ItemChargeList ?? []).find(c => c.ChargeType === "Tax")?.ChargeAmount?.CurrencyAmount ?? 0;
      const shipping  = (item.ItemChargeList ?? []).find(c => c.ChargeType === "ShippingCharge")?.ChargeAmount?.CurrencyAmount ?? 0;
      const currency  = item.ItemChargeList?.[0]?.ChargeAmount?.CurrencyCode ?? item.ItemFeeList?.[0]?.FeeAmount?.CurrencyCode ?? "USD";

      // Classify all fee line items using the Amazon fee classifier
      let marketplaceFee = 0;
      let advertisingFee = 0;
      let otherFee = 0;
      for (const fee of (item.ItemFeeList ?? [])) {
        const abs = Math.abs(fee.FeeAmount?.CurrencyAmount ?? 0);
        const cls = classifyAmazonFeeType(fee.FeeType);
        if (cls === "ADVERTISING_FEE") advertisingFee += abs;
        else if (cls === "MARKETPLACE_FEE") marketplaceFee += abs;
        else otherFee += abs;

        // Emit a per-fee financial event for precise KPI tracking
        if (abs > 0) {
          financialEvents.push({
            integrationId,
            platform: "AMAZON",
            eventType: "TRANSACTION",
            classification: cls,
            externalEventId: `${lineId}-fee-${fee.FeeType ?? idx}`,
            externalOrderId: orderId,
            externalLineId: lineId,
            sku: sku || null,
            amount: abs,
            currencyCode: currency,
            occurredAt: postedAt,
          });
        }
      }

      lines.push({
        platform: "AMAZON",
        externalOrderId: orderId,
        externalLineId: lineId,
        orderDate: postedAt,
        sku,
        title: null,
        quantity: qty,
        currencyCode: currency,
        grossRevenueAmount: principal * sign,
        marketplaceFeeAmount: marketplaceFee > 0 ? marketplaceFee : null,
        advertisingFeeAmount: advertisingFee > 0 ? advertisingFee : null,
        otherFeeAmount: otherFee > 0 ? otherFee : null,
        taxAmount: tax * sign,
        shippingAmount: shipping * sign,
        netRevenueAmount: (principal - marketplaceFee - advertisingFee - otherFee) * sign,
        isCancelled: false,
        isReturn: isRefund,
      });

      if (principal !== 0) {
        financialEvents.push({
          integrationId,
          platform: "AMAZON",
          eventType: "TRANSACTION",
          classification: isRefund ? "CREDIT" : "SALE",
          externalEventId: lineId,
          externalOrderId: orderId,
          externalLineId: lineId,
          platformItemId: item.ASIN ?? null,
          sku: sku || null,
          amount: principal * sign,
          currencyCode: currency,
          occurredAt: postedAt,
        });
      }
    }
  }

  return { lines, financialEvents };
}

/**
 * Map AdvertisingTransactionEventList entries to ADVERTISING_FEE financial events.
 * These are account-level ad charges not tied to individual orders.
 */
function mapAmazonAdvertisingEvents(
  events: AmazonAdvertisingEvent[],
  integrationId: string,
): RevenueFinancialEventInput[] {
  return events.flatMap((ev, idx) => {
    const postedAt = ev.PostedDate ? new Date(ev.PostedDate) : new Date();
    // Use BaseValue (before tax) for the ad spend amount; it's negative in Amazon's data
    const amount = Math.abs(ev.BaseValue?.CurrencyAmount ?? ev.TransactionValue?.CurrencyAmount ?? 0);
    if (amount === 0) return [];
    const currency = ev.BaseValue?.CurrencyCode ?? ev.TransactionValue?.CurrencyCode ?? "USD";
    return [{
      integrationId,
      platform: "AMAZON" as const,
      eventType: "BILLING_ACTIVITY" as const,
      classification: "ADVERTISING_FEE" as const,
      externalEventId: ev.InvoiceId ?? `ad-event-${idx}-${postedAt.toISOString()}`,
      amount,
      currencyCode: currency,
      occurredAt: postedAt,
    }];
  });
}

async function fetchAmazonRevenue(
  integration: RevenueIntegration,
  from: Date,
  to: Date,
  options?: RevenueFetchOptions,
): Promise<RevenueFetchResult> {
  const cfg = integration.config as Record<string, unknown>;
  const refreshToken = cfg.refreshToken as string | undefined;
  if (!refreshToken) throw new Error("Amazon refresh token not configured.");

  const syncStages = buildSyncStages([
    { key: "token",  label: "LWA Token" },
    { key: "events", label: "Financial Events" },
  ]);

  await updateSyncStage(syncStages, "token", "RUNNING", "Refreshing Amazon LWA token.", options);
  const lwaToken = await getAmazonLwaTokenRev(refreshToken);
  await updateSyncStage(syncStages, "token", "COMPLETED", "Amazon LWA token ready.", options);

  await updateSyncStage(syncStages, "events", "RUNNING", "Fetching Amazon financial events.", options);
  const events = await spApiPagedFinancialEvents(lwaToken, from, to, options?.signal);
  const shipResult   = mapAmazonItemsToLines(events.ShipmentEventList ?? [], integration.id, false);
  const refundResult = mapAmazonItemsToLines(events.RefundEventList   ?? [], integration.id, true);
  const adFinEvts    = mapAmazonAdvertisingEvents(events.AdvertisingTransactionEventList ?? [], integration.id);
  const allLines     = [...shipResult.lines, ...refundResult.lines];
  const allFinEvts   = [...shipResult.financialEvents, ...refundResult.financialEvents, ...adFinEvts];
  const adEventCount = events.AdvertisingTransactionEventList?.length ?? 0;
  await updateSyncStage(syncStages, "events", "COMPLETED",
    `${allLines.length} line items (${events.ShipmentEventList?.length ?? 0} shipment, ${events.RefundEventList?.length ?? 0} refund, ${adEventCount} advertising events).`,
    options);

  return { lines: allLines, financialEvents: allFinEvts, exactSummary: null, syncStages, warnings: [] };
}

export async function fetchMarketplaceRevenue(
  integration: RevenueIntegration,
  from: Date,
  to: Date,
  options?: RevenueFetchOptions,
): Promise<RevenueFetchResult> {
  switch (integration.platform) {
    case "TPP_EBAY":
    case "TT_EBAY":
      return fetchEbayRevenue(integration, from, to, options);
    case "SHOPIFY":
      return fetchShopifyRevenue(integration, from, to, options);
    case "BIGCOMMERCE":
      return fetchBigCommerceRevenue(integration, from, to, options);
    case "AMAZON":
      return fetchAmazonRevenue(integration, from, to, options);
    default:
      return { lines: [], financialEvents: [], exactSummary: null, syncStages: [], warnings: [] };
  }
}
