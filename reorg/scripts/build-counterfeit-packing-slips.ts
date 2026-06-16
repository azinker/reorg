import ExcelJS from "exceljs";
import { createHash, createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { XMLParser } from "fast-xml-parser";
import { db } from "../src/lib/db";
import { buildEbayConfig, getEbayAccessToken } from "../src/lib/services/auto-responder-ebay";

type PackingLine = {
  sku: string;
  quantity: number;
};

type PackingOrder = {
  orderNumber: string;
  platform: string | null;
  lines: PackingLine[];
};

type Issue = {
  type: string;
  orderNumber: string;
  detail?: string;
};

const defaultWorkbookPath = String.raw`C:\Users\thepe\OneDrive - theperfectpart.net\Desktop\DTS LB BATCHES\ADAM ISSUE\Trackings\ALL_counterfeit.xlsx`;
const workbookPath = process.argv[2] ?? defaultWorkbookPath;
const workbookDir = workbookPath.includes("\\")
  ? workbookPath.slice(0, workbookPath.lastIndexOf("\\"))
  : ".";
const workbookBase = workbookPath
  .slice(workbookPath.lastIndexOf("\\") + 1)
  .replace(/\.xlsx$/i, "");
const outputPath = process.argv[3] ?? `${workbookDir}\\${workbookBase}_packing_slips.pdf`;
const auditPath = process.argv[4] ?? `${workbookDir}\\${workbookBase}_packing_slips_audit.xlsx`;

const PAGE_WIDTH = 4 * 72;
const PAGE_HEIGHT = 6 * 72;
const REQUEST_TIMEOUT_MS = 30_000;
const TRADING_API = "https://api.ebay.com/ws/api.dll";
const EBAY_BATCH_SIZE = 20;
const EBAY_BATCH_CONCURRENCY = 5;
const SHOPIFY_CONCURRENCY = 2;
const AMAZON_CONCURRENCY = 1;
const SP_API_HOST = "sellingpartnerapi-na.amazon.com";
const SP_API_REGION = "us-east-1";
const SP_API_SERVICE = "execute-api";
const AMAZON_LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

const EBAY_ORDER_REGEX = /^\d{2}-\d{5}-\d{5}$/;
const AMAZON_ORDER_REGEX = /^\d{3}-\d{7}-\d{7}$/;
const NUMERIC_ORDER_REGEX = /^\d+$/;

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (tagName) => ["Order", "Transaction", "Errors", "Error"].includes(tagName),
});

const amazonTokenCache = new Map<string, { token: string; expiresAt: number }>();

function hostFromUrl(raw: string) {
  try {
    return new URL(raw).hostname;
  } catch {
    return "";
  }
}

function cellText(value: ExcelJS.CellValue) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if ("text" in value && value.text) return String(value.text);
  if ("result" in value && value.result != null) return cellText(value.result as ExcelJS.CellValue);
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  const record = asRecord(value);
  if (record?.["#text"] != null) return text(record["#text"]);
  return null;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: string; headers: Headers }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
      headers: response.headers,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runConcurrently<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readOrderNumbers() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Workbook has no worksheets.");

  let orderColumn = 0;
  sheet.getRow(1).eachCell((cell, col) => {
    if (cellText(cell.value).trim() === "orderNumber") orderColumn = col;
  });
  if (!orderColumn) throw new Error("Could not find the orderNumber header.");

  const orderNumbers: string[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const orderNumber = cellText(sheet.getRow(rowNumber).getCell(orderColumn).value).trim();
    if (orderNumber) orderNumbers.push(orderNumber);
  }
  return orderNumbers;
}

