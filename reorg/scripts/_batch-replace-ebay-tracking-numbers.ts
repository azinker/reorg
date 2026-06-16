import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { XMLParser } from "fast-xml-parser";
import { db } from "@/lib/db";
import { getManageOrderDetail } from "@/lib/manage-orders/ebay";
import { checkWriteSafety } from "@/lib/safety";
import { buildEbayConfig, getEbayAccessToken } from "@/lib/services/auto-responder-ebay";
import type { EbayStore, ManageOrder } from "@/lib/manage-orders/types";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const STORES: EbayStore[] = ["TPP_EBAY", "TT_EBAY"];
const ORDER_ID_PATTERN = /^\d{2}-\d{5}-\d{5}$/;
const TRACKING_PATTERN = /^[A-Z0-9]{4,}$/i;
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });

type TrackingPayloadRow = {
  carrier: "USPS" | "UPS" | "FedEx";
  trackingNumber: string;
};

type InputRow = {
  sourceRow: number;
  orderId: string;
  replacementTrackingNumber: string;
};

type Match = {
  store: EbayStore;
  order: ManageOrder;
  safety: Awaited<ReturnType<typeof checkWriteSafety>>;
};

type PlanEntry = InputRow & {
  status: "ready" | "blocked" | "no_change";
  store: EbayStore | null;
  apiOrderId: string | null;
  existingTracking: ManageOrder["trackingNumbers"];
  replacementPayload: TrackingPayloadRow[];
  blockers: string[];
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

function assertProdDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(databaseUrl).host;
  console.log(`[guard] DATABASE_URL host: ${host}`);
  if (!host.includes("little-fire")) {
    throw new Error("Refusing to use production order data because DATABASE_URL is not little-fire.");
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

function normalizeCarrier(value: string | null | undefined): TrackingPayloadRow["carrier"] {
  if (value === "UPS" || value === "FedEx") return value;
  return "USPS";
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

function uniqueTrackingRows(rows: ManageOrder["trackingNumbers"]) {
  const seen = new Set<string>();
  const unique = [];
  for (const row of rows) {
    const normalized = normalizeTracking(row.number);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(row);
  }
  return unique;
}

async function completeSaleWithTracking(store: EbayStore, apiOrderId: string, trackingRows: TrackingPayloadRow[]) {
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
  return { ack, warnings: extractMessages(root).filter((message) => message.severity !== "Error") };
}

async function parseWorkbook(filePath: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Workbook has no worksheets.");

  const rows: InputRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    const replacementTrackingNumber = row.getCell(1).text.trim().replace(/\s+/g, "");
    const orderId = row.getCell(18).text.trim();
    if (!replacementTrackingNumber && !orderId) return;
    if (rowNumber === 1 && !ORDER_ID_PATTERN.test(orderId)) return;
    rows.push({ sourceRow: rowNumber, orderId, replacementTrackingNumber });
  });
  return rows;
}

async function findMatches(orderId: string) {
  const matches: Match[] = [];
  for (const store of STORES) {
    const order = await getManageOrderDetail(store, orderId);
    if (!order) continue;
    const safety = await checkWriteSafety(store);
    matches.push({ store, order, safety });
  }
  return matches;
}

async function buildPlan(input: InputRow[]) {
  const seenOrders = new Map<string, number>();
  const seenTracking = new Map<string, number>();
  const entries: PlanEntry[] = [];

  for (const row of input) {
    const blockers: string[] = [];
    if (!ORDER_ID_PATTERN.test(row.orderId)) blockers.push("Order number is not an eBay order ID.");
    if (!row.replacementTrackingNumber) blockers.push("Replacement tracking number is blank.");
    if (row.replacementTrackingNumber && !TRACKING_PATTERN.test(row.replacementTrackingNumber)) {
      blockers.push("Replacement tracking number must contain only letters and numbers.");
    }

    const normalizedOrder = row.orderId.toUpperCase();
    const normalizedReplacement = normalizeTracking(row.replacementTrackingNumber);
    const previousOrderRow = seenOrders.get(normalizedOrder);
    if (normalizedOrder && previousOrderRow !== undefined) {
      blockers.push(`Duplicate order number in workbook; first seen on row ${previousOrderRow}.`);
    }
    seenOrders.set(normalizedOrder, row.sourceRow);

    const previousTrackingRow = seenTracking.get(normalizedReplacement);
    if (normalizedReplacement && previousTrackingRow !== undefined) {
      blockers.push(`Duplicate replacement tracking number in workbook; first seen on row ${previousTrackingRow}.`);
    }
    seenTracking.set(normalizedReplacement, row.sourceRow);

    const matches = blockers.length === 0 ? await findMatches(row.orderId) : [];
    if (blockers.length === 0 && matches.length === 0) blockers.push("Order was not found in TPP or TT eBay.");
    if (matches.length > 1) blockers.push("Order matched more than one eBay store.");

    const selected = matches.length === 1 ? matches[0] : null;
    const existingTracking = selected?.order.trackingNumbers ?? [];
    const uniqueExistingTracking = uniqueTrackingRows(existingTracking);
    if (selected && uniqueExistingTracking.length === 0) {
      blockers.push("Order currently has no tracking number to replace.");
    }
    if (selected && uniqueExistingTracking.length > 1) {
      blockers.push(`Order has ${uniqueExistingTracking.length} existing tracking numbers; refusing to collapse them into one automatically.`);
    }

    const existingTrackingNumber = uniqueExistingTracking[0]?.number ?? null;
    const replacementAlreadyCurrent =
      Boolean(existingTrackingNumber) && normalizeTracking(existingTrackingNumber) === normalizedReplacement;

    if (selected && !replacementAlreadyCurrent) {
      blockers.push(...matches.flatMap((match) => match.safety.allowed ? [] : [`${match.store}: ${match.safety.reason ?? "Write not allowed"}`]));
    }

    const status: PlanEntry["status"] = blockers.length > 0 ? "blocked" : replacementAlreadyCurrent ? "no_change" : "ready";
    entries.push({
      ...row,
      status,
      store: selected?.store ?? null,
      apiOrderId: selected?.order.apiOrderId ?? null,
      existingTracking,
      replacementPayload: selected
        ? [{
            carrier: normalizeCarrier(uniqueExistingTracking[0]?.carrier),
            trackingNumber: row.replacementTrackingNumber,
          }]
        : [],
      blockers,
    });
  }

  return entries;
}

function summarizeByStore(rows: PlanEntry[]) {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const key = row.store ?? "UNMATCHED";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function verificationStatus(
  verifiedTracking: ManageOrder["trackingNumbers"],
  replacementTrackingNumber: string,
  previousTrackingNumber: string | null,
) {
  const hasReplacement = verifiedTracking.some((tracking) =>
    normalizeTracking(tracking.number) === normalizeTracking(replacementTrackingNumber)
  );
  const hasPrevious = Boolean(previousTrackingNumber) && verifiedTracking.some((tracking) =>
    normalizeTracking(tracking.number) === normalizeTracking(previousTrackingNumber)
  );
  if (hasReplacement && !hasPrevious) return "verified_replaced";
  if (hasReplacement && hasPrevious) return "new_present_old_still_present";
  return "unverified";
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env.prod"));
  Reflect.set(process.env, "NODE_ENV", "production");
  process.env.NEXT_PUBLIC_APP_ENV = "production";
  assertProdDatabase();

  const filePath = argValue("--file");
  const send = hasFlag("--send");
  const confirmed = hasFlag("--confirmed-batch");
  const actorEmail = argValue("--actor-email")?.trim() || "Adam@theperfectpart.net";
  const reportPath =
    argValue("--report") ??
    path.join("reports", `ebay-tracking-replace-dry-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

  if (!filePath) throw new Error('Missing --file="C:\\...\\Workbook.xlsx"');
  if (send && !confirmed) throw new Error("Live replacement requires --confirmed-batch.");
  if (send && process.env.ENABLE_LIVE_EBAY_ORDER_MUTATIONS !== "true") {
    throw new Error("Live replacement requires ENABLE_LIVE_EBAY_ORDER_MUTATIONS=true.");
  }

  const parsedRows = await parseWorkbook(filePath);
  const plan = await buildPlan(parsedRows);
  const ready = plan.filter((row) => row.status === "ready");
  const blocked = plan.filter((row) => row.status === "blocked");
  const noChange = plan.filter((row) => row.status === "no_change");

  const dryRunSummary = {
    generatedAt: new Date().toISOString(),
    filePath,
    dryRun: !send,
    requestedAction: "replace_tracking",
    marketplaceWritesPerformed: 0,
    inputRows: parsedRows.length,
    readyCount: ready.length,
    blockedCount: blocked.length,
    noChangeCount: noChange.length,
    readyByStore: summarizeByStore(ready),
    blockedByStore: summarizeByStore(blocked),
    noChangeByStore: summarizeByStore(noChange),
    plan,
  };

  if (!send) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(dryRunSummary, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      ...dryRunSummary,
      plan: plan.map((row) => ({
        sourceRow: row.sourceRow,
        orderId: row.orderId,
        replacementTrackingNumber: row.replacementTrackingNumber,
        status: row.status,
        store: row.store,
        existingTracking: row.existingTracking.map((tracking) => tracking.number),
        replacementPayload: row.replacementPayload,
        blockers: row.blockers,
      })),
      reportPath,
    }, null, 2));
    return;
  }

  if (blocked.length > 0) {
    throw new Error(`Refusing live replacement because ${blocked.length} rows are blocked.`);
  }

  const actor = await db.user.findFirst({
    where: { email: { equals: actorEmail, mode: "insensitive" } },
    select: { id: true },
  });
  if (!actor) throw new Error(`Actor user not found: ${actorEmail}`);

  const results = [];
  for (const row of ready) {
    try {
      const previousTrackingNumber = uniqueTrackingRows(row.existingTracking)[0]?.number ?? null;
      const result = await completeSaleWithTracking(row.store!, row.apiOrderId!, row.replacementPayload);
      const verified = await getManageOrderDetail(row.store!, row.orderId);
      const verifiedTracking = verified?.trackingNumbers ?? [];

      await db.auditLog.create({
        data: {
          userId: actor.id,
          action: "manage_orders_ebay_action",
          entityType: "ebay_order",
          entityId: row.orderId,
          details: {
            feature: "manage_orders_batch_cli",
            actionType: "replace_tracking",
            store: row.store,
            apiOrderId: row.apiOrderId,
            previousTrackingNumbers: row.existingTracking,
            replacementTrackingNumbersSentToEbay: row.replacementPayload,
            marketplaceAck: result.ack,
            marketplaceWarnings: result.warnings,
            sourceRow: row.sourceRow,
            mode: "one_time_labelcrow_replace",
          },
        },
      });

      results.push({
        sourceRow: row.sourceRow,
        orderId: row.orderId,
        replacementTrackingNumber: row.replacementTrackingNumber,
        previousTrackingNumber,
        store: row.store,
        success: true,
        marketplaceAck: result.ack,
        marketplaceWarnings: result.warnings,
        verifiedTracking,
        verificationStatus: verificationStatus(verifiedTracking, row.replacementTrackingNumber, previousTrackingNumber),
      });
    } catch (error) {
      results.push({
        sourceRow: row.sourceRow,
        orderId: row.orderId,
        replacementTrackingNumber: row.replacementTrackingNumber,
        previousTrackingNumber: uniqueTrackingRows(row.existingTracking)[0]?.number ?? null,
        store: row.store,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const liveSummary = {
    generatedAt: new Date().toISOString(),
    filePath,
    dryRun: false,
    requestedAction: "replace_tracking",
    marketplaceWritesPerformed: results.filter((row) => row.success).length,
    attemptedCount: results.length,
    successCount: results.filter((row) => row.success).length,
    failureCount: results.filter((row) => !row.success).length,
    noChangeCount: noChange.length,
    attemptedByStore: summarizeByStore(ready),
    results,
    noChange,
  };

  const liveReportPath = reportPath.replace("dry-run", "live");
  fs.mkdirSync(path.dirname(liveReportPath), { recursive: true });
  fs.writeFileSync(liveReportPath, `${JSON.stringify(liveSummary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...liveSummary, reportPath: liveReportPath }, null, 2));

  if (liveSummary.failureCount > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect().catch(() => {}));
