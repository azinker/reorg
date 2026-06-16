/**
 * Reads all *.xlsx in --directory=. Each workbook: first worksheet only,
 * columns located by headers "orderNumber" and "tracking" (case-insensitive).
 *
 * Only rows whose orderNumber contains an extended eBay id (##-#####-#####)
 * are considered — Shopify / BigCommerce / Amazon-style ids are skipped implicitly.
 *
 * Default send path (**Commerce-first**): eBay Commerce Message REST `send_message`
 * runs before Trading `AddMemberMessageAAQToPartner` so high-volume bursts avoid
 * burning the same Trading quotas. Pass `--trading-only` to use legacy Trading sends.
 *
 * Lookup optimization: batches multiple order IDs into one Trading `GetOrders` call per
 * store (configure with `--get-orders-batch`).
 *
 * From reorg/:
 *   npx tsx -r dotenv/config scripts/send-ebay-buyer-tracking-message-from-folder.ts --directory="C:\path\Message Buyers"
 *   npx tsx -r dotenv/config scripts/send-ebay-buyer-tracking-message-from-folder.ts --directory="..." --only-order=16-14619-21317 --send
 *   npx tsx -r dotenv/config scripts/send-ebay-buyer-tracking-message-from-folder.ts --directory="..." --send --exclude=16-14619-21317 --report=reports/out.json
 *
 * Options:
 *   --directory=PATH   Folder containing .xlsx workbooks (required)
 *   --send             Live sends (default: dry run resolves only)
 *   --dry-run          Force resolve-only
 *   --exclude=id,id    Skip these extended order IDs
 *   --exclude-lines=PATH  Text file — one extended order ID per line (merged with --exclude)
 *   --sent-progress-log=PATH  LIVE only: append one order ID per successful send for safe resume after crash
 *   --only-order=id    Restrict to exactly this extended order ID (comma list allowed)
 *   --delay-ms=1200    Pause after each successful send
 *   --subject=…        Overrides default subject
 *   --report=path      JSON report (default reports/ebay-tracking-messages-<ts>.json)
 *   --get-orders-batch=75    Max extended order IDs per Trading GetOrders call (TPP/TT batches)
 *   --trading-only     Skip Commerce Message REST; Trading AAQ only (more Trading quota pressure)
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import { Platform, type Integration } from "@prisma/client";
import {
  buildEbayConfig,
  ebayOrderLineAttempts,
  fetchEbayOrderDetails,
  itemIdFromOutboundWinningStrategy,
  sendEbayBuyerMessageCommerceThenTradingFallback,
  sendEbayBuyerMessageWithFallback,
  type EbayOrderDetails,
} from "@/lib/services/auto-responder-ebay";

const STORES: Platform[] = [Platform.TPP_EBAY, Platform.TT_EBAY];

const EBAY_EXTENDED_ORDER_ID = /\b\d{2}-\d{5}-\d{5}\b/;

const DEFAULT_SUBJECT = "Update regarding your shipment";

const TRACKING_BODY_PREFIX = `Thank you for giving me the chance to make this right. As a precautionary measure, I want ahead and resent a new package for you. It goes out on Monday (tomorrow 5/18) with USPS. The tracking number is:`;

const TRACKING_BODY_SUFFIX = `There is a possibility that the original package may still arrive as well. If you happen to receive a second package, it would truly mean a lot to me if you could reach out so I can provide you with a prepaid return label to return the 2nd duplicate package.

I sincerely apologize for the inconvenience, and if you experience any other issues or have any questions, please do not hesitate to message us. Thank you again for your patience and understanding.`;

const DEFAULT_GET_ORDERS_BATCH = 75;

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size < 1) throw new Error("batch size >= 1");
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function buildBody(tracking: string): string {
  const t = tracking.trim();
  return `${TRACKING_BODY_PREFIX}\n\n${t}\n\n${TRACKING_BODY_SUFFIX}`;
}

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

function mergeExcludeLinesFile(exclude: Set<string>, filePath: string): number {
  if (!existsSync(filePath)) return 0;
  const raw = readFileSync(filePath, "utf8");
  let n = 0;
  for (const line of raw.split(/\r?\n/)) {
    const id = line.trim();
    if (!id || id.startsWith("#")) continue;
    if (!EBAY_EXTENDED_ORDER_ID.test(id)) {
      console.warn(`  exclude-lines: skip non-eBay id "${id}"`);
      continue;
    }
    if (!exclude.has(id)) n += 1;
    exclude.add(id);
  }
  return n;
}

function appendSentProgressLog(filePath: string, orderId: string): void {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  if (dir) mkdirSync(dir, { recursive: true });
  appendFileSync(resolved, `${orderId}\n`, "utf8");
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

function ebayOrderFromCell(orderCell: string): string | undefined {
  const raw = String(orderCell ?? "").trim();
  if (!raw) return undefined;
  const m = raw.match(EBAY_EXTENDED_ORDER_ID);
  return m?.[0];
}

export type ParsedRowMeta = {
  orderId: string;
  tracking: string;
  file: string;
  sheet: string;
  row: number;
};

function parseSheetRows(filePath: string, ws: ExcelJS.Worksheet): ParsedRowMeta[] {
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

  const out: ParsedRowMeta[] = [];
  const lastRow = ws.rowCount || 1;
  for (let r = 2; r <= lastRow; r++) {
    const orderRaw = String(ws.getRow(r).getCell(orderCol).text ?? "").trim();
    const tracking = String(ws.getRow(r).getCell(trackingCol).text ?? "").trim();
    const orderId = ebayOrderFromCell(orderRaw);
    if (!orderId) continue;
    if (!tracking) {
      console.warn(`  Skip row ${r} (${path.basename(filePath)}): eBay ${orderId} but empty tracking`);
      continue;
    }
    out.push({
      orderId,
      tracking,
      file: path.basename(filePath),
      sheet: ws.name,
      row: r,
    });
  }
  return out;
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
  tracking?: string;
  sourceFile?: string;
  winningStrategy?: string;
  outboundChannel?: "COMMERCE_MESSAGE" | "TRADING_AAQ";
  commerceMessageId?: string;
  error?: string;
  reason?: FailureReason;
};

type ResolvedEntry = {
  store: Platform;
  integrationId: string;
  ebayDetail: EbayOrderDetails;
};

/**
 * Resolves extended order IDs in store order TPP-first, TT-second, batching Trading GetOrders
 * to conserve call budget.
 */
