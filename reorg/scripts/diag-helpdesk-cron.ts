/**
 * Diagnose the helpdesk-poll cron: when did it last fire, did it succeed,
 * and what did it say. Read-only. Also dumps recent audit events that
 * touch helpdesk sync, so we can see if any tick has run at all.
 */
import { db } from "@/lib/db";

async function main(): Promise<void> {
  process.stdout.write(`\nhelpdesk-poll cron diagnostic (now=${new Date().toISOString()})\n\n`);

  process.stdout.write("=== app_setting (helpdesk_poll_*) ===\n");
  const rows = await db.appSetting.findMany({
    where: { key: { startsWith: "helpdesk_poll_" } },
  });
  if (rows.length === 0) {
    process.stdout.write("(none)\n");
  } else {
    for (const r of rows) {
      process.stdout.write(`${r.key}\n  updatedAt=${r.updatedAt.toISOString()}\n  value=${JSON.stringify(r.value)}\n`);
    }
  }

  process.stdout.write("\n=== ALL app_setting keys (for context) ===\n");
  const allKeys = await db.appSetting.findMany({
    select: { key: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  for (const k of allKeys.slice(0, 25)) {
    const ageMin = Math.round((Date.now() - k.updatedAt.getTime()) / 60_000);
    process.stdout.write(`  ${k.key.padEnd(40)} updated=${k.updatedAt.toISOString()} (${ageMin}m ago)\n`);
  }

  process.stdout.write("\n=== HelpdeskTicket — most recent 5 by lastBuyerMessageAt ===\n");
  const recentTickets = await db.helpdeskTicket.findMany({
    select: {
      id: true,
      buyerName: true,
      lastBuyerMessageAt: true,
      createdAt: true,
      integrationId: true,
    },
    orderBy: { lastBuyerMessageAt: "desc" },
    take: 5,
  });
  const integrations = await db.integration.findMany({
    where: { id: { in: recentTickets.map((t) => t.integrationId) } },
    select: { id: true, platform: true, label: true },
  });
  const integById = new Map(integrations.map((i) => [i.id, i] as const));
  for (const t of recentTickets) {
    const i = integById.get(t.integrationId);
    const lastMsgAge = t.lastBuyerMessageAt
      ? Math.round((Date.now() - t.lastBuyerMessageAt.getTime()) / 60_000)
      : null;
    process.stdout.write(
      `  ${(i?.platform ?? "?").padEnd(9)} ${t.buyerName ?? "?"} ` +
        `lastBuyerMessage=${t.lastBuyerMessageAt?.toISOString() ?? "—"} ` +
        `(${lastMsgAge !== null ? lastMsgAge + "m ago" : "never"})\n`,
    );
  }

  process.stdout.write("\n=== HelpdeskSyncCheckpoint (raw) ===\n");
  const cps = await db.helpdeskSyncCheckpoint.findMany();
  const cpIntegrations = await db.integration.findMany({
    where: { id: { in: cps.map((c) => c.integrationId) } },
    select: { id: true, platform: true, label: true },
  });
  const cpIntById = new Map(cpIntegrations.map((i) => [i.id, i] as const));
  for (const cp of cps) {
    const integ = cpIntById.get(cp.integrationId);
    const updAge = Math.round((Date.now() - cp.updatedAt.getTime()) / 60_000);
    process.stdout.write(
      `  ${(integ?.platform ?? "?").padEnd(9)} ${cp.folder.padEnd(13)} ` +
        `done=${cp.backfillDone} cursor=${cp.backfillCursor?.toISOString() ?? "—"} ` +
        `updated=${cp.updatedAt.toISOString()} (${updAge}m ago)\n`,
    );
  }
}

main()
  .catch((e) => {
    process.stderr.write(`diag failed: ${String(e)}\n`);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
