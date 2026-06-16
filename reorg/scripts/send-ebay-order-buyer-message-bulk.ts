/**
 * Read eBay extended order IDs from an Excel column (header "orderNumber", or column R),
 * OR from a newline-separated --orders-file (one ID per line).
 * Resolves each on TPP_EBAY then TT_EBAY, sends AddMemberMessageAAQToPartner.
 *
 * From reorg/:
 *   $env:DOTENV_CONFIG_PATH=".env.prod"; npx tsx -r dotenv/config scripts/send-ebay-order-buyer-message-bulk.ts --excel="C:\path\ALL_counterfeit.xlsx" --send
 *
 * Options:
 *   --excel=path       Workbook path (first sheet)
 *   --orders-file=path Plain text: one ##-#####-##### per line (alternative to --excel)
 *   --dry-run          Resolve only, no sends (default if --send omitted)
 *   --send             Live sends
 *   --exclude=id,id    Skip these order IDs (default includes 16-14619-21317 test send)
 *   --no-default-exclude  Do not skip 16-14619-21317
 *   --delay-ms=1200    Pause between successful sends
 *   --report=path      JSON report path (default reports/ebay-bulk-send-<ts>.json)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import { Platform } from "@prisma/client";
import {
  buildEbayConfig,
  ebayOrderLineAttempts,
  fetchEbayOrderDetails,
  itemIdFromOutboundWinningStrategy,
  sendEbayBuyerMessageWithFallback,
  type EbayOrderDetails,
} from "@/lib/services/auto-responder-ebay";

const STORES: Platform[] = [Platform.TPP_EBAY, Platform.TT_EBAY];

const DEFAULT_SUBJECT = "Update regarding your order and shipment";

const DEFAULT_BODY = `Thank you for your order. Due to a glitch recently on eBay and while reviewing your shipment to ensure it arrives on time, I identified a potential issue with the package. To avoid any delay, I immediately sent out a replacement package using expedited Priority Service so your item can arrive as quickly as possible. This package will leave first thing this Monday (5/18) which is the next possible day USPS can take the package.

Because this was done as a precautionary measure, there is a possibility that the original package may still arrive as well. If you happen to receive a second package, it would truly mean a lot to me if you could reach out so I can provide you with a prepaid return label to return the 2nd duplicate package.

I sincerely apologize for the inconvenience, and if you experience any other issues or have any questions, please do not hesitate to message us. Thank you again for your patience and understanding.`;

const EBAY_ORDER_RE = /\b\d{2}-\d{5}-\d{5}\b/g;

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (!hit) return undefined;
  return hit.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function findOrderNumberColumn(ws: ExcelJS.Worksheet): number {
  const first = ws.getRow(1);
  const maxCol = Math.max(first.cellCount, 30);
  for (let c = 1; c <= maxCol; c++) {
    const t = String(first.getCell(c).text ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    if (t === "ordernumber") return c;
  }
  return 18;
}

function extractEbayOrderIdsFromSheet(ws: ExcelJS.Worksheet): string[] {
  const col = findOrderNumberColumn(ws);
  const seen = new Set<string>();
  const ordered: string[] = [];
  const lastRow = ws.rowCount || 1;
  for (let r = 2; r <= lastRow; r++) {
    const text = String(ws.getRow(r).getCell(col).text ?? "").trim();
    if (!text) continue;
    const matches = text.match(EBAY_ORDER_RE);
    if (!matches) continue;
    for (const id of matches) {
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

type FailureReason =
  | "SKIPPED_EXCLUDED"
  | "NOT_FOUND_TPP_OR_TT"
  | "SEND_FAILED"
  | "NO_EBAY_INTEGRATION";

type RowResult = {
  orderId: string;
  ok: boolean;
  store?: Platform;
  buyerUserId?: string;
  itemId?: string;
  winningStrategy?: string;
  error?: string;
  reason?: FailureReason;
};

function orderIdsFromPlainText(filePath: string): string[] {
  const raw = readFileSync(filePath, "utf8");
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(EBAY_ORDER_RE);
    if (!m) continue;
    for (const id of m) {
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

async function main(): Promise<void> {
  const excelPath = argValue("--excel");
  const ordersFile = argValue("--orders-file");

  const liveSend = hasFlag("--send");
  const dryRun = hasFlag("--dry-run") || !liveSend;
  const delayMs = Math.max(0, Number(argValue("--delay-ms") ?? "1200"));
  const reportPath =
    argValue("--report") ??
    path.join("reports", `ebay-bulk-send-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);

  const defaultExclude = hasFlag("--no-default-exclude") ? [] : ["16-14619-21317"];
  const extraExclude = (argValue("--exclude") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const exclude = new Set([...defaultExclude, ...extraExclude]);

  const subject = argValue("--subject") ?? DEFAULT_SUBJECT;
  const body = argValue("--body") ? String(argValue("--body")).replace(/\\n/g, "\n") : DEFAULT_BODY;

  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE SEND"}`);
  console.log(`Delay between sends: ${delayMs}ms`);
  console.log(`Excluded order IDs: ${[...exclude].join(", ") || "(none)"}`);

  let orderIds: string[];
  let sourceLabel: string;

  if (ordersFile) {
    console.log(`Orders file: ${ordersFile}`);
    orderIds = orderIdsFromPlainText(ordersFile);
    sourceLabel = ordersFile;
  } else if (excelPath) {
    console.log(`Excel: ${excelPath}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(excelPath);
    const ws = wb.worksheets[0];
    if (!ws) {
      console.error("Workbook has no sheets.");
      process.exit(1);
    }
    orderIds = extractEbayOrderIdsFromSheet(ws);
    sourceLabel = excelPath;
    console.log(`eBay-format order IDs (column ${findOrderNumberColumn(ws)}, deduped): ${orderIds.length}`);
  } else {
    console.error("Provide --excel=... or --orders-file=... (one eBay order id per line).");
    process.exit(1);
  }

  if (orderIds.length === 0) {
    console.error("No eBay order IDs found (expected ##-#####-#####).");
    process.exit(1);
  }

  const integrationByPlatform = new Map<Platform, { id: string; config: ReturnType<typeof buildEbayConfig> }>();
  for (const p of STORES) {
    const row = await db.integration.findUnique({ where: { platform: p } });
    if (!row) {
      console.warn(`No Integration row for ${p}`);
      continue;
    }
    integrationByPlatform.set(p, { id: row.id, config: buildEbayConfig(row) });
  }

  const results: RowResult[] = [];

  for (let i = 0; i < orderIds.length; i++) {
    const orderId = orderIds[i];
    const progress = `[${i + 1}/${orderIds.length}]`;

    if (exclude.has(orderId)) {
      console.log(`${progress} ${orderId} — skipped (exclude list)`);
      results.push({ orderId, ok: false, reason: "SKIPPED_EXCLUDED" });
      continue;
    }

    let resolved: {
      store: Platform;
      integrationId: string;
      ebayDetail: EbayOrderDetails;
    } | null = null;

    for (const platform of STORES) {
      const integ = integrationByPlatform.get(platform);
      if (!integ) continue;
      const map = await fetchEbayOrderDetails(integ.id, integ.config, [orderId]);
      const d = map.get(orderId);
      if (d?.buyerUserId && d.itemId) {
        resolved = {
          store: platform,
          integrationId: integ.id,
          ebayDetail: d,
        };
        break;
      }
    }

    if (!resolved) {
      console.log(`${progress} ${orderId} — NOT FOUND on TPP or TT`);
      results.push({ orderId, ok: false, reason: "NOT_FOUND_TPP_OR_TT" });
      continue;
    }

    console.log(
      `${progress} ${orderId} — ${resolved.store} buyer=${resolved.ebayDetail.buyerUserId} item=${resolved.ebayDetail.itemId}` +
        (resolved.ebayDetail.lineItems && resolved.ebayDetail.lineItems.length > 1
          ? ` (${resolved.ebayDetail.lineItems.length} line items)`
          : ""),
    );

    if (dryRun) {
      results.push({
        orderId,
        ok: true,
        store: resolved.store,
        buyerUserId: resolved.ebayDetail.buyerUserId,
        itemId: resolved.ebayDetail.itemId,
      });
      continue;
    }

    const integRow = await db.integration.findUnique({ where: { id: resolved.integrationId } });
    if (!integRow) {
      results.push({ orderId, ok: false, reason: "NO_EBAY_INTEGRATION", error: "integration row missing mid-run" });
      continue;
    }

    const lineAttempts = ebayOrderLineAttempts(null, resolved.ebayDetail);
    const sendResult = await sendEbayBuyerMessageWithFallback(
      resolved.integrationId,
      buildEbayConfig(integRow),
      resolved.ebayDetail.buyerUserId,
      subject,
      body,
      lineAttempts,
    );

    if (!sendResult.success) {
      const detailNote =
        sendResult.attempted && sendResult.attempted.length > 0
          ? ` (${sendResult.attempted.length} strategies tried)`
          : "";
      console.error(`    SEND FAILED: ${sendResult.error}${detailNote}`);
      results.push({
        orderId,
        ok: false,
        store: resolved.store,
        buyerUserId: resolved.ebayDetail.buyerUserId,
        itemId: resolved.ebayDetail.itemId,
        reason: "SEND_FAILED",
        error: `${sendResult.error}${detailNote}`,
      });
      continue;
    }

    const sentItemId =
      itemIdFromOutboundWinningStrategy(sendResult.winningStrategy) ?? resolved.ebayDetail.itemId;
    console.log(`    sent OK (${sendResult.winningStrategy ?? "?"})`);
    results.push({
      orderId,
      ok: true,
      store: resolved.store,
      buyerUserId: resolved.ebayDetail.buyerUserId,
      itemId: sentItemId,
      winningStrategy: sendResult.winningStrategy,
    });

    if (i < orderIds.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  const sent = results.filter((r) => r.ok && r.reason !== "SKIPPED_EXCLUDED");

  const summary = {
    generatedAt: new Date().toISOString(),
    sourcePath: sourceLabel,
    dryRun,
    totalRowsEbayIds: orderIds.length,
    sentOrResolvedOk: sent.length,
    notOk: results.filter((r) => !r.ok && r.reason !== "SKIPPED_EXCLUDED").length,
    skippedExcluded: results.filter((r) => r.reason === "SKIPPED_EXCLUDED").length,
    notFoundOrderIds: results.filter((r) => r.reason === "NOT_FOUND_TPP_OR_TT").map((r) => r.orderId),
    sendFailedOrderIds: results.filter((r) => r.reason === "SEND_FAILED").map((r) => r.orderId),
    sendFailedDetail: Object.fromEntries(
      results.filter((r) => r.reason === "SEND_FAILED").map((r) => [r.orderId, r.error ?? ""]),
    ),
    results,
  };

  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`\nReport written: ${reportPath}`);
  console.log(`Sent / OK dry-run resolves: ${sent.length}`);
  console.log(`Failed or not found (excl. skipped): ${summary.notOk}`);

  const notFoundIds = results.filter((r) => r.reason === "NOT_FOUND_TPP_OR_TT").map((r) => r.orderId);
  const sendFailedIds = results.filter((r) => r.reason === "SEND_FAILED").map((r) => r.orderId);

  console.log("\n--- Order IDs not found on eBay TPP or TT ---");
  console.log(notFoundIds.length ? notFoundIds.join("\n") : "(none)");

  console.log("\n--- Order IDs resolved but eBay rejected the send ---");
  console.log(sendFailedIds.length ? sendFailedIds.join("\n") : "(none)");
}

main().finally(() =>
  db.$disconnect().catch(() => {
    /* ignore */
  }),
);
