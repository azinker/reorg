/**
 * Retroactively correct the SKU on already-synced HelpdeskReturnCase rows.
 *
 * WHY: eBay's Post-Order return `itemDetail.sku` is unreliable for
 * multi-variation listings — it can report the listing's default/first
 * variation SKU instead of the variant the buyer actually bought. That made
 * the stored return SKU wrong (e.g. CB129_MAG_BACK_3XL synced as
 * CB109_MAG_BACK_S), which would restock the wrong item on a SkuVault
 * add-back. The new code resolves the SKU from the live eBay ORDER
 * transaction; this one-off applies that same resolution to existing rows.
 *
 * SAFETY: Read-only against eBay (GetOrders only). Writes ONLY to our own
 * HelpdeskReturnCase table (the `sku`, and optionally `imageUrl`/`itemTitle`,
 * columns). No marketplace writes. Dry-run by default — pass --commit to write.
 *
 *   # Preview every change (no writes):
 *   pwsh scripts/run-with-prod.ps1 -Script scripts/_backfill-return-skus.ts
 *
 *   # Apply the corrections:
 *   pwsh scripts/run-with-prod.ps1 -Script scripts/_backfill-return-skus.ts -Args "--commit"
 *
 *   # Optional flags (combine as needed):
 *   --commit            actually write the corrected SKUs (default: dry-run)
 *   --platform=TPP|TT   limit to one store (default: both)
 *   --limit=N           process at most N rows (default: all)
 *   --fix-thumbnails    also correct imageUrl/itemTitle from the catalog when
 *                       the SKU changes (variation thumbnail fix)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";
import { Platform } from "@prisma/client";
import { buildEbayConfig } from "@/lib/services/helpdesk-ebay";
import { resolveOrderLineSku } from "@/lib/services/helpdesk-returns";

const EBAY_PLATFORMS: Platform[] = [Platform.TPP_EBAY, Platform.TT_EBAY];

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "true" : hit.slice(eq + 1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ChangeRow {
  returnId: string;
  platform: string;
  orderNumber: string | null;
  oldSku: string | null;
  newSku: string;
  itemTitle: string | null;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "<unknown>";
  if (!host.includes("little-fire")) {
    console.warn(
      `[backfill] WARNING: DATABASE_URL host is "${host}", not the prod little-fire pooler. ` +
        `Run via: pwsh scripts/run-with-prod.ps1 -Script scripts/_backfill-return-skus.ts`,
    );
  }
  console.log(`[backfill] connected to ${host}`);

  const commit = arg("commit") === "true";
  const fixThumbs = arg("fix-thumbnails") === "true";
  const platformArg = (arg("platform") ?? "").toUpperCase();
  const limit = Number.parseInt(arg("limit") ?? "0", 10) || 0;

  const platforms: Platform[] =
    platformArg === "TPP"
      ? [Platform.TPP_EBAY]
      : platformArg === "TT"
        ? [Platform.TT_EBAY]
        : EBAY_PLATFORMS;

  console.log(
    `[backfill] mode=${commit ? "COMMIT (will write)" : "DRY-RUN (no writes)"} ` +
      `platforms=${platforms.join(",")} limit=${limit || "all"} fixThumbnails=${fixThumbs}`,
  );

  const integrations = await db.integration.findMany({
    where: { platform: { in: platforms } },
  });

  const changes: ChangeRow[] = [];
  let checked = 0;
  let resolved = 0;
  let unchanged = 0;
  let noOrder = 0;
  let unresolved = 0;
  let updated = 0;
  let thumbsUpdated = 0;

  for (const integration of integrations) {
    const config = buildEbayConfig(integration);

    const rows = await db.helpdeskReturnCase.findMany({
      where: { integrationId: integration.id },
      orderBy: { openedAt: "desc" },
      select: {
        id: true,
        returnId: true,
        platform: true,
        ebayOrderNumber: true,
        transactionId: true,
        ebayItemId: true,
        sku: true,
        itemTitle: true,
      },
    });

    console.log(
      `\n[backfill] ${integration.platform}: ${rows.length} return rows to inspect`,
    );

    for (const row of rows) {
      if (limit && checked >= limit) break;
      checked++;

      if (!row.ebayOrderNumber) {
        noOrder++;
        continue;
      }

      const newSku = await resolveOrderLineSku(integration.id, config, {
        orderNumber: row.ebayOrderNumber,
        transactionId: row.transactionId,
        itemId: row.ebayItemId,
      });
      // Gentle throttle so a large backfill doesn't hammer eBay's GetOrders
      // quota. The order-context cache dedupes repeat orders in-process.
      await sleep(120);

      if (!newSku) {
        unresolved++;
        continue;
      }
      resolved++;

      if (newSku === row.sku) {
        unchanged++;
        continue;
      }

      changes.push({
        returnId: row.returnId,
        platform: row.platform,
        orderNumber: row.ebayOrderNumber,
        oldSku: row.sku,
        newSku,
        itemTitle: row.itemTitle,
      });
      console.log(
        `  ${row.returnId} (${row.ebayOrderNumber}): ${row.sku ?? "—"}  →  ${newSku}`,
      );

      if (commit) {
        // Optionally correct the variation thumbnail/title from our catalog by
        // the now-correct SKU (DB-only; the old SKU pointed at the wrong pic).
        const thumbPatch: { imageUrl?: string; itemTitle?: string } = {};
        if (fixThumbs) {
          const listing = await db.marketplaceListing.findFirst({
            where: { integrationId: integration.id, sku: newSku },
            select: { imageUrl: true, title: true },
          });
          if (listing?.imageUrl) thumbPatch.imageUrl = listing.imageUrl;
          if (!row.itemTitle && listing?.title) thumbPatch.itemTitle = listing.title;
        }
        await db.helpdeskReturnCase.update({
          where: { id: row.id },
          data: { sku: newSku, ...thumbPatch },
        });
        updated++;
        if (thumbPatch.imageUrl || thumbPatch.itemTitle) thumbsUpdated++;
      }
    }
    if (limit && checked >= limit) break;
  }

  console.log("\n──────────────── SUMMARY ────────────────");
  console.log(`rows inspected:         ${checked}`);
  console.log(`SKU resolved from order:${resolved}`);
  console.log(`already correct:        ${unchanged}`);
  console.log(`needing correction:     ${changes.length}`);
  console.log(`could not resolve:      ${unresolved}`);
  console.log(`no order number:        ${noOrder}`);
  if (commit) {
    console.log(`rows updated:           ${updated}`);
    if (fixThumbs) console.log(`thumbnails corrected:   ${thumbsUpdated}`);
  } else {
    console.log(`\n(DRY-RUN — nothing was written. Re-run with --commit to apply.)`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportsDir = join(process.cwd(), "reports");
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(
    reportsDir,
    `returns-sku-backfill-${commit ? "live" : "dry-run"}-${stamp}.json`,
  );
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        host,
        mode: commit ? "live" : "dry-run",
        platforms,
        limit: limit || null,
        fixThumbnails: fixThumbs,
        totals: {
          checked,
          resolved,
          unchanged,
          needingCorrection: changes.length,
          unresolved,
          noOrder,
          updated: commit ? updated : 0,
          thumbsUpdated: commit ? thumbsUpdated : 0,
        },
        changes,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n[backfill] report written: ${reportPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
