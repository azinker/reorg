import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { db } from "@/lib/db";
import { getManageOrderDetail } from "@/lib/manage-orders/ebay";
import { checkWriteSafety } from "@/lib/safety";
import { buildEbayConfig, getEbayAccessToken } from "@/lib/services/auto-responder-ebay";
import type { EbayStore } from "@/lib/manage-orders/types";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const STORES: EbayStore[] = ["TPP_EBAY", "TT_EBAY"];
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });

type TrackingInput = {
  carrier: "USPS" | "UPS" | "FedEx";
  trackingNumber: string;
};

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeTracking(value: string | null | undefined) {
  return (value ?? "").replace(/[\s-]+/g, "").toUpperCase();
}

function assertProdDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(databaseUrl).host;
  console.log(`[guard] DATABASE_URL host: ${host}`);
  if (!host.includes("little-fire")) {
    throw new Error("Refusing to use production order data because DATABASE_URL is not little-fire.");
  }
}

function liveMutationFlagEnabled() {
  return process.env.ENABLE_LIVE_EBAY_ORDER_MUTATIONS === "true";
}

async function completeSale(store: EbayStore, apiOrderId: string, tracking: TrackingInput) {
  return completeSaleWithTracking(store, apiOrderId, [tracking]);
}

async function completeSaleWithTracking(store: EbayStore, apiOrderId: string, trackingRows: TrackingInput[]) {
  const integration = await db.integration.findUnique({ where: { platform: store } });
  if (!integration) throw new Error(`Integration not found for ${store}`);

  const accessToken = await getEbayAccessToken(integration.id, buildEbayConfig(integration));
  const trackingXml = trackingRows
    .map((tracking) => `    <ShipmentTrackingDetails>
      <ShippingCarrierUsed>${escapeXml(tracking.carrier)}</ShippingCarrierUsed>
      <ShipmentTrackingNumber>${escapeXml(tracking.trackingNumber)}</ShipmentTrackingNumber>
    </ShipmentTrackingDetails>`)
    .join("\n");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<CompleteSaleRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderID>${escapeXml(apiOrderId)}</OrderID>
  <Shipped>true</Shipped>
  <Shipment>
${trackingXml}
  </Shipment>
</CompleteSaleRequest>`;

  const response = await fetch(TRADING_API, {
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
  const xml = await response.text();
  if (!response.ok) throw new Error(`CompleteSale HTTP ${response.status}: ${xml.slice(0, 300)}`);

  const parsed = parser.parse(xml) as Record<string, unknown>;
  const root = parsed.CompleteSaleResponse as Record<string, unknown> | undefined;
  const ack = root?.Ack ? String(root.Ack) : "Unknown";
  if (ack !== "Success" && ack !== "Warning") {
    throw new Error(`CompleteSale ${ack}: ${xml.slice(0, 600)}`);
  }
  const warnings = extractMessages(root).filter((message) => message.severity !== "Error");
  return { ack, warnings };
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function extractMessages(root: Record<string, unknown> | undefined) {
  const errors = asArray(root?.Errors as Record<string, unknown> | Record<string, unknown>[] | undefined);
  return errors.map((error) => ({
    severity: typeof error.SeverityCode === "string" ? error.SeverityCode : null,
    code: typeof error.ErrorCode === "string" ? error.ErrorCode : null,
    shortMessage: typeof error.ShortMessage === "string" ? error.ShortMessage : null,
    longMessage: typeof error.LongMessage === "string" ? error.LongMessage : null,
  }));
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env.prod"));
  Reflect.set(process.env, "NODE_ENV", "production");
  process.env.NEXT_PUBLIC_APP_ENV = "production";
  assertProdDatabase();

  const orderId = argValue("--order")?.trim();
  const trackingNumber = argValue("--tracking")?.trim();
  const send = hasFlag("--send");
  const confirmedOrder = argValue("--confirmed-order")?.trim();
  const carrier = (argValue("--carrier")?.trim() || "USPS") as TrackingInput["carrier"];
  const actorEmail = argValue("--actor-email")?.trim() || "Adam@theperfectpart.net";
  const onlyNew = hasFlag("--only-new");

  if (!orderId || !trackingNumber) {
    throw new Error("Usage: npx tsx scripts/_add-ebay-tracking-number.ts --order=22-14635-84476 --tracking=930... [--send --confirmed-order=22-14635-84476]");
  }
  if (!["USPS", "UPS", "FedEx"].includes(carrier)) {
    throw new Error("--carrier must be USPS, UPS, or FedEx.");
  }

  const matches = [];
  for (const store of STORES) {
    const order = await getManageOrderDetail(store, orderId);
    if (!order) continue;
    const safety = await checkWriteSafety(store);
    matches.push({ store, order, safety });
  }

  const existingTracking = matches.flatMap((match) => match.order.trackingNumbers.map((tracking) => ({
    store: match.store,
    carrier: tracking.carrier,
    number: tracking.number,
    shippedTime: tracking.shippedTime,
  })));
  const alreadyPresent = existingTracking.some((tracking) => normalizeTracking(tracking.number) === normalizeTracking(trackingNumber));
  const blockers = [
    ...(matches.length === 0 ? ["Order was not found in TPP or TT eBay."] : []),
    ...(matches.length > 1 ? ["Order matched more than one eBay store; refusing automatic write."] : []),
    ...(alreadyPresent ? ["Tracking number is already present on the order."] : []),
    ...matches.flatMap((match) => match.safety.allowed ? [] : [`${match.store}: ${match.safety.reason ?? "Write not allowed"}`]),
    ...(send && !liveMutationFlagEnabled() ? ["ENABLE_LIVE_EBAY_ORDER_MUTATIONS is not true."] : []),
    ...(send && confirmedOrder !== orderId ? ["--confirmed-order must exactly match --order for live send."] : []),
  ];

  const selected = matches.length === 1 ? matches[0] : null;
  const trackingRowsToSend = selected
    ? onlyNew
      ? [{ carrier, trackingNumber }]
      : [
          ...selected.order.trackingNumbers
            .filter((tracking) => tracking.number)
            .map((tracking) => ({
              carrier: (tracking.carrier === "UPS" || tracking.carrier === "FedEx" ? tracking.carrier : "USPS") as TrackingInput["carrier"],
              trackingNumber: tracking.number!,
            })),
          { carrier, trackingNumber },
        ].filter((tracking, index, all) =>
          all.findIndex((other) => normalizeTracking(other.trackingNumber) === normalizeTracking(tracking.trackingNumber)) === index,
        )
    : [];
  const dryRunSummary = {
    dryRun: !send,
    marketplaceWritesPerformed: 0,
    requestedAction: "add_tracking",
    onlyNew,
    orderId,
    trackingToAdd: { carrier, trackingNumber },
    matchingStores: matches.map((match) => ({
      store: match.store,
      apiOrderId: match.order.apiOrderId,
      displayOrderId: match.order.orderId,
      existingTracking: match.order.trackingNumbers,
      lineCount: match.order.lines.length,
      safety: match.safety,
    })),
    alreadyPresent,
    wouldSend: selected && blockers.length === 0 ? {
      api: "eBay Trading API CompleteSale",
      store: selected.store,
      orderId: selected.order.apiOrderId,
      shipped: true,
      shipmentTrackingDetails: trackingRowsToSend,
      note: onlyNew
        ? "This request sends only the new tracking number."
        : "This request includes existing tracking plus the new tracking so eBay preserves both details.",
    } : null,
    blockers,
  };

  console.log(JSON.stringify(dryRunSummary, null, 2));

  if (!send) return;
  if (!selected || blockers.length > 0) {
    throw new Error("Refusing live send because dry-run blockers are present.");
  }

  const actor = await db.user.findFirst({
    where: { email: { equals: actorEmail, mode: "insensitive" } },
    select: { id: true, email: true },
  });
  if (!actor) throw new Error(`Actor user not found: ${actorEmail}`);

  const result = await completeSaleWithTracking(selected.store, selected.order.apiOrderId, trackingRowsToSend);
  await db.auditLog.create({
    data: {
      userId: actor.id,
      action: "manage_orders_ebay_action",
      entityType: "ebay_order",
      entityId: orderId,
      details: {
        feature: "manage_orders_cli",
        actionType: "add_tracking",
        store: selected.store,
        apiOrderId: selected.order.apiOrderId,
        trackingNumbers: [{ carrier, trackingNumber }],
        trackingNumbersSentToEbay: trackingRowsToSend,
        marketplaceAck: result.ack,
        marketplaceWarnings: result.warnings,
        mode: "single_order_confirmed_cli",
      },
    },
  });

  const verified = await getManageOrderDetail(selected.store, orderId);
  console.log(JSON.stringify({
    marketplaceWritesPerformed: 1,
    orderId,
    store: selected.store,
    marketplaceAck: result.ack,
    marketplaceWarnings: result.warnings,
    trackingNumbersSentToEbay: trackingRowsToSend,
    verifiedTracking: verified?.trackingNumbers ?? [],
    verificationStatus: verified?.trackingNumbers.some((tracking) => normalizeTracking(tracking.number) === normalizeTracking(trackingNumber))
      ? "verified"
      : "unverified",
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect().catch(() => {}));