function mergeLines(lines: PackingLine[]) {
  const bySku = new Map<string, number>();
  for (const line of lines) {
    const sku = line.sku.trim() || "UNKNOWN_SKU";
    bySku.set(sku, (bySku.get(sku) ?? 0) + line.quantity);
  }
  return [...bySku.entries()]
    .map(([sku, quantity]) => ({ sku, quantity }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
}

function mapEbayLine(transaction: Record<string, unknown>): PackingLine {
  const item = asRecord(transaction.Item);
  const variation = asRecord(transaction.Variation);
  return {
    sku: text(variation?.SKU) ?? text(item?.SKU) ?? text(transaction.SKU) ?? "UNKNOWN_SKU",
    quantity: Number(text(transaction.QuantityPurchased) ?? "1") || 1,
  };
}

function parseEbayOrders(platform: string, xml: string, requestedOrderIds: string[]) {
  const parsed = xmlParser.parse(xml) as Record<string, unknown>;
  const root = asRecord(parsed.GetOrdersResponse);
  const orderArray = asRecord(root?.OrderArray);
  const orders = asArray<Record<string, unknown>>(
    orderArray?.Order as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  const found = new Map<string, PackingOrder>();

  for (const order of orders) {
    const apiOrderId = text(order.OrderID);
    if (!apiOrderId) continue;
    const inputOrderId = requestedOrderIds.find((id) => apiOrderId === id || apiOrderId.startsWith(`${id}!`));
    if (!inputOrderId) continue;
    const transactionArray = asRecord(order.TransactionArray);
    const transactions = asArray<Record<string, unknown>>(
      transactionArray?.Transaction as Record<string, unknown> | Record<string, unknown>[] | undefined,
    );
    found.set(inputOrderId, {
      orderNumber: inputOrderId,
      platform,
      lines: mergeLines(transactions.map(mapEbayLine)),
    });
  }

  return found;
}

async function fetchEbayBatch(
  integration: { id: string; platform: string; config: unknown },
  orderIds: string[],
) {
  const config = buildEbayConfig(integration);
  const accessToken = await getEbayAccessToken(integration.id, config);
  const idElements = orderIds.map((id) => `    <OrderID>${escapeXml(id)}</OrderID>`).join("\n");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderIDArray>
${idElements}
  </OrderIDArray>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;
  const response = await fetchWithTimeout(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": accessToken,
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1199",
      "X-EBAY-API-CALL-NAME": "GetOrders",
      "Content-Type": "text/xml",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`${integration.platform} GetOrders failed: HTTP ${response.status} ${response.body.slice(0, 240)}`);
  }
  return parseEbayOrders(integration.platform, response.body, orderIds);
}

async function resolveEbayOrders(
  orderNumbers: string[],
  integrations: Array<{ id: string; platform: string; config: unknown }>,
  issues: Issue[],
) {
  const ebayIntegrations = integrations.filter((row) => row.platform === "TPP_EBAY" || row.platform === "TT_EBAY");
  const batches: string[][] = [];
  for (let i = 0; i < orderNumbers.length; i += EBAY_BATCH_SIZE) {
    batches.push(orderNumbers.slice(i, i + EBAY_BATCH_SIZE));
  }
  const resolved = new Map<string, PackingOrder>();

  await runConcurrently(batches, EBAY_BATCH_CONCURRENCY, async (batch) => {
    const settled = await Promise.allSettled(ebayIntegrations.map((integration) => fetchEbayBatch(integration, batch)));
    const matchesByOrder = new Map<string, PackingOrder[]>();
    for (const result of settled) {
      if (result.status === "rejected") {
        issues.push({ type: "ebay_lookup_error", orderNumber: batch.join(","), detail: String(result.reason) });
        continue;
      }
      result.value.forEach((order, orderNumber) => {
        const bucket = matchesByOrder.get(orderNumber) ?? [];
        bucket.push(order);
        matchesByOrder.set(orderNumber, bucket);
      });
    }
    for (const [orderNumber, matches] of matchesByOrder) {
      if (matches.length > 1) {
        issues.push({
          type: "duplicate_platform_match",
          orderNumber,
          detail: matches.map((match) => match.platform).join(","),
        });
      }
      const combinedLines = mergeLines(matches.flatMap((match) => match.lines));
      resolved.set(orderNumber, {
        orderNumber,
        platform: matches.map((match) => match.platform).join(","),
        lines: combinedLines.length > 0 ? combinedLines : [{ sku: "NO_LINE_ITEMS_FOUND", quantity: 0 }],
      });
    }
  });

  return resolved;
}

async function shopifyFetch(
  url: string,
  accessToken: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  let attempt = 0;
  while (true) {
    const response = await fetchWithTimeout(url, {
      headers: { "X-Shopify-Access-Token": accessToken, Accept: "application/json" },
    });
    if (response.status !== 429 || attempt >= 5) return response;
    const retryAfter = Number(response.headers.get("Retry-After"));
    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** attempt));
    attempt += 1;
  }
}

