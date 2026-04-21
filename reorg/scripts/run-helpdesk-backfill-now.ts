/**
 * Manually drive the helpdesk eBay sync until all checkpoints reach
 * backfillDone=true, bypassing Vercel cron entirely.
 *
 * Why this exists:
 *   Vercel paused our scheduled crons (April 2026 incident) and the
 *   dashboard is locked behind a security checkpoint, so we can't re-
 *   enable them right now. This script invokes the same code path the
 *   cron would have invoked (`runHelpdeskPoll` + `runHelpdeskActionsPoll`)
 *   directly against the prod DB from the operator's laptop.
 *
 * Safety:
 *   - This is the EXACT code the cron runs in prod. No new behavior.
 *   - eBay sync is pull-only. We never push to eBay from here.
 *   - StagedChange / push queue / write locks are not touched.
 *   - Each iteration also runs the actions worker (returns / cancels /
 *     feedback) so the timeline events backfill in lockstep.
 *
 * Usage (from reorg/):
 *   npx tsx scripts/run-helpdesk-backfill-now.ts
 *   npx tsx scripts/run-helpdesk-backfill-now.ts --max-iters 30
 *   npx tsx scripts/run-helpdesk-backfill-now.ts --skip-actions
 *
 * The script polls in a loop, prints the result of each iteration, and
 * stops as soon as every (integration, folder) checkpoint is DONE — or
 * after --max-iters iterations as a safety cap (default 40).
 */

import { db } from "@/lib/db";
import { Platform } from "@prisma/client";
import { runHelpdeskPoll } from "@/lib/services/helpdesk-ebay-sync";
import { runHelpdeskActionsPoll } from "@/lib/services/helpdesk-ebay-actions";

interface Args {
  maxIters: number;
  skipActions: boolean;
  pauseMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { maxIters: 40, skipActions: false, pauseMs: 1500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-iters") args.maxIters = Number.parseInt(argv[++i] ?? "40", 10);
    else if (a === "--skip-actions") args.skipActions = true;
    else if (a === "--pause-ms") args.pauseMs = Number.parseInt(argv[++i] ?? "1500", 10);
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: npx tsx scripts/run-helpdesk-backfill-now.ts [--max-iters N] [--skip-actions] [--pause-ms N]\n",
      );
      process.exit(0);
    }
  }
  return args;
}

interface CheckpointSnapshot {
  integrationLabel: string;
  platform: Platform;
  folder: string;
  done: boolean;
  cursorIso: string | null;
}

async function snapshotCheckpoints(): Promise<CheckpointSnapshot[]> {
  const integrations = await db.integration.findMany({
    where: { platform: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] } },
    select: { id: true, label: true, platform: true },
  });
  const intById = new Map(integrations.map((i) => [i.id, i] as const));
  const cps = await db.helpdeskSyncCheckpoint.findMany({
    where: { integrationId: { in: integrations.map((i) => i.id) } },
    orderBy: [{ integrationId: "asc" }, { folder: "asc" }],
  });
  return cps.map((cp) => {
    const integ = intById.get(cp.integrationId);
    return {
      integrationLabel: integ?.label ?? cp.integrationId,
      platform: integ?.platform ?? Platform.TPP_EBAY,
      folder: cp.folder,
      done: cp.backfillDone,
      cursorIso: cp.backfillCursor ? cp.backfillCursor.toISOString() : null,
    };
  });
}

function printSnapshot(snap: CheckpointSnapshot[]): void {
  for (const s of snap) {
    const status = s.done ? "DONE " : s.cursorIso ? "RUN  " : "FRESH";
    const cursor = s.cursorIso ?? "—";
    process.stdout.write(
      `   [${status}] ${s.platform.padEnd(9)} ${s.folder.padEnd(7)} cursor=${cursor}\n`,
    );
  }
}

