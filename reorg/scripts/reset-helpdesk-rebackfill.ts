/**
 * Reset Help Desk sync checkpoints to trigger a full re-backfill.
 *
 * The original sync had a bug where the watermark/cursor advanced past
 * messages that were never actually fetched (body fetch throttle of 80/tick
 * was far below the volume). This script resets all checkpoints so the
 * sync re-crawls the full BACKFILL_DAYS window and picks up the thousands
 * of skipped messages.
 *
 * Safe to run: the sync's dedup logic (externalId + bodyHash) prevents
 * re-inserting messages we already have.
 *
 * Usage: npx dotenv-cli -e .env.production -- npx tsx scripts/reset-helpdesk-rebackfill.ts [--execute]
 */
import { db } from "../src/lib/db";

const DRY_RUN = !process.argv.includes("--execute");

async function main() {
  if (DRY_RUN) {
    console.log("=== DRY RUN (pass --execute to apply) ===\n");
  }

  const checkpoints = await db.helpdeskSyncCheckpoint.findMany();
  const integrations = await db.integration.findMany({
    where: { id: { in: checkpoints.map((c) => c.integrationId) } },
    select: { id: true, label: true, platform: true },
  });
  const integMap = new Map(integrations.map((i) => [i.id, i]));

  console.log(`Found ${checkpoints.length} checkpoints:\n`);

  for (const cp of checkpoints) {
    const label = integMap.get(cp.integrationId)?.label ?? "?";
    console.log(
      `  ${label} | ${cp.folder} | watermark: ${cp.lastWatermark?.toISOString() ?? "null"} | backfillDone: ${cp.backfillDone} | cursor: ${cp.backfillCursor?.toISOString() ?? "null"}`
    );
  }

  // Only reset inbox and sent (where the message bodies live).
  const toReset = checkpoints.filter(
    (cp) => cp.folder === "inbox" || cp.folder === "sent"
  );

  console.log(`\nResetting ${toReset.length} inbox/sent checkpoints...`);

  if (!DRY_RUN) {
    for (const cp of toReset) {
      await db.helpdeskSyncCheckpoint.update({
        where: { id: cp.id },
        data: {
          backfillDone: false,
          backfillCursor: null,
          lastWatermark: null,
        },
      });
      const label = integMap.get(cp.integrationId)?.label ?? "?";
      console.log(`  Reset: ${label} | ${cp.folder}`);
    }
    console.log("\nDone. The next cron ticks will re-backfill from scratch.");
  } else {
    console.log("  (skipped — dry run)");
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