async function queryShopifyOrder(
  integration: { platform: string; config: unknown },
  orderNumber: string,
): Promise<PackingOrder | null> {
  const config = asRecord(integration.config) ?? {};
  const storeDomain = text(config.storeDomain);
  const accessToken = text(config.accessToken);
  const apiVersion = text(config.apiVersion) ?? "2026-01";
  if (!storeDomain || !accessToken) return null;
  const normalizedOrderName = orderNumber.startsWith("#") ? orderNumber.slice(1) : orderNumber;
  const url = `https://${storeDomain}/admin/api/${apiVersion}/orders.json?name=%23${encodeURIComponent(normalizedOrderName)}&status=any&limit=5`;
  const response = await shopifyFetch(url, accessToken);
  if (!response.ok) return null;
  const data = JSON.parse(response.body) as { orders?: Array<Record<string, unknown>> };
  const order = data.orders?.[0];
  if (!order) return null;
  const lineItems = asArray<Record<string, unknown>>(
    order.line_items as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  return {
    orderNumber,
    platform: "SHOPIFY",
    lines: mergeLines(
      lineItems.map((line) => ({
        sku: text(line.sku) ?? "UNKNOWN_SKU",
        quantity: Number(text(line.quantity) ?? "1") || 1,
      })),
    ),
  };
}

async function queryBigCommerceOrder(
  integration: { platform: string; config: unknown },
  orderNumber: string,
): Promise<PackingOrder | null> {
  if (!NUMERIC_ORDER_REGEX.test(orderNumber)) return null;
  const config = asRecord(integration.config) ?? {};
  const storeHash = text(config.storeHash);
  const accessToken = text(config.accessToken);
  if (!storeHash || !accessToken) return null;
  const response = await fetchWithTimeout(
    `https://api.bigcommerce.com/stores/${storeHash}/v2/orders/${encodeURIComponent(orderNumber)}/products`,
    { headers: { "X-Auth-Token": accessToken, Accept: "application/json" } },
  );
  if (!response.ok) return null;
  const products = JSON.parse(response.body) as Array<Record<string, unknown>>;
  if (!Array.isArray(products) || products.length === 0) return null;
  return {
    orderNumber,
    platform: "BIGCOMMERCE",
    lines: mergeLines(
      products.map((product) => ({
        sku: text(product.sku) ?? "UNKNOWN_SKU",
        quantity: Number(text(product.quantity) ?? "1") || 1,
      })),
    ),
  };
}

async function resolveCommerceOrders(
  orderNumbers: string[],
  integrations: Array<{ id: string; platform: string; config: unknown }>,
  issues: Issue[],
) {
  const shopify = integrations.find((row) => row.platform === "SHOPIFY");
  const bigcommerce = integrations.find((row) => row.platform === "BIGCOMMERCE");
  const resolved = new Map<string, PackingOrder>();

  await runConcurrently(orderNumbers, SHOPIFY_CONCURRENCY, async (orderNumber) => {
    const matches: PackingOrder[] = [];
    try {
      const [shopifyOrder, bcOrder] = await Promise.all([
        shopify ? queryShopifyOrder(shopify, orderNumber) : Promise.resolve(null),
        bigcommerce ? queryBigCommerceOrder(bigcommerce, orderNumber) : Promise.resolve(null),
      ]);
      if (shopifyOrder) matches.push(shopifyOrder);
      if (bcOrder) matches.push(bcOrder);
      if (matches.length > 1) {
        issues.push({
          type: "duplicate_platform_match",
          orderNumber,
          detail: matches.map((match) => match.platform).join(","),
        });
      }
      if (matches.length > 0) {
        resolved.set(orderNumber, {
          orderNumber,
          platform: matches.map((match) => match.platform).join(","),
          lines: mergeLines(matches.flatMap((match) => match.lines)),
        });
      }
    } catch (error) {
      issues.push({ type: "commerce_lookup_error", orderNumber, detail: error instanceof Error ? error.message : String(error) });
    }
  });

  return resolved;
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function awsSign(opts: {
  method: string;
  path: string;
  query: string;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
}) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(opts.body);
  const canonicalHeaders =
    `host:${SP_API_HOST}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [opts.method, opts.path, opts.query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${SP_API_REGION}/${SP_API_SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmacSha256(
    hmacSha256(
      hmacSha256(hmacSha256(Buffer.from(`AWS4${opts.secretAccessKey}`, "utf8"), dateStamp), SP_API_REGION),
      SP_API_SERVICE,
    ),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return {
    host: SP_API_HOST,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function getAmazonLwaToken(refreshToken: string): Promise<string> {
  const cached = amazonTokenCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const clientId = process.env.AMAZON_LWA_CLIENT_ID;
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Amazon LWA credentials are not configured.");
  const response = await fetchWithTimeout(AMAZON_LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!response.ok) throw new Error(`Amazon LWA token refresh failed: HTTP ${response.status} ${response.body.slice(0, 240)}`);
  const data = JSON.parse(response.body) as { access_token: string; expires_in: number };
  amazonTokenCache.set(refreshToken, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

async function spApiGet(path: string, lwaToken: string) {
  const accessKeyId = process.env.AMAZON_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AMAZON_AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("Amazon AWS credentials are not configured.");
  let attempt = 0;
  while (true) {
    const headers = awsSign({ method: "GET", path, query: "", body: "", accessKeyId, secretAccessKey });
    const response = await fetchWithTimeout(`https://${SP_API_HOST}${path}`, {
      headers: {
        ...headers,
        "x-amz-access-token": lwaToken,
        Accept: "application/json",
      },
    });
    if (response.status !== 429 || attempt >= 8) return response;
    await new Promise((resolve) => setTimeout(resolve, Math.min(2000 * 2 ** attempt, 30_000)));
    attempt += 1;
  }
}

