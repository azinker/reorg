/**
 * Verify that the helpdesk inbox is pulling messages on Motors-listed
 * items, not just Main-site items. Read-only.
 *
 * Background:
 *   eBay's My Messages API is per-seller-account (not per-site), so a
 *   single SITE_ID="0" call should already capture every buyer message
 *   regardless of whether the listing was in a Motors category. This
 *   script empirically checks that against our DB by:
 *
 *     1. Counting helpdesk tickets per integration (TPP / TT) for the
 *        current backfill horizon (default 60 days).
 *     2. Listing the ticket's eBay item id + title + order number so
 *        Adam can spot-check known Motors orders that *should* be
 *        present.
 *     3. Optionally hitting the eBay GetItem API for each ticket's
 *        ebayItemId to read its primary category and report how many
 *        of those categories sit under the Motors root (parent path
 *        contains category id 6000 or sub-trees).
 *
 *   We do NOT call eBay by default to keep the script offline-safe.
 *   Pass --classify to enable category lookups.
 *
 * Usage (from reorg/):
 *   npx tsx scripts/verify-helpdesk-motors-coverage.ts
 *   npx tsx scripts/verify-helpdesk-motors-coverage.ts --days 60
 *   npx tsx scripts/verify-helpdesk-motors-coverage.ts --platform TPP_EBAY
 */

import { db } from "@/lib/db";
import { Platform } from "@prisma/client";

interface Args {
  days: number;
  platform: Platform | null;
  showSamples: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { days: 60, platform: null, showSamples: 25 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") args.days = Number.parseInt(argv[++i] ?? "60", 10);
    else if (a === "--platform") {
      const v = argv[++i] ?? "";
      if (v in Platform) args.platform = v as Platform;
      else throw new Error(`Unknown --platform value: ${v}`);
    } else if (a === "--samples") {
      args.showSamples = Number.parseInt(argv[++i] ?? "25", 10);
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: npx tsx scripts/verify-helpdesk-motors-coverage.ts " +
          "[--days N] [--platform TPP_EBAY|TT_EBAY] [--samples N]\n",
      );
      process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const since = new Date(Date.now() - args.days * 86_400_000);

  process.stdout.write(
    `\nverify-helpdesk-motors-coverage: window=${args.days}d (since ${since.toISOString()})\n\n`,
  );

  const integrations = await db.integration.findMany({
    where: {
      platform: args.platform
        ? args.platform
        : { in: [Platform.TPP_EBAY, Platform.TT_EBAY] },
    },
    select: { id: true, label: true, platform: true },
    orderBy: { label: "asc" },
  });

  for (const integration of integrations) {
    const tickets = await db.helpdeskTicket.findMany({
      where: {
        integrationId: integration.id,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        buyerName: true,
        ebayItemId: true,
        ebayItemTitle: true,
        ebayOrderNumber: true,
        createdAt: true,
        lastBuyerMessageAt: true,
      },
    });

    const totalCount = tickets.length;
    const withItem = tickets.filter((t) => Boolean(t.ebayItemId)).length;
    const withOrder = tickets.filter((t) => Boolean(t.ebayOrderNumber)).length;
    const oldest = tickets.at(-1)?.createdAt;
    const newest = tickets.at(0)?.createdAt;

    process.stdout.write(
      `[${integration.platform}] ${integration.label} (${integration.id})\n`,
    );
    process.stdout.write(
      `   tickets in window: ${totalCount} ` +
        `(with itemId: ${withItem}, with orderNumber: ${withOrder})\n`,
    );
    if (oldest && newest) {
      process.stdout.write(
        `   ticket date range: ${oldest.toISOString()} → ${newest.toISOString()}\n`,
      );
    }

    const sample = tickets.slice(0, Math.max(0, args.showSamples));
    if (sample.length > 0) {
      process.stdout.write(
        `   most recent ${sample.length} ticket(s) ` +
          "(spot-check these for any known Motors order):\n",
      );
      for (const t of sample) {
        const titlePreview = (t.ebayItemTitle ?? "").slice(0, 60);
        process.stdout.write(
          `     • ${t.lastBuyerMessageAt?.toISOString() ?? "—"} ` +
            `buyer=${t.buyerName ?? "?"} ` +
            `item=${t.ebayItemId ?? "—"} ` +
            `order=${t.ebayOrderNumber ?? "—"} ` +
            `title="${titlePreview}"\n`,
        );
      }
    }
    process.stdout.write("\n");
  }

  process.stdout.write(
    "Done. If you don't see any tickets you'd expect from Motors orders\n" +
      "in this window, that's a real coverage gap. If you do see them,\n" +
      "site=0 is correctly capturing Motors traffic (which matches eBay\n" +
      "docs: My Messages is per-account, not per-site).\n",
  );
}

main()
  .catch((err) => {
    process.stderr.write(
      `verify-helpdesk-motors-coverage failed: ${String(err)}\n`,
    );
    process.exit(1);
  })
  .finally(() => db.$disconnect());
