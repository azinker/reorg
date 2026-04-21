/**
 * Snapshot the current state of every HelpdeskSyncCheckpoint so you can
 * watch the 60-day backfill progress in real time.
 *
 * Shows, per (integration, folder):
 *   - backfillDone flag
 *   - backfillCursor (oldest point we've successfully walked back to)
 *   - lastWatermark  (newest point in the incremental window)
 *   - ticket + message counts inside the configured horizon
 *   - "days remaining" estimate based on horizon vs cursor
 *
 * Read-only. Safe to run any time.
 *
 * Usage (from reorg/):
 *   npx tsx scripts/watch-helpdesk-backfill.ts
 *   # or loop it every 30s in PowerShell:
 *   while ($true) { Clear-Host; npx tsx scripts/watch-helpdesk-backfill.ts; Start-Sleep 30 }
 */

import { db } from "@/lib/db";
import { Platform } from "@prisma/client";

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function fmtAgo(d: Date | null): string {
  if (!d) return "";
  const ms = Date.now() - d.getTime();
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `(${mins}m ago)`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `(${hrs}h ago)`;
  const days = Math.round(hrs / 24);
  return `(${days}d ago)`;
}

async function main(): Promise<void> {
  const horizonDays = Number.parseInt(
    process.env.HELPDESK_BACKFILL_DAYS ?? "60",
    10,
  );
  const horizonStart = new Date(Date.now() - horizonDays * 86_400_000);

  process.stdout.write(
    `\nhelpdesk backfill watch | horizon=${horizonDays}d ` +
      `(target oldest=${fmtDate(horizonStart)}) | now=${fmtDate(new Date())}\n\n`,
  );

  const integrations = await db.integration.findMany({
    where: { platform: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] } },
    select: { id: true, label: true, platform: true },
    orderBy: { label: "asc" },
  });

  let totalTicketsInWindow = 0;
  let totalMsgsInWindow = 0;

  for (const integration of integrations) {
    const checkpoints = await db.helpdeskSyncCheckpoint.findMany({
      where: { integrationId: integration.id },
      orderBy: { folder: "asc" },
    });

    process.stdout.write(
      `[${integration.platform}] ${integration.label}\n`,
    );

    if (checkpoints.length === 0) {
      process.stdout.write("   (no checkpoints yet — first cron tick will create them)\n\n");
      continue;
    }

    for (const cp of checkpoints) {
      const cursorAge = cp.backfillCursor
        ? Math.round(
            (Date.now() - cp.backfillCursor.getTime()) / 86_400_000,
          )
        : null;
      const remainingDays =
        cursorAge !== null ? Math.max(0, horizonDays - cursorAge) : horizonDays;
      const pct =
        cursorAge !== null
          ? Math.min(100, Math.round((cursorAge / horizonDays) * 100))
          : 0;

      const status = cp.backfillDone
        ? "DONE "
        : cp.backfillCursor
          ? "RUN  "
          : "FRESH";

      process.stdout.write(
        `   folder=${cp.folder.padEnd(7)} [${status}] ` +
          `progress=${String(pct).padStart(3)}%  ` +
          `cursor=${fmtDate(cp.backfillCursor)} ${fmtAgo(cp.backfillCursor)}\n`,
      );
      process.stdout.write(
        `                    watermark=${fmtDate(cp.lastWatermark)} ${fmtAgo(cp.lastWatermark)}` +
          `   ~${remainingDays}d to go\n`,
      );
    }

    const tickets = await db.helpdeskTicket.count({
      where: {
        integrationId: integration.id,
        createdAt: { gte: horizonStart },
      },
    });
    const msgs = await db.helpdeskMessage.count({
      where: {
        ticket: { integrationId: integration.id },
        createdAt: { gte: horizonStart },
      },
    });
    totalTicketsInWindow += tickets;
    totalMsgsInWindow += msgs;

    process.stdout.write(
      `   tickets in last ${horizonDays}d: ${tickets}   messages in last ${horizonDays}d: ${msgs}\n\n`,
    );
  }

  process.stdout.write(
    `TOTAL across eBay integrations: ${totalTicketsInWindow} tickets, ${totalMsgsInWindow} messages in last ${horizonDays}d.\n`,
  );
  process.stdout.write(
    "\nLegend: FRESH = reset, hasn't run yet | RUN = walking backward | DONE = full horizon synced.\n" +
      "Each cron tick advances ONE checkpoint by ~7 days. Weekday peak fires every 5 min.\n",
  );
}

main()
  .catch((err) => {
    process.stderr.write(`watch-helpdesk-backfill failed: ${String(err)}\n`);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