async function queryAmazonOrder(
  integration: { platform: string; config: unknown },
  orderNumber: string,
): Promise<PackingOrder | null> {
  const config = asRecord(integration.config) ?? {};
  const refreshToken = text(config.refreshToken);
  if (!refreshToken) return null;
  const lwaToken = await getAmazonLwaToken(refreshToken);
  const response = await spApiGet(`/orders/v0/orders/${encodeURIComponent(orderNumber)}/orderItems`, lwaToken);
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Amazon orderItems failed for ${orderNumber}: HTTP ${response.status} ${response.body.slice(0, 240)}`);
  }
  const data = JSON.parse(response.body) as {
    payload?: { OrderItems?: Array<{ SellerSKU?: string; QuantityOrdered?: number }> };
  };
  const items = data.payload?.OrderItems ?? [];
  if (items.length === 0) return null;
  return {
    orderNumber,
    platform: "AMAZON",
    lines: mergeLines(
      items.map((item) => ({
        sku: item.SellerSKU?.trim() || "UNKNOWN_SKU",
        quantity: Number(item.QuantityOrdered ?? 1) || 1,
      })),
    ),
  };
}

async function resolveAmazonOrders(
  orderNumbers: string[],
  integrations: Array<{ id: string; platform: string; config: unknown }>,
  issues: Issue[],
) {
  const amazon = integrations.find((row) => row.platform === "AMAZON");
  const resolved = new Map<string, PackingOrder>();
  if (!amazon) return resolved;

  await runConcurrently(orderNumbers, AMAZON_CONCURRENCY, async (orderNumber) => {
    try {
      const match = await queryAmazonOrder(amazon, orderNumber);
      if (match) resolved.set(orderNumber, match);
    } catch (error) {
      issues.push({ type: "amazon_lookup_error", orderNumber, detail: error instanceof Error ? error.message : String(error) });
    }
  });

  return resolved;
}

function fitFontSize(
  text: string,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  maxWidth: number,
  maxSize: number,
  minSize: number,
) {
  let size = maxSize;
  while (size > minSize && font.widthOfTextAtSize(text, size) > maxWidth) size -= 1;
  return size;
}

async function buildPdf(orders: PackingOrder[]) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);

  for (const order of orders) {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const orderFontSize = fitFontSize(order.orderNumber, bold, PAGE_WIDTH - 28, 28, 16);
    page.drawText(order.orderNumber, {
      x: (PAGE_WIDTH - bold.widthOfTextAtSize(order.orderNumber, orderFontSize)) / 2,
      y: PAGE_HEIGHT - 58,
      size: orderFontSize,
      font: bold,
      color: black,
    });

    page.drawLine({
      start: { x: 18, y: PAGE_HEIGHT - 82 },
      end: { x: PAGE_WIDTH - 18, y: PAGE_HEIGHT - 82 },
      thickness: 1,
      color: black,
    });

    page.drawText("SKU", { x: 24, y: PAGE_HEIGHT - 112, size: 13, font: bold, color: black });
    page.drawText("QTY", { x: PAGE_WIDTH - 55, y: PAGE_HEIGHT - 112, size: 13, font: bold, color: black });

    let y = PAGE_HEIGHT - 140;
    for (const line of order.lines) {
      if (y < 24) break;
      const skuFontSize = fitFontSize(line.sku, regular, PAGE_WIDTH - 92, 12, 7);
      page.drawText(line.sku, { x: 24, y, size: skuFontSize, font: regular, color: black });
      page.drawText(String(line.quantity), {
        x: PAGE_WIDTH - 42,
        y,
        size: 12,
        font: regular,
        color: black,
      });
      y -= 22;
    }
  }

  return pdf.save();
}

async function writeAudit(orders: PackingOrder[], issues: Issue[]) {
  const workbook = new ExcelJS.Workbook();
  const ordersSheet = workbook.addWorksheet("resolved");
  ordersSheet.columns = [
    { header: "orderNumber", key: "orderNumber", width: 22 },
    { header: "platform", key: "platform", width: 16 },
    { header: "sku", key: "sku", width: 44 },
    { header: "quantity", key: "quantity", width: 10 },
  ];
  for (const order of orders) {
    for (const line of order.lines) {
      ordersSheet.addRow({
        orderNumber: order.orderNumber,
        platform: order.platform ?? "",
        sku: line.sku,
        quantity: line.quantity,
      });
    }
  }

  const issuesSheet = workbook.addWorksheet("issues");
  issuesSheet.columns = [
    { header: "type", key: "type", width: 20 },
    { header: "orderNumber", key: "orderNumber", width: 24 },
    { header: "detail", key: "detail", width: 80 },
  ];
  for (const issue of issues) issuesSheet.addRow(issue);

  await workbook.xlsx.writeFile(auditPath);
}

async function main() {
  const host = hostFromUrl(process.env.DATABASE_URL ?? "");
  console.log(`[packing-slips] DATABASE_URL host=${host || "(unset)"}`);
  if (!host.includes("little-fire")) {
    throw new Error("Refusing to run: expected prod little-fire DATABASE_URL.");
  }

  const orderNumbers = await readOrderNumbers();
  const uniqueOrderNumbers = [...new Set(orderNumbers)];
  console.log(`[packing-slips] workbook order rows=${orderNumbers.length}, unique=${uniqueOrderNumbers.length}`);

  const issues: Issue[] = [];
  const saleOrders = await db.marketplaceSaleOrder.findMany({
    where: { externalOrderId: { in: uniqueOrderNumbers } },
    select: {
      externalOrderId: true,
      platform: true,
      lines: {
        select: { sku: true, quantity: true },
      },
    },
    orderBy: [{ platform: "asc" }, { externalOrderId: "asc" }],
  });
  console.log(`[packing-slips] synced DB matches=${saleOrders.length}`);

  const integrations = await db.integration.findMany({
    where: { platform: { in: ["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY", "AMAZON"] }, enabled: true },
    select: { id: true, platform: true, config: true },
  });
  console.log(`[packing-slips] enabled integrations=${integrations.map((row) => row.platform).join(",")}`);

  const byOrderNumber = new Map<string, PackingOrder[]>();
  for (const saleOrder of saleOrders) {
    const bucket = byOrderNumber.get(saleOrder.externalOrderId) ?? [];
    bucket.push({
      orderNumber: saleOrder.externalOrderId,
      platform: saleOrder.platform,
      lines: mergeLines(saleOrder.lines.map((line) => ({ sku: line.sku, quantity: line.quantity }))),
    });
    byOrderNumber.set(saleOrder.externalOrderId, bucket);
  }

  const missingAfterDb = uniqueOrderNumbers.filter((orderNumber) => !byOrderNumber.has(orderNumber));
  const ebayIds = missingAfterDb.filter((orderNumber) => EBAY_ORDER_REGEX.test(orderNumber));
  const amazonIds = missingAfterDb.filter((orderNumber) => AMAZON_ORDER_REGEX.test(orderNumber));
  const commerceIds = missingAfterDb.filter(
    (orderNumber) =>
      NUMERIC_ORDER_REGEX.test(orderNumber) ||
      (orderNumber.startsWith("#") && NUMERIC_ORDER_REGEX.test(orderNumber.slice(1))),
  );

  console.log(`[packing-slips] live lookup needed: eBay=${ebayIds.length}, Amazon=${amazonIds.length}, commerce=${commerceIds.length}`);

  const [liveEbay, liveAmazon, liveCommerce] = await Promise.all([
    resolveEbayOrders(ebayIds, integrations, issues),
    resolveAmazonOrders(amazonIds, integrations, issues),
    resolveCommerceOrders(commerceIds, integrations, issues),
  ]);

  for (const liveMap of [liveEbay, liveAmazon, liveCommerce]) {
    liveMap.forEach((order, orderNumber) => {
      const bucket = byOrderNumber.get(orderNumber) ?? [];
      bucket.push(order);
      byOrderNumber.set(orderNumber, bucket);
    });
  }

  const missing: string[] = [];
  const outputOrders = orderNumbers.map((orderNumber): PackingOrder => {
    const matches = byOrderNumber.get(orderNumber) ?? [];
    if (matches.length === 0) {
      missing.push(orderNumber);
      return { orderNumber, platform: null, lines: [{ sku: "ORDER_NOT_FOUND", quantity: 0 }] };
    }
    if (matches.length > 1) {
      issues.push({
        type: "duplicate_source_match",
        orderNumber,
        detail: matches.map((match) => match.platform ?? "UNKNOWN").join(","),
      });
    }
    const lines = mergeLines(
      matches.flatMap((match) =>
        match.lines.map((line) => ({ sku: line.sku, quantity: line.quantity })),
      ),
    );
    return {
      orderNumber,
      platform: matches.map((match) => match.platform ?? "UNKNOWN").join(","),
      lines: lines.length > 0 ? lines : [{ sku: "NO_LINE_ITEMS_FOUND", quantity: 0 }],
    };
  });

  for (const orderNumber of [...new Set(missing)]) {
    issues.push({ type: "missing", orderNumber });
  }

  const bytes = await buildPdf(outputOrders);
  await writeFile(outputPath, Buffer.from(bytes));
  await writeAudit(outputOrders, issues);

  const platformCounts = new Map<string, number>();
  for (const order of outputOrders) {
    platformCounts.set(order.platform ?? "MISSING", (platformCounts.get(order.platform ?? "MISSING") ?? 0) + 1);
  }

  console.log(`[packing-slips] wrote PDF=${outputPath}`);
  console.log(`[packing-slips] wrote audit=${auditPath}`);
  console.log(`[packing-slips] pages=${outputOrders.length}`);
  console.log(`[packing-slips] missing unique=${new Set(missing).size}`);
  console.log(`[packing-slips] issues=${issues.length}`);
  console.log(`[packing-slips] platform counts=${JSON.stringify(Object.fromEntries(platformCounts))}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
