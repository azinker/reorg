/**
 * Re-sync MarketplaceSaleOrder rows for the eBay integrations so that
 * `buyerDisplayLabel` gets repopulated with the real first/last name
 * extracted from `Buyer.UserFirstName`/`Buyer.UserLastName` (or the
 * `ShippingAddress.Name` fallback) — the path that was added to
 * `marketplace-sales.ts::fetchEbaySales` in the previous deploy.
 *
 * After this runs, `backfill-buyer-names-from-orders.ts --apply` can
 * copy those names onto every existing HelpdeskTicket.
 *
 * IMPORTANT — fast path
 * ─────────────────────
 * We deliberately do NOT call `syncSalesHistoryForLookback` or
 * `upsertSalesHistoryLines` because those functions also reconcile every
 * order *line* (transactions, financial events, etc), which for 60-90
 * days of TPP traffic is ~60k rows and takes 30+ minutes per integration.
 *
 * The buyer-name backfill only needs three columns updated on the
 * MarketplaceSaleOrder row:
 *   - buyerIdentifier  (eBay username — already populated, but harmless)
 *   - buyerDisplayLabel (the real first/last name we now extract)
 *   - buyerEmail       (when present, for completeness)
 *
 * So this script just calls `fetchMarketplaceSales`, dedupes the lines
 * back to one record per (platform, externalOrderId), and runs a tight
 * batch of `updateMany` calls. It finishes in seconds, not minutes.
 */
import type { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import {
  fetchMarketplaceSales,
  getEnabledForecastIntegrations,
} from "@/lib/inventory-forecast/marketplace-sales";

interface OrderBuyerUpdate {
  platform: Platform;
  externalOrderId: string;
  buyerIdentifier: string | null;
  buyerDisplayLabel: string | null;
  buyerEmail: string | null;
}

function parseArgs(): { days: number; platforms: string[] | null; apply: boolean } {
  const argv = process.argv.slice(2);
  let days = 90;
  let platforms: string[] | null = null;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") {
      days = Number.parseInt(argv[++i] ?? "90", 10);
    } else if (argv[i] === "--platforms") {
      platforms = (argv[++i] ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    } else if (argv[i] === "--apply") {
      apply = true;
    }
  }
  return { days, platforms, apply };
}

async function main() {
  const { days, platforms, apply } = parseArgs();
  const mode = apply ? "APPLY" : "DRY-RUN";
  console.log(`[resync-orders-for-buyer-names] starting (${mode}) — lookback=${days}d`);

  const all = await getEnabledForecastIntegrations();
  const integrations = platforms
    ? all.filter((i) => platforms.includes(i.platform))
    : all.filter(
        (i) => i.platform === "TPP_EBAY" || i.platform === "TT_EBAY",
      );

  if (integrations.length === 0) {
    console.warn("  no matching integrations enabled — nothing to sync");
    await db.$disconnect();
    return;
  }

  let totalUpdated = 0;
  let totalSeen = 0;

  for (const integration of integrations) {
    console.log(`\n── ${integration.label} (${integration.platform}) ──`);
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5 * 60_000);
      const result = await fetchMarketplaceSales(integration, days, {
        signal: controller.signal,
      });
      clearTimeout(timer);

      console.log(
        `  fetched ${result.lines.length} lines (truncated=${result.truncated}) in ${Date.now() - start}ms`,
      );
      for (const issue of result.issues) {
        console.log(`  [${issue.level}] ${issue.message}`);
      }

      // Dedupe to one record per (platform, externalOrderId).
      const byOrder = new Map<string, OrderBuyerUpdate>();
      for (const line of result.lines) {
        const key = `${line.platform}::${line.externalOrderId}`;
        if (byOrder.has(key)) continue; // first-line wins; all lines on an order share buyer fields
        byOrder.set(key, {
          platform: line.platform,
          externalOrderId: line.externalOrderId,
          buyerIdentifier: line.buyerIdentifier ?? null,
          buyerDisplayLabel: line.buyerDisplayLabel ?? null,
          buyerEmail: line.buyerEmail ?? null,
        });
      }
      console.log(`  unique orders: ${byOrder.size}`);
      totalSeen += byOrder.size;

      let updated = 0;
      let i = 0;
      const updates = [...byOrder.values()];
      for (const u of updates) {
        i++;
        if (i % 1000 === 0) {
          console.log(`  ... ${i}/${updates.length} (updated so far: ${updated})`);
        }
        if (!apply) continue;
        // Only write fields that actually have something useful — never
        // null-out a column we already have data for.
        const data: Record<string, string | null> = {};
        if (u.buyerIdentifier) data.buyerIdentifier = u.buyerIdentifier;
        if (u.buyerDisplayLabel) data.buyerDisplayLabel = u.buyerDisplayLabel;
        if (u.buyerEmail) data.buyerEmail = u.buyerEmail;
        if (Object.keys(data).length === 0) continue;
        try {
          const res = await db.marketplaceSaleOrder.updateMany({
            where: {
              platform: u.platform,
              externalOrderId: u.externalOrderId,
            },
            data,
          });
          if (res.count > 0) updated++;
        } catch (err) {
          console.error(`  failed to update ${u.externalOrderId}:`, err);
        }
      }
      console.log(`  updated ${updated} order rows`);
      totalUpdated += updated;
    } catch (err) {
      console.error(`  ${integration.label} sync FAILED:`, err);
    }
  }

  console.log("\n[resync-orders-for-buyer-names] done");
  console.log(`  total unique orders seen: ${totalSeen}`);
  console.log(`  total order rows updated: ${totalUpdated}`);
  if (!apply) {
    console.log("\n  (dry-run — pass --apply to actually update)");
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
