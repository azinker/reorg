/**
 * Targeted buyer-name refresh.
 *
 * Strategy:
 *   1. Find every helpdesk ticket that:
 *      - has an ebayOrderNumber
 *      - is open (NEW/TO_DO/WAITING/RESOLVED, not archived/spam)
 *      - and the linked MarketplaceSaleOrder.buyerDisplayLabel is
 *        either null OR equals the username (= buyerIdentifier)
 *   2. Group those order IDs by platform (TPP_EBAY / TT_EBAY).
 *   3. For each group, call eBay Trading API `GetOrders` with
 *      `OrderIDArray.OrderID` (up to 50 per call) — way faster than
 *      the time-window-based sync we use for the forecaster.
 *   4. Pull the buyer fields out of each returned <Order>:
 *         Buyer.UserFirstName / UserLastName  (best — exact)
 *         ShippingAddress.Name                 (GDPR-safe fallback,
 *                                              accept only if 2+ tokens)
 *         BuyerUserID                          (last resort)
 *   5. Update MarketplaceSaleOrder.buyerDisplayLabel + buyerEmail.
 *   6. Update HelpdeskTicket.buyerName when we got a real "First Last".
 *
 * Pass --apply to actually write. Without it we just print stats.
 *
 * Designed to run against prod via `scripts/run-with-prod.ps1`.
 */
import { XMLParser } from "fast-xml-parser";
import type { Integration, Platform } from "@prisma/client";
import { db } from "@/lib/db";

const APPLY = process.argv.includes("--apply");
const ORDER_BATCH = 20; // GetOrders OrderIDArray limit is 50; stay conservative

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  isArray: (tagName) => {
    const arr = new Set([
      "Order",
      "Transaction",
      "OrderID",
      "Error",
      "Errors",
    ]);
    return arr.has(tagName);
  },
});

type EbayCfg = {
  appId: string;
  certId: string;
  refreshToken: string;
  environment: "PRODUCTION" | "SANDBOX";
};

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
  const r = asRecord(source);
  if (!r) return undefined;
  const v = r[key];
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  const nested = asRecord(v);
  if (nested && typeof nested["#text"] === "string") {
    return nested["#text"] as string;
  }
  return undefined;
}
function looksReal(label: string | null | undefined): boolean {
  if (!label) return false;
  const t = label.trim();
  return /^\S+\s+\S+/.test(t) && /[A-Za-z]/.test(t);
}

function envCfg(platform: Platform): Partial<EbayCfg> {
  if (platform === "TPP_EBAY") {
    return {
      appId: process.env.EBAY_TPP_APP_ID,
      certId: process.env.EBAY_TPP_CERT_ID,
      refreshToken: process.env.EBAY_TPP_REFRESH_TOKEN,
      environment: (process.env.EBAY_TPP_ENVIRONMENT ??
        "PRODUCTION") as "PRODUCTION" | "SANDBOX",
    };
  }
  if (platform === "TT_EBAY") {
    return {
      appId: process.env.EBAY_TT_APP_ID ?? process.env.EBAY_TPP_APP_ID,
      certId: process.env.EBAY_TT_CERT_ID ?? process.env.EBAY_TPP_CERT_ID,
      refreshToken: process.env.EBAY_TT_REFRESH_TOKEN,
      environment: (process.env.EBAY_TT_ENVIRONMENT ??
        process.env.EBAY_TPP_ENVIRONMENT ??
        "PRODUCTION") as "PRODUCTION" | "SANDBOX",
    };
  }
  return {};
}

function resolveCfg(integration: Integration): EbayCfg {
  const raw = (asRecord(integration.config) ?? {}) as Record<string, unknown>;
  const env = envCfg(integration.platform);
  const appId =
    (typeof raw.appId === "string" && raw.appId) ||
    env.appId;
  const certId =
    (typeof raw.certId === "string" && raw.certId) ||
    env.certId;
  const refreshToken =
    (typeof raw.refreshToken === "string" && raw.refreshToken) ||
    env.refreshToken;
  const environment =
    ((typeof raw.environment === "string" && raw.environment) ||
      env.environment ||
      "PRODUCTION") as "PRODUCTION" | "SANDBOX";

  if (!appId || !certId || !refreshToken) {
    throw new Error(
      `Missing eBay credentials for ${integration.label}. Set EBAY_${integration.platform === "TPP_EBAY" ? "TPP" : "TT"}_* env vars or save in Integration.config.`,
    );
  }
  return { appId, certId, refreshToken, environment };
}