async function snapshotCounts(): Promise<{ tickets: number; messages: number }> {
  const horizonDays = Number.parseInt(process.env.HELPDESK_BACKFILL_DAYS ?? "60", 10);
  const since = new Date(Date.now() - horizonDays * 86_400_000);
  const tickets = await db.helpdeskTicket.count({
    where: {
      createdAt: { gte: since },
      integration: { platform: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] } },
    },
  });
  const messages = await db.helpdeskMessage.count({
    where: {
      createdAt: { gte: since },
      ticket: {
        integration: { platform: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] } },
      },
    },
  });
  return { tickets, messages };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write(
    `\nrun-helpdesk-backfill-now: maxIters=${args.maxIters} skipActions=${args.skipActions} pauseMs=${args.pauseMs}\n`,
  );

  const before = await snapshotCounts();
  process.stdout.write(
    `Starting counts: ${before.tickets} tickets, ${before.messages} messages in window.\n\n`,
  );

  process.stdout.write("Initial checkpoints:\n");
  printSnapshot(await snapshotCheckpoints());
  process.stdout.write("\n");

  let iter = 0;
  let allDone = false;

  while (iter < args.maxIters && !allDone) {
    iter++;
    const iterStart = Date.now();
    process.stdout.write(`── Iteration ${iter}/${args.maxIters} ──\n`);
    try {
      const result = await runHelpdeskPoll();
      const totals = result.summaries.reduce(
        (acc, s) => {
          acc.headersFetched += s.headersFetched;
          acc.bodiesFetched += s.bodiesFetched;
          acc.ticketsCreated += s.ticketsCreated;
          acc.ticketsUpdated += s.ticketsUpdated;
          acc.messagesInserted += s.messagesInserted;
          acc.errors += s.error ? 1 : 0;
          if (s.backfillAdvanced) acc.advanced++;
          if (s.backfillDone) acc.justDone++;
          return acc;
        },
        {
          headersFetched: 0,
          bodiesFetched: 0,
          ticketsCreated: 0,
          ticketsUpdated: 0,
          messagesInserted: 0,
          errors: 0,
          advanced: 0,
          justDone: 0,
        },
      );
      process.stdout.write(
        `   poll: ${result.durationMs}ms  headers=${totals.headersFetched} bodies=${totals.bodiesFetched} ` +
          `tCreated=${totals.ticketsCreated} tUpdated=${totals.ticketsUpdated} mInserted=${totals.messagesInserted} ` +
          `advanced=${totals.advanced} justDone=${totals.justDone} errors=${totals.errors}\n`,
      );
      for (const s of result.summaries) {
        if (s.error) {
          process.stdout.write(
            `   ! error on ${s.platform}/${s.folder}: ${s.error}\n`,
          );
        }
      }
    } catch (err) {
      process.stderr.write(`   poll FAILED: ${String(err)}\n`);
    }

    if (!args.skipActions) {
      try {
        const actions = await runHelpdeskActionsPoll();
        const actTot = actions.summaries.reduce(
          (acc, s) => {
            acc.cancellations += s.cancellations;
            acc.returns += s.returns;
            acc.feedback += s.feedback;
            acc.errors += s.errors.length;
            return acc;
          },
          { cancellations: 0, returns: 0, feedback: 0, errors: 0 },
        );
        process.stdout.write(
          `   actions: ${actions.durationMs}ms  cancels=${actTot.cancellations} returns=${actTot.returns} feedback=${actTot.feedback} errors=${actTot.errors}\n`,
        );
        for (const s of actions.summaries) {
          for (const e of s.errors) {
            process.stdout.write(`   ! action error on ${s.integrationId}: ${e}\n`);
          }
        }
      } catch (err) {
        process.stderr.write(`   actions FAILED: ${String(err)}\n`);
      }
    }

    const snap = await snapshotCheckpoints();
    printSnapshot(snap);
    allDone = snap.length > 0 && snap.every((s) => s.done);

    const elapsed = Date.now() - iterStart;
    process.stdout.write(`   iter took ${elapsed}ms; allDone=${allDone}\n\n`);

    if (!allDone && args.pauseMs > 0) {
      await new Promise((r) => setTimeout(r, args.pauseMs));
    }
  }

  const after = await snapshotCounts();
  process.stdout.write("\n══ FINAL ══\n");
  process.stdout.write(
    `Counts: ${before.tickets} → ${after.tickets} tickets ` +
      `(+${after.tickets - before.tickets}), ` +
      `${before.messages} → ${after.messages} messages ` +
      `(+${after.messages - before.messages}) in last 60 days.\n`,
  );
  process.stdout.write(
    allDone
      ? `All checkpoints DONE after ${iter} iteration(s). Backfill complete.\n`
      : `Stopped at iter ${iter} (max=${args.maxIters}); some checkpoints still not DONE. Re-run to continue.\n`,
  );
}

main()
  .catch((err) => {
    process.stderr.write(`run-helpdesk-backfill-now failed: ${String(err)}\n`);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