async function resolveOrdersBatchedAcrossStores(
  candidateOrderIds: string[],
  integrationByPlatform: Map<Platform, { id: string; config: ReturnType<typeof buildEbayConfig> }>,
  batchSize: number,
): Promise<Map<string, ResolvedEntry>> {
  const resolved = new Map<string, ResolvedEntry>();
  let pending = [...new Set(candidateOrderIds)].sort((a, b) => a.localeCompare(b));

  for (const platform of STORES) {
    if (pending.length === 0) break;
    const integ = integrationByPlatform.get(platform);
    if (!integ) continue;

    for (const chunk of chunkArray(pending, batchSize)) {
      const map = await fetchEbayOrderDetails(integ.id, integ.config, chunk);
      for (const oid of chunk) {
        const d = map.get(oid);
        if (d?.buyerUserId && d.itemId && !resolved.has(oid)) {
          resolved.set(oid, {
            store: platform,
            integrationId: integ.id,
            ebayDetail: d,
          });
        }
      }
    }
    pending = pending.filter((id) => !resolved.has(id));
  }

  return resolved;
}

async function main(): Promise<void> {
  const dir = argValue("--directory");
  if (!dir) {
    console.error('Missing required --directory="C:\\...\\Message Buyers"');
    process.exit(1);
  }

  const liveSend = hasFlag("--send");
  const dryRun = hasFlag("--dry-run") || !liveSend;
  const delayMs = Math.max(0, Number(argValue("--delay-ms") ?? "1200"));
  const tradingOnly = hasFlag("--trading-only");
  const getOrdersBatch = Math.max(
    1,
    Number(argValue("--get-orders-batch") ?? String(DEFAULT_GET_ORDERS_BATCH)),
  );
  const subject = argValue("--subject") ?? DEFAULT_SUBJECT;
  const reportPath =
    argValue("--report") ??
    path.join("reports", `ebay-tracking-messages-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);

  const exclude = new Set(
    (argValue("--exclude") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const excludeLinesPath = argValue("--exclude-lines");
  if (excludeLinesPath) {
    const merged = mergeExcludeLinesFile(exclude, excludeLinesPath);
    console.log(`exclude-lines (${path.basename(excludeLinesPath)}): added ${merged} new ID(s); total exclude set size ${exclude.size}`);
  }

  const sentProgressLogPath = liveSend ? argValue("--sent-progress-log") : undefined;
  if (sentProgressLogPath && !liveSend) console.warn("--sent-progress-log ignored (not a live --send run)");

  let onlyOrders: Set<string> | undefined;
  const onlyArg = argValue("--only-order");
  if (onlyArg) {
    onlyOrders = new Set(
      onlyArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  const xlsxPaths = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".xlsx"))
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE SEND"}`);
  console.log(`Send path: ${tradingOnly ? "Trading AAQ only (--trading-only)" : "Commerce REST first → Trading fallback"}`);
  console.log(`GetOrders batch size: ${getOrdersBatch}`);
  console.log(`Directory: ${dir}`);
  console.log(`Workbooks (${xlsxPaths.length}): ${xlsxPaths.map((p) => path.basename(p)).join(", ") || "(none)"}`);
  if (onlyOrders) console.log(`Only orders: ${[...onlyOrders].join(", ")}`);
  if (exclude.size) console.log(`Excluded: ${[...exclude].join(", ")}`);

  if (xlsxPaths.length === 0) {
    console.error("No .xlsx files in directory.");
    process.exit(1);
  }

  /** First occurrence wins */
  const byOrderId = new Map<string, ParsedRowMeta>();
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
      const existing = byOrderId.get(row.orderId);
      if (!existing) {
        byOrderId.set(row.orderId, row);
      } else if (existing.tracking !== row.tracking) {
        console.warn(
          `Duplicate ${row.orderId}: keeping tracking from ${existing.file} row ${existing.row}; also in ${row.file} row ${row.row} (different tracking — ignored)`,
        );
      }
    }
  }

  let jobList = [...byOrderId.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([id, meta]) => ({ ...meta }));

  if (onlyOrders) {
    jobList = jobList.filter((j) => onlyOrders!.has(j.orderId));
  }

  console.log(`eBay-format rows (deduped ${jobList.length} orders from sheets)\n`);

  const integrationByPlatform = new Map<Platform, { id: string; config: ReturnType<typeof buildEbayConfig> }>();
  const integrationRowByPlatform = new Map<Platform, Integration>();
  for (const p of STORES) {
    const row = await db.integration.findUnique({ where: { platform: p } });
    if (!row) {
      console.warn(`No Integration row for ${p}`);
      continue;
    }
    integrationByPlatform.set(p, { id: row.id, config: buildEbayConfig(row) });
    integrationRowByPlatform.set(p, row);
  }

  /** Prefetch lookups (batched Trading GetOrders) — only orders we need to execute */
  const idsToResolve = jobList.filter((j) => !exclude.has(j.orderId)).map((j) => j.orderId);
  console.log(`Batch prefetching ${[...new Set(idsToResolve)].length} distinct order IDs (TPP then TT)...`);
  const resolvedByOrder = await resolveOrdersBatchedAcrossStores(idsToResolve, integrationByPlatform, getOrdersBatch);
  console.log(`Resolved ${resolvedByOrder.size} orders onto TPP or TT.\n`);

  const results: RowResult[] = [];

  for (let i = 0; i < jobList.length; i++) {
    const job = jobList[i];
    const { orderId, tracking, file } = job;
    const progress = `[${i + 1}/${jobList.length}]`;

    if (exclude.has(orderId)) {
      console.log(`${progress} ${orderId} — skipped (exclude)`);
      results.push({ orderId, ok: false, reason: "SKIPPED_EXCLUDED", tracking, sourceFile: file });
      continue;
    }

    const resolved = resolvedByOrder.get(orderId);
    const body = buildBody(tracking);

    if (!resolved) {
      console.log(`${progress} ${orderId} (${file}) — NOT FOUND on TPP or TT`);
      results.push({
        orderId,
        ok: false,
        reason: "NOT_FOUND_TPP_OR_TT",
        tracking,
        sourceFile: file,
      });
      continue;
    }

    console.log(
      `${progress} ${orderId} — ${resolved.store} buyer=${resolved.ebayDetail.buyerUserId} item=${resolved.ebayDetail.itemId} (from ${file})`,
    );

    if (dryRun) {
      results.push({
        orderId,
        ok: true,
        store: resolved.store,
        buyerUserId: resolved.ebayDetail.buyerUserId,
        itemId: resolved.ebayDetail.itemId,
        tracking,
        sourceFile: file,
      });
      continue;
    }

    const integRow = integrationRowByPlatform.get(resolved.store);
    if (!integRow) {
      results.push({
        orderId,
        ok: false,
        reason: "NO_EBAY_INTEGRATION",
        error: "Integration row missing for resolved store",
        tracking,
        sourceFile: file,
      });
      continue;
    }

    const lineAttempts = ebayOrderLineAttempts(null, resolved.ebayDetail);
    const cfg = buildEbayConfig(integRow);

    let sendSucceeded = false;
    let winningStrategyOut: string | undefined;
    let sendError: string | undefined;
    let attemptedOut: string[] | undefined;
    let outboundChannel: "COMMERCE_MESSAGE" | "TRADING_AAQ" | undefined;
    let commerceMsgIdOut: string | undefined;

    if (tradingOnly) {
      const sendResult = await sendEbayBuyerMessageWithFallback(
        resolved.integrationId,
        cfg,
        resolved.ebayDetail.buyerUserId,
        subject,
        body,
        lineAttempts,
      );
      sendSucceeded = Boolean(sendResult.success);
      winningStrategyOut = sendResult.winningStrategy;
      sendError = sendResult.success ? undefined : sendResult.error;
      attemptedOut = sendResult.attempted;
      if (sendResult.success) outboundChannel = "TRADING_AAQ";
    } else {
      const sendResult = await sendEbayBuyerMessageCommerceThenTradingFallback(
        resolved.integrationId,
        cfg,
        resolved.ebayDetail.buyerUserId,
        subject,
        body,
        lineAttempts,
      );
      sendSucceeded = Boolean(sendResult.success);
      winningStrategyOut = sendResult.winningStrategy;
      sendError = sendResult.success ? undefined : sendResult.error;
      attemptedOut = sendResult.attempted;
      if (sendResult.success) {
        outboundChannel = sendResult.channel ?? "TRADING_AAQ";
        commerceMsgIdOut = sendResult.commerceMessageId;
      }
    }

    if (!sendSucceeded) {
      const detailNote =
        attemptedOut && attemptedOut.length > 0 ? ` (${attemptedOut.length} strategies tried)` : "";
      console.error(`    SEND FAILED: ${sendError ?? "unknown"}${detailNote}`);
      results.push({
        orderId,
        ok: false,
        store: resolved.store,
        buyerUserId: resolved.ebayDetail.buyerUserId,
        itemId: resolved.ebayDetail.itemId,
        reason: "SEND_FAILED",
        error: `${sendError ?? "unknown"}${detailNote}`,
        tracking,
        sourceFile: file,
      });
      continue;
    }

    const ch = outboundChannel ?? "TRADING_AAQ";
    const sentItemId = itemIdFromOutboundWinningStrategy(winningStrategyOut) ?? resolved.ebayDetail.itemId;

    console.log(`    sent OK [${ch}] (${winningStrategyOut ?? "?"})`);

    if (sentProgressLogPath) {
      appendSentProgressLog(sentProgressLogPath, orderId);
    }

    results.push({
      orderId,
      ok: true,
      store: resolved.store,
      buyerUserId: resolved.ebayDetail.buyerUserId,
      itemId: sentItemId,
      winningStrategy: winningStrategyOut,
      outboundChannel: ch,
      commerceMessageId: commerceMsgIdOut,
      tracking,
      sourceFile: file,
    });

    if (i < jobList.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  const sendsOkCount = dryRun
    ? results.filter((r) => r.ok && !r.reason).length
    : results.filter((r) => Boolean(r.winningStrategy)).length;

  const summary = {
    generatedAt: new Date().toISOString(),
    directory: dir,
    dryRun,
    tradingOnlySend: tradingOnly,
    getOrdersBatch,
    commerceFirstDefault: !tradingOnly,
    subject,
    workbooksProcessed: xlsxPaths.length,
    uniqueEbayJobs: jobList.length,
    sendSucceededOrResolved: sendsOkCount,
    skippedExcluded: results.filter((r) => r.reason === "SKIPPED_EXCLUDED").length,
    notFoundOrderIds: results.filter((r) => r.reason === "NOT_FOUND_TPP_OR_TT").map((r) => r.orderId),
    sendFailedOrderIds: results.filter((r) => r.reason === "SEND_FAILED").map((r) => r.orderId),
    sendFailedDetail: Object.fromEntries(
      results.filter((r) => r.reason === "SEND_FAILED").map((r) => [r.orderId, r.error ?? ""]),
    ),
    commerceSendCount: results.filter((r) => r.outboundChannel === "COMMERCE_MESSAGE").length,
    tradingSendCount: results.filter((r) => r.outboundChannel === "TRADING_AAQ").length,
    results,
  };

  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`\nReport written: ${reportPath}`);
  console.log(`${dryRun ? "Dry-run resolves OK" : "Sends acknowledged OK"}: ${sendsOkCount}`);
  if (!dryRun && !tradingOnly) {
    console.log(`  via Commerce REST: ${summary.commerceSendCount} | via Trading AAQ: ${summary.tradingSendCount}`);
  }

  console.log(`\n--- Order IDs not found on eBay TPP or TT ---`);
  console.log(summary.notFoundOrderIds.length ? summary.notFoundOrderIds.join("\n") : "(none)");
  console.log(`\n--- Order IDs eBay rejected send ---`);
  console.log(summary.sendFailedOrderIds.length ? summary.sendFailedOrderIds.join("\n") : "(none)");
}

main().finally(() =>
  db.$disconnect().catch(() => {
    /* ignore */
  }),
);
