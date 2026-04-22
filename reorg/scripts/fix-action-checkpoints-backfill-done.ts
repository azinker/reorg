/**
 * One-off cleanup: mark action-mirror checkpoints (returns / cancellations
 * / feedback) as `backfillDone=true`. These checkpoints use a watermark-
 * based sync model and never had a backfill phase, but were still left at
 * `backfillDone=false` because the original action workers didn't set the
 * flag. The result was that the Help Desk header badge "Backfilling 60
 * days" stayed on forever even after the messages backfill was done.
 *
 * Going forward, `helpdesk-ebay-actions.ts` sets `backfillDone=true` on
 * every successful tick, so this script is only needed once to clear the
 * historical backlog.
 */
import { db } from "@/lib/db";

async function main() {
  const result = await db.helpdeskSyncCheckpoint.updateMany({
    where: {
      folder: { in: ["returns", "cancellations", "feedback"] },
      backfillDone: false,
    },
    data: { backfillDone: true },
  });
  console.log(`Flipped ${result.count} action-mirror checkpoints to backfillDone=true`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