async function getAccessToken(cfg: EbayCfg): Promise<string> {
  const baseUrl =
    cfg.environment === "PRODUCTION"
      ? "https://api.ebay.com"
      : "https://api.sandbox.ebay.com";
  const credentials = Buffer.from(`${cfg.appId}:${cfg.certId}`).toString(
    "base64",
  );
  const response = await fetch(`${baseUrl}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cfg.refreshToken,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `eBay token refresh failed: ${response.status} ${await response.text()}`,
    );
  }
  const json = (await response.json()) as { access_token: string };
  return json.access_token;
}

interface OrderBuyerFields {
  externalOrderId: string;
  buyerIdentifier: string | null;
  buyerDisplayLabel: string | null;
  buyerEmail: string | null;
}

async function fetchOrdersByIds(
  cfg: EbayCfg,
  orderIds: string[],
): Promise<OrderBuyerFields[]> {
  const url =
    cfg.environment === "PRODUCTION"
      ? "https://api.ebay.com/ws/api.dll"
      : "https://api.sandbox.ebay.com/ws/api.dll";
  const token = await getAccessToken(cfg);
  const idXml = orderIds
    .map((id) => `    <OrderID>${id}</OrderID>`)
    .join("\n");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderIDArray>
${idXml}
  </OrderIDArray>
  <OrderRole>Seller</OrderRole>
  <OrderStatus>All</OrderStatus>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": token,
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1199",
      "X-EBAY-API-CALL-NAME": "GetOrders",
      "Content-Type": "text/xml",
    },
    body,
  });
  const xml = await response.text();
  if (!response.ok) {
    throw new Error(
      `GetOrders by ID failed: ${response.status} ${xml.slice(0, 300)}`,
    );
  }
  const parsed = parser.parse(xml);
  const payload = asRecord(parsed?.GetOrdersResponse);
  const errors = asArray<Record<string, unknown>>(payload?.Errors);
  const failure = errors.find(
    (e) => (readText(e, "SeverityCode") ?? "Error").toLowerCase() !== "warning",
  );
  if (failure) {
    throw new Error(readText(failure, "LongMessage") ?? "GetOrders failed");
  }
  const orders = asArray<Record<string, unknown>>(
    payload?.OrderArray ? asRecord(payload.OrderArray)?.Order : [],
  );

  const out: OrderBuyerFields[] = [];
  for (const order of orders) {
    const externalOrderId =
      readText(order, "OrderID") ?? readText(order, "ExtendedOrderID");
    if (!externalOrderId) continue;

    const transactions = asArray<Record<string, unknown>>(
      asRecord(order.TransactionArray)?.Transaction,
    );
    const firstTx = transactions[0];
    const buyerNode = firstTx ? asRecord(firstTx.Buyer) : undefined;
    const shippingAddressNode = asRecord(order.ShippingAddress);
    const buyerIdentifier =
      readText(order, "BuyerUserID") ??
      (buyerNode ? readText(buyerNode, "UserID") : undefined) ??
      null;
    const buyerFirst = buyerNode ? readText(buyerNode, "UserFirstName") : null;
    const buyerLast = buyerNode ? readText(buyerNode, "UserLastName") : null;
    const buyerNameFromNode =
      buyerFirst || buyerLast
        ? [buyerFirst, buyerLast].filter(Boolean).join(" ")
        : null;
    const shippingName = shippingAddressNode
      ? (readText(shippingAddressNode, "Name") ?? null)
      : null;
    const shippingLooksReal =
      !!shippingName && /^\S+\s+\S+/.test(shippingName);
    const buyerEmail = buyerNode
      ? (readText(buyerNode, "Email") ?? null)
      : null;
    const buyerDisplayLabel =
      buyerNameFromNode ??
      (shippingLooksReal ? shippingName : null) ??
      buyerIdentifier;

    out.push({
      externalOrderId,
      buyerIdentifier,
      buyerDisplayLabel,
      buyerEmail:
        buyerEmail && /\S+@\S+/.test(buyerEmail) ? buyerEmail : null,
    });
  }
  return out;
}

async function main() {
  const mode = APPLY ? "APPLY" : "DRY-RUN";
  console.log(`[refresh-buyer-names-targeted] starting (${mode})`);

  // 1. Pull all candidate tickets
  const tickets = await db.helpdeskTicket.findMany({
    where: {
      ebayOrderNumber: { not: null },
      isArchived: false,
      isSpam: false,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lt: new Date() } }],
    },
    select: {
      id: true,
      channel: true,
      ebayOrderNumber: true,
      buyerName: true,
      buyerUserId: true,
    },
  });
  console.log(`  open tickets w/ order#: ${tickets.length}`);

  // 2. Pull associated MarketplaceSaleOrder rows
  const orderRows = await db.marketplaceSaleOrder.findMany({
    where: {
      OR: tickets.map((t) => ({
        platform: t.channel,
        externalOrderId: t.ebayOrderNumber!,
      })),
    },
    select: {
      platform: true,
      externalOrderId: true,
      buyerIdentifier: true,
      buyerDisplayLabel: true,
    },
  });
  const orderMap = new Map(
    orderRows.map((o) => [`${o.platform}::${o.externalOrderId}`, o]),
  );

  // 3. Decide which orders need a refresh
  const toFetch = new Map<Platform, Set<string>>();
  let alreadyGood = 0;
  let willFetch = 0;
  for (const t of tickets) {
    const key = `${t.channel}::${t.ebayOrderNumber}`;
    const order = orderMap.get(key);
    const orderLabel = order?.buyerDisplayLabel ?? null;
    if (looksReal(orderLabel)) {
      alreadyGood++;
      continue;
    }
    if (!toFetch.has(t.channel)) toFetch.set(t.channel, new Set());
    toFetch.get(t.channel)!.add(t.ebayOrderNumber!);
    willFetch++;
  }
  console.log(`  already have real label:  ${alreadyGood}`);
  console.log(`  will refresh from eBay:   ${willFetch}`);
  for (const [p, ids] of toFetch) {
    console.log(`    ${p}: ${ids.size} unique orders`);
  }

  if (willFetch === 0) {
    console.log("  nothing to do");
    await db.$disconnect();
    return;
  }

  // 4. Fetch integrations
  const integrations = await db.integration.findMany({
    where: { platform: { in: [...toFetch.keys()] }, enabled: true },
  });
  const integByPlatform = new Map<Platform, Integration>();
  for (const i of integrations) integByPlatform.set(i.platform, i);

  // 5. For each platform, batch-fetch
  const fetched: OrderBuyerFields[] = [];
  for (const [platform, idSet] of toFetch) {
    const integration = integByPlatform.get(platform);
    if (!integration) {
      console.warn(`  no enabled integration for ${platform} — skipping`);
      continue;
    }
    let cfg: EbayCfg;
    try {
      cfg = resolveCfg(integration);
    } catch (err) {
      console.error(`  ${platform} cfg error:`, err);
      continue;
    }

    const ids = [...idSet];
    console.log(`\n── ${platform}: fetching ${ids.length} orders ──`);
    for (let i = 0; i < ids.length; i += ORDER_BATCH) {
      const slice = ids.slice(i, i + ORDER_BATCH);
      try {
        const got = await fetchOrdersByIds(cfg, slice);
        for (const g of got) {
          fetched.push({ ...g, externalOrderId: g.externalOrderId });
        }
        const realCount = got.filter((g) => looksReal(g.buyerDisplayLabel))
          .length;
        console.log(
          `   batch ${Math.floor(i / ORDER_BATCH) + 1}: requested ${slice.length}, got ${got.length}, real names ${realCount}`,
        );
      } catch (err) {
        console.error(`   batch ${Math.floor(i / ORDER_BATCH) + 1} failed:`, err);
      }
    }

    // 6. Apply to MarketplaceSaleOrder
    let mosUpdated = 0;
    for (const f of fetched) {
      // (Note: fetched isn't grouped by platform — but externalOrderId is
      // unique-per-platform anyway because we're fetching by ID via the
      // platform-specific Integration credentials.)
      if (!APPLY) continue;
      const data: Record<string, string> = {};
      if (f.buyerIdentifier) data.buyerIdentifier = f.buyerIdentifier;
      if (f.buyerDisplayLabel) data.buyerDisplayLabel = f.buyerDisplayLabel;
      if (f.buyerEmail) data.buyerEmail = f.buyerEmail;
      if (Object.keys(data).length === 0) continue;
      try {
        const res = await db.marketplaceSaleOrder.updateMany({
          where: { platform, externalOrderId: f.externalOrderId },
          data,
        });
        if (res.count > 0) mosUpdated++;
      } catch (err) {
        console.error(`   updateMany failed for ${f.externalOrderId}:`, err);
      }
    }
    console.log(`   MarketplaceSaleOrder rows updated: ${mosUpdated}`);
    fetched.length = 0;
  }

  // 7. Cascade to HelpdeskTicket.buyerName
  const refreshedOrders = await db.marketplaceSaleOrder.findMany({
    where: {
      OR: tickets.map((t) => ({
        platform: t.channel,
        externalOrderId: t.ebayOrderNumber!,
      })),
    },
    select: {
      platform: true,
      externalOrderId: true,
      buyerDisplayLabel: true,
    },
  });
  const newOrderMap = new Map(
    refreshedOrders.map((o) => [
      `${o.platform}::${o.externalOrderId}`,
      o.buyerDisplayLabel,
    ]),
  );

  let ticketsUpdated = 0;
  let ticketsSkipped = 0;
  for (const t of tickets) {
    const label = newOrderMap.get(`${t.channel}::${t.ebayOrderNumber}`);
    if (!looksReal(label)) {
      ticketsSkipped++;
      continue;
    }
    if (
      t.buyerName &&
      t.buyerName.trim().toLowerCase() === label!.trim().toLowerCase()
    ) {
      continue;
    }
    if (!APPLY) {
      ticketsUpdated++;
      continue;
    }
    try {
      await db.helpdeskTicket.update({
        where: { id: t.id },
        data: { buyerName: label! },
      });
      ticketsUpdated++;
    } catch (err) {
      console.error(`   ticket ${t.id} update failed:`, err);
    }
  }

  console.log("\n[refresh-buyer-names-targeted] done");
  console.log(`  tickets updated:        ${ticketsUpdated}`);
  console.log(`  tickets still no name:  ${ticketsSkipped}`);
  if (!APPLY) {
    console.log("\n  (dry-run — pass --apply to actually write)");
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
