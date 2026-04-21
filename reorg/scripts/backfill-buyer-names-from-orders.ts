/**
 * Backfill `HelpdeskTicket.buyerName` from `MarketplaceSaleOrder.buyerDisplayLabel`.
 *
 * This is the "post-sales" backfill — for every ticket that has an
 * ebayOrderNumber and a matching MarketplaceSaleOrder row whose
 * buyerDisplayLabel looks like a real human name (i.e. NOT just the eBay
 * username), copy the name onto the ticket so the Customer column shows
 * "Jonathan Towers" instead of "iegal92".
 *
 * Strategy
 * ────────
 * 1. Pull every ticket with `ebayOrderNumber IS NOT NULL`.
 * 2. Join MarketplaceSaleOrder by (platform, externalOrderId).
 * 3. If the order's buyerDisplayLabel != buyerIdentifier (= it's not just
 *    the username), and != ticket.buyerName already, write it back.
 *
 * Safety
 * ──────
 * - `--apply` flag required to actually write.
 * - Never overwrites a buyerName that already differs from buyerUserId
 *   AND differs from the order's label (if both look like real names,
 *   prefer the order — it's the canonical source).
 * - Never sets buyerName to anything that looks like a bare username
 *   (heuristic: must contain a space or non-alphanumeric).
 */
import { db } from "@/lib/db";

const APPLY = process.argv.includes("--apply");

function looksLikeRealName(label: string | null | undefined): boolean {
  if (!label) return false;
  const trimmed = label.trim();
  if (trimmed.length < 3) return false;
  // Heuristic: a "real name" is at least two whitespace-separated tokens,
  // each starting with a letter. Eg "Jonathan Towers", "John D Smith".
  return /^\S+\s+\S+/.test(trimmed) && /[A-Za-z]/.test(trimmed);
}

async function main() {
  const mode = APPLY ? "APPLY" : "DRY-RUN";
  console.log(`[backfill-buyer-names-from-orders] starting (${mode})`);

  const tickets = await db.helpdeskTicket.findMany({
    where: {
      ebayOrderNumber: { not: null },
    },
    select: {
      id: true,
      channel: true,
      ebayOrderNumber: true,
      buyerUserId: true,
      buyerName: true,
    },
  });
  console.log(`  candidate tickets: ${tickets.length}`);

  // Bulk-load every relevant sale order in one query, key by
  // (platform, externalOrderId) so the per-ticket loop is O(1).
  const orderKeys = tickets
    .filter((t) => t.ebayOrderNumber)
    .map((t) => ({
      platform: t.channel,
      externalOrderId: t.ebayOrderNumber!,
    }));

  // Postgres OR with thousands of pairs is slow — chunk into reasonable
  // batches.
  const BATCH = 500;
  const orderMap = new Map<string, { buyerIdentifier: string | null; buyerDisplayLabel: string | null }>();
  for (let i = 0; i < orderKeys.length; i += BATCH) {
    const slice = orderKeys.slice(i, i + BATCH);
    const orders = await db.marketplaceSaleOrder.findMany({
      where: {
        OR: slice.map((k) => ({
          platform: k.platform,
          externalOrderId: k.externalOrderId,
        })),
      },
      select: {
        platform: true,
        externalOrderId: true,
        buyerIdentifier: true,
        buyerDisplayLabel: true,
      },
    });
    for (const o of orders) {
      orderMap.set(`${o.platform}::${o.externalOrderId}`, {
        buyerIdentifier: o.buyerIdentifier,
        buyerDisplayLabel: o.buyerDisplayLabel,
      });
    }
  }

  console.log(`  matched sale orders: ${orderMap.size}`);

  let updated = 0;
  let noOrder = 0;
  let noRealName = 0;
  let alreadyGood = 0;
  let i = 0;
  for (const t of tickets) {
    i++;
    if (i % 500 === 0) console.log(`  ... ${i}/${tickets.length}`);

    const key = `${t.channel}::${t.ebayOrderNumber}`;
    const order = orderMap.get(key);
    if (!order) {
      noOrder++;
      continue;
    }

    const label = order.buyerDisplayLabel?.trim() || null;
    // Skip if the order's label is just the username (or a bare handle):
    // that's no improvement over what we already have.
    if (!looksLikeRealName(label)) {
      noRealName++;
      continue;
    }

    // Skip if the ticket already carries the same name (case-insensitive).
    const existing = (t.buyerName ?? "").trim().toLowerCase();
    if (existing === label!.toLowerCase()) {
      alreadyGood++;
      continue;
    }

    // Don't replace a real name that's already different — but DO replace
    // anything that looks like the username. Treat "matches buyerUserId"
    // OR "single token" as upgradeable.
    const existingLooksReal = looksLikeRealName(t.buyerName);
    const existingIsUsername =
      !!t.buyerName &&
      !!t.buyerUserId &&
      t.buyerName.toLowerCase() === t.buyerUserId.toLowerCase();
    if (existingLooksReal && !existingIsUsername) {
      // Both are "real names" but disagree — prefer order side and overwrite.
      // Order data is canonical; the existing value usually came from a
      // scraped greeting that may be stale or wrong.
    }

    if (APPLY) {
      try {
        await db.helpdeskTicket.update({
          where: { id: t.id },
          data: { buyerName: label },
        });
      } catch (err) {
        console.error(`  failed to update ${t.id}:`, err);
        continue;
      }
    }
    updated++;
  }

  console.log("\n[backfill-buyer-names-from-orders] done");
  console.log(`  scanned:                 ${tickets.length}`);
  console.log(`  updated:                 ${updated}`);
  console.log(`  no matching order:       ${noOrder}`);
  console.log(`  order had no real name:  ${noRealName}`);
  console.log(`  ticket already correct:  ${alreadyGood}`);
  if (!APPLY) {
    console.log("\n  (dry-run — pass --apply to actually update)");
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
