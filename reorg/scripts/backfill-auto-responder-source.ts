/**
 * Backfill HelpdeskMessage.source = AUTO_RESPONDER for outbound messages
 * that originated from the Auto Responder before the v2 source-tagging
 * change went live. Idempotent: safe to re-run, skips messages whose
 * source is already AUTO_RESPONDER.
 *
 * The match is exact — we look up AutoResponderSendLog rows whose
 * externalMessageId matches the HelpdeskMessage.ebayMessageId or
 * .externalId. There is no fuzzy text matching, so this script will
 * never re-classify a human agent reply by mistake.
 *
 * Usage (from reorg/):
 *   npx tsx scripts/backfill-auto-responder-source.ts
 *   npx tsx scripts/backfill-auto-responder-source.ts --dry-run
 */

import { db } from "@/lib/db";
import {
  HelpdeskMessageDirection,
  HelpdeskMessageSource,
} from "@prisma/client";

interface BackfillStats {
  scanned: number;
  matched: number;
  alreadyTagged: number;
  updated: number;
}

async function backfillAutoResponderSource(opts: { dryRun: boolean }): Promise<BackfillStats> {
  const stats: BackfillStats = {
    scanned: 0,
    matched: 0,
    alreadyTagged: 0,
    updated: 0,
  };

  // Pull every successful AR send log with an externalMessageId. These are
  // the messages we *know* the AR sent. Doing this in one bounded query
  // keeps the script O(N) and avoids a per-row lookup.
  const arLogs = await db.autoResponderSendLog.findMany({
    where: {
      eventType: "SENT",
      externalMessageId: { not: null },
    },
    select: { externalMessageId: true, integrationId: true },
  });

  const byMessageId = new Map<string, string>(); // messageId → integrationId
  for (const log of arLogs) {
    if (log.externalMessageId) {
      byMessageId.set(log.externalMessageId, log.integrationId);
    }
  }

  console.log(`[backfill] Found ${byMessageId.size} successful AR sends to match against.`);

  if (byMessageId.size === 0) {
    return stats;
  }

  const messageIds = Array.from(byMessageId.keys());
  // Match by either ebayMessageId or externalId — the sync uses both fields
  // on insert and either could carry the eBay-issued id depending on the
  // historical sync version that ran when the row was written.
  const candidates = await db.helpdeskMessage.findMany({
    where: {
      direction: HelpdeskMessageDirection.OUTBOUND,
      OR: [
        { ebayMessageId: { in: messageIds } },
        { externalId: { in: messageIds } },
      ],
    },
    select: {
      id: true,
      source: true,
      ebayMessageId: true,
      externalId: true,
      ticket: { select: { integrationId: true } },
    },
  });

  stats.scanned = candidates.length;
  console.log(`[backfill] Scanning ${stats.scanned} outbound HelpdeskMessage rows.`);

  const toUpdate: string[] = [];
  for (const m of candidates) {
    const matchedId = m.ebayMessageId && byMessageId.has(m.ebayMessageId)
      ? m.ebayMessageId
      : m.externalId && byMessageId.has(m.externalId)
        ? m.externalId
        : null;
    if (!matchedId) continue;

    // Sanity check: the integration on the ticket must match the AR log's
    // integration, otherwise we'd risk reclassifying across stores. In
    // practice eBay messageIds are unique per seller account, so this is
    // belt-and-suspenders.
    const arIntegrationId = byMessageId.get(matchedId);
    if (arIntegrationId && m.ticket.integrationId !== arIntegrationId) continue;

    stats.matched++;
    if (m.source === HelpdeskMessageSource.AUTO_RESPONDER) {
      stats.alreadyTagged++;
      continue;
    }
    toUpdate.push(m.id);
  }

  console.log(
    `[backfill] Matched: ${stats.matched}; already tagged: ${stats.alreadyTagged}; need update: ${toUpdate.length}`,
  );

  if (opts.dryRun) {
    console.log("[backfill] --dry-run: no writes performed.");
    return stats;
  }

  // Chunk the updates so a single huge updateMany doesn't time out on Neon.
  const CHUNK = 500;
  for (let i = 0; i < toUpdate.length; i += CHUNK) {
    const slice = toUpdate.slice(i, i + CHUNK);
    const { count } = await db.helpdeskMessage.updateMany({
      where: { id: { in: slice } },
      data: { source: HelpdeskMessageSource.AUTO_RESPONDER },
    });
    stats.updated += count;
    console.log(
      `[backfill] Updated chunk ${i / CHUNK + 1}: ${count} rows (running total ${stats.updated}).`,
    );
  }

  return stats;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`[backfill] starting (dryRun=${dryRun})`);
  const stats = await backfillAutoResponderSource({ dryRun });
  console.log("[backfill] done", stats);
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error("[backfill] failed", err);
  await db.$disconnect();
  process.exit(1);
});
