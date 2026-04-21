/**
 * Reset HelpdeskSyncCheckpoint rows so the eBay sync cron re-runs the
 * configured BACKFILL_DAYS window from scratch.
 *
 * Why this exists:
 *   The helpdesk-ebay-sync worker only walks the backfill horizon once
 *   per (integrationId, folder) pair. Once `backfillDone=true`, every
 *   subsequent tick goes incremental from `lastWatermark` and ignores
 *   the BACKFILL_DAYS constant.
 *
 *   So if you change BACKFILL_DAYS (or the env var
 *   HELPDESK_BACKFILL_DAYS) and want the new horizon to actually be
 *   pulled, you have to flip `backfillDone` back to false on the
 *   checkpoints. This script does exactly that, optionally scoped to
 *   one integration / one platform.
 *
 * Safety:
 *   - This is a READ-AMPLIFYING op, not a write to eBay. We never
 *     touch HelpdeskMessage / HelpdeskTicket / StagedChange rows.
 *   - Existing tickets and messages are preserved; the sync's upsert
 *     logic dedupes on ebayMessageId so re-pulling old windows just
 *     reconfirms what we already have.
 *   - Defaults to --dry-run; you must pass --apply to actually write.
 *
 * Usage (from reorg/):
 *   # See what would change for every eBay integration
 *   npx tsx scripts/reset-helpdesk-backfill.ts
 *
 *   # Actually reset every eBay integration
 *   npx tsx scripts/reset-helpdesk-backfill.ts --apply
 *
 *   # Scope to one integration by id or by platform
 *   npx tsx scripts/reset-helpdesk-backfill.ts --apply --integration cln1234abc
 *   npx tsx scripts/reset-helpdesk-backfill.ts --apply --platform TPP_EBAY
 *   npx tsx scripts/reset-helpdesk-backfill.ts --apply --platform TT_EBAY
 */

import { db } from "@/lib/db";
import { Platform } from "@prisma/client";

interface ResetArgs {
  apply: boolean;
  integrationId: string | null;
  platform: Platform | null;
}

function parseArgs(argv: string[]): ResetArgs {
  const args: ResetArgs = { apply: false, integrationId: null, platform: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--integration") args.integrationId = argv[++i] ?? null;
    else if (a === "--platform") {
      const v = argv[++i] ?? "";
      if (v in Platform) args.platform = v as Platform;
      else throw new Error(`Unknown --platform value: ${v}`);
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: npx tsx scripts/reset-helpdesk-backfill.ts [--apply] " +
          "[--integration <id>] [--platform EBAY_TPP|EBAY_TT]\n",
      );
      process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const horizonDays = Number.parseInt(
    process.env.HELPDESK_BACKFILL_DAYS ?? "60",
    10,
  );

  process.stdout.write(
    `\nreset-helpdesk-backfill: horizon=${horizonDays}d ` +
      `apply=${args.apply} integration=${args.integrationId ?? "ALL"} ` +
      `platform=${args.platform ?? "ALL eBay"}\n\n`,
  );

  const integrations = await db.integration.findMany({
    where: {
      platform: args.platform
        ? args.platform
        : { in: [Platform.TPP_EBAY, Platform.TT_EBAY] },
      ...(args.integrationId ? { id: args.integrationId } : {}),
    },
    select: { id: true, label: true, platform: true },
    orderBy: { label: "asc" },
  });

  if (integrations.length === 0) {
    process.stdout.write("No matching integrations found.\n");
    return;
  }

  let totalCheckpoints = 0;
  let totalReset = 0;

  for (const integration of integrations) {
    const checkpoints = await db.helpdeskSyncCheckpoint.findMany({
      where: { integrationId: integration.id },
      orderBy: { folder: "asc" },
    });
    totalCheckpoints += checkpoints.length;

    process.stdout.write(
      `[${integration.platform}] ${integration.label} (${integration.id}) ` +
        `→ ${checkpoints.length} checkpoint(s)\n`,
    );

    for (const cp of checkpoints) {
      const wasDone = cp.backfillDone;
      const cursor = cp.backfillCursor
        ? cp.backfillCursor.toISOString()
        : "null";
      const watermark = cp.lastWatermark
        ? cp.lastWatermark.toISOString()
        : "null";
      process.stdout.write(
        `   folder=${cp.folder.padEnd(8)} done=${String(wasDone).padEnd(5)} ` +
          `cursor=${cursor} watermark=${watermark}\n`,
      );
      if (!wasDone && cp.backfillCursor === null) {
        // Already in a fresh state, no point flipping it.
        continue;
      }
      if (args.apply) {
        await db.helpdeskSyncCheckpoint.update({
          where: { id: cp.id },
          data: { backfillDone: false, backfillCursor: null },
        });
        totalReset++;
      } else {
        totalReset++;
      }
    }
  }

  process.stdout.write(
    `\n${args.apply ? "Reset" : "Would reset"} ${totalReset}/${totalCheckpoints} ` +
      `checkpoint(s) across ${integrations.length} integration(s).\n`,
  );
  if (!args.apply) {
    process.stdout.write("Dry run. Re-run with --apply to actually write.\n");
  } else {
    process.stdout.write(
      "\nNext step: trigger the helpdesk-poll cron (or wait for the next " +
        "scheduled tick). Each tick advances ~7 days, so a full 60-day " +
        "backfill will complete in ~9 ticks per integration.\n",
    );
  }
}

main()
  .catch((err) => {
    process.stderr.write(`reset-helpdesk-backfill failed: ${String(err)}\n`);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
