/**
 * Reads all *.xlsx in --directory (first worksheet). Columns "orderNumber" + "tracking".
 * Skips any row whose order cell contains an eBay extended id (##-#####-#####).
 *
 * Identifies Shopify / BigCommerce / Amazon via ship-orders logic, then --send pushes tracking:
 * - Shopify: USPS carrier — updates newest fulfillment tracking when possible, otherwise creates fulfillment.
 * - BigCommerce: USPS tracking_carrier — PUT existing shipment when possible, otherwise POST shipment.
 * - Amazon: confirmShipment with carrier USPS and shippingMethod from --amazon-shipping-method (default Other).
 *
 * From reorg/:
 *   npx tsx -r dotenv/config scripts/push-non-ebay-tracking-from-folder.ts --directory="C:\\...\\Message Buyers" --dry-run
 *   npx tsx -r dotenv/config scripts/push-non-ebay-tracking-from-folder.ts --directory="..." --send "--report=reports/out.json"
 *
 * Options:
 *   --platforms=SHOPIFY,BIGCOMMERCE   Limit execute phase (default: all three)
 *   --only-order-numbers=A,B,C        After parsing Excel, restrict to these order ids (comma-separated)
 *   --amazon-shipping-method=Other    confirmShipment packageDetail.shippingMethod (default Other)
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import type { Platform } from "@prisma/client";
import {
  executeShipments,
  identifyOrders,
  type IdentifiedOrder,
  type IdentifyResult,
  type ParsedLine,
} from "@/lib/services/ship-orders";

const PUSH_PLATFORMS = new Set<string>(["SHOPIFY", "BIGCOMMERCE", "AMAZON"]);

/** Same token rule as ship-orders / Message Buyers eBay tooling — skip mixed-marketplace rows. */
const EBAY_ID_IN_CELL = /\b\d{2}-\d{5}-\d{5}\b/;

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (!hit) return undefined;
  return hit.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function normalizeHeader(cellText: string): string {
  return String(cellText ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function findColumnByHeader(ws: ExcelJS.Worksheet, headerNorm: string): number | undefined {
  const row = ws.getRow(1);
  const maxCol = Math.max(row.cellCount ?? 0, 30);
  for (let c = 1; c <= maxCol; c++) {
    if (normalizeHeader(String(row.getCell(c).text ?? "")) === headerNorm) return c;
  }
  return undefined;
}

function normalizeMarketplaceOrderId(raw: string): string {
  let s = raw.replace(/^\uFEFF/, "").trim();
  if (s.startsWith("#")) s = s.slice(1).trim();
  return s;
}

function parseSheetRows(filePath: string, ws: ExcelJS.Worksheet): ParsedLine[] {
  const orderCol = findColumnByHeader(ws, "ordernumber");
  const trackingCol = findColumnByHeader(ws, "tracking");
  if (!orderCol) {
    console.warn(`  ${path.basename(filePath)} / "${ws.name}": no "orderNumber" header — skipping sheet.`);
    return [];
  }
  if (!trackingCol) {
    console.warn(`  ${path.basename(filePath)} / "${ws.name}": no "tracking" header — skipping sheet.`);
    return [];
  }

  const out: ParsedLine[] = [];
  const lastRow = ws.rowCount || 1;
  for (let r = 2; r <= lastRow; r++) {
    const orderRaw = String(ws.getRow(r).getCell(orderCol).text ?? "").trim();
    const tracking = String(ws.getRow(r).getCell(trackingCol).text ?? "").trim();
    if (!orderRaw) continue;
    if (EBAY_ID_IN_CELL.test(orderRaw)) continue;

    const orderNumber = normalizeMarketplaceOrderId(orderRaw);
    if (!orderNumber) continue;

    if (!tracking) {
      console.warn(`  Skip row ${r} (${path.basename(filePath)}): ${orderNumber} but empty tracking`);
      continue;
    }

    out.push({ orderNumber, trackingNumber: tracking });
  }
  return out;
}

function isIdentified(r: IdentifyResult): r is IdentifiedOrder {
  return r.status === "found";
}

async function getActorUserId(): Promise<string> {
  let user = await db.user.findFirst({ where: { role: "ADMIN" } });
  if (!user) {
    user = await db.user.create({
      data: { email: "system@reorg.internal", name: "System", role: "ADMIN" },
    });
  }
  return user.id;
}

async function main(): Promise<void> {
  const dir = argValue("--directory");
  if (!dir) {
    console.error('Missing required --directory="C:\\...\\Message Buyers"');
    process.exit(1);
  }

  const liveSend = hasFlag("--send");
  const dryRun = hasFlag("--dry-run") || !liveSend;
  const amazonShippingMethod = argValue("--amazon-shipping-method") ?? "Other";

  let platformFilter: Set<Platform> | null = null;
  const platformsArg = argValue("--platforms");
  if (platformsArg) {
    const parts = platformsArg
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const bad = parts.filter((p) => !PUSH_PLATFORMS.has(p));
    if (bad.length) {
      console.error(`Invalid --platforms values: ${bad.join(", ")} (allowed: SHOPIFY, BIGCOMMERCE, AMAZON)`);
      process.exit(1);
    }
    platformFilter = new Set(parts as Platform[]);
  }
  const reportPath =
    argValue("--report") ??
    path.join("reports", `non-ebay-tracking-push-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);

  const xlsxPaths = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".xlsx"))
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  console.log(`Mode: ${dryRun ? "DRY RUN (identify only)" : "LIVE PUSH"}`);
  console.log(`Directory: ${dir}`);
  console.log(`Amazon confirmShipment shippingMethod: ${amazonShippingMethod} (carrier USPS)`);
  console.log(`Shopify/BigCommerce: replace tracking on existing fulfillment/shipment when present`);
  console.log(
    `Platforms: ${platformFilter ? [...platformFilter].join(", ") : "SHOPIFY, BIGCOMMERCE, AMAZON"}\n`,
  );

  if (xlsxPaths.length === 0) {
    console.error("No .xlsx files in directory.");
    process.exit(1);
  }

  const byOrderId = new Map<string, ParsedLine>();
  for (const xp of xlsxPaths) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xp);
    const ws = wb.worksheets[0];
    if (!ws) {
      console.warn(`${path.basename(xp)}: no sheets`);
      continue;
    }
    const rows = parseSheetRows(xp, ws);
    for (const row of rows) {
      const existing = byOrderId.get(row.orderNumber);
      if (!existing) {
        byOrderId.set(row.orderNumber, row);
      } else if (existing.trackingNumber !== row.trackingNumber) {
        console.warn(
          `Duplicate ${row.orderNumber}: keeping tracking ${existing.trackingNumber}; ignoring alternate ${row.trackingNumber}`,
        );
      }
    }
  }

  const jobListBuilt = [...byOrderId.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, meta]) => meta);

  const onlyOrderArg = argValue("--only-order-numbers");
  let jobList = jobListBuilt;
  if (onlyOrderArg) {
    const allow = new Set(
      onlyOrderArg
        .split(",")
        .map((s) => normalizeMarketplaceOrderId(s.trim()))
        .filter(Boolean),
    );
    jobList = jobListBuilt.filter((j) => allow.has(j.orderNumber));
    const missingFromSheets = [...allow].filter((id) => !jobList.some((j) => j.orderNumber === id));
    if (missingFromSheets.length) {
      console.warn(`--only-order-numbers: missing from workbook(s): ${missingFromSheets.join(", ")}`);
    }
    if (jobList.length === 0) {
      console.error("After --only-order-numbers filter, nothing to process.");
      process.exit(1);
    }
  }

  console.log(`Non-eBay rows (${onlyOrderArg ? "filtered" : "deduped"}): ${jobList.length}\n`);

  const identified = await identifyOrders(jobList, { amazonAllowAlreadyShipped: true });

  const identifyFailures = identified.filter((r) => !isIdentified(r));
  const foundAll = identified.filter(isIdentified);
  const found = platformFilter ? foundAll.filter((o) => platformFilter!.has(o.platform)) : foundAll;

  console.log(`Identified on a store: ${foundAll.length}`);
  if (platformFilter) {
    console.log(`After --platforms filter: ${found.length}`);
  }
  console.log(`Identify failures / ambiguous / not found: ${identifyFailures.length}\n`);

  for (const f of identifyFailures) {
    console.log(`  ✗ ${f.orderNumber} (${f.trackingNumber}) — ${f.status}${f.error ? `: ${f.error}` : ""}`);
  }

  let executeFailures: Array<{ orderNumber: string; trackingNumber: string; platform: string; error: string }> =
    [];
  let executeOk: Array<{ orderNumber: string; trackingNumber: string; platform: string }> = [];

  if (!dryRun && found.length > 0) {
    const actorUserId = await getActorUserId();
    const batchId = `non-ebay-tracking-${new Date().toISOString().slice(0, 16).replace(/[:-]/g, "")}`;
    const { results } = await executeShipments(found, actorUserId, batchId, {
      replaceExistingTracking: true,
      amazonShippingMethod,
    });

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const o = found[i]!;
      if (r.success) {
        executeOk.push({
          orderNumber: r.orderNumber,
          trackingNumber: r.trackingNumber,
          platform: String(o.platform),
        });
      } else {
        executeFailures.push({
          orderNumber: r.orderNumber,
          trackingNumber: r.trackingNumber,
          platform: String(o.platform),
          error: r.error ?? "unknown",
        });
        console.error(`  PUSH FAILED ${r.orderNumber} (${o.platform}): ${r.error}`);
      }
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    directory: dir,
    dryRun,
    amazonShippingMethod,
    replaceExistingTracking: true,
    workbooksProcessed: xlsxPaths.length,
    uniqueJobs: jobList.length,
    identifiedCount: foundAll.length,
    platformsFilter: platformFilter ? [...platformFilter] : null,
    ordersSelectedForPush: found.length,
    identifyFailures: identifyFailures.map((f) => ({
      orderNumber: f.orderNumber,
      trackingNumber: f.trackingNumber,
      status: f.status,
      error: f.error,
    })),
    pushSucceeded: executeOk,
    pushFailures: executeFailures,
  };

  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`\nReport written: ${reportPath}`);
  if (dryRun) {
    console.log("Dry run — no marketplace writes. Pass --send to execute.");
  } else {
    console.log(`Pushed OK: ${executeOk.length} | Failed: ${executeFailures.length}`);
  }

  if (!dryRun && executeFailures.length > 0) process.exit(1);
}

main().finally(() =>
  db.$disconnect().catch(() => {
    /* ignore */
  }),
);
