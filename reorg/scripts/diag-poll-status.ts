import { db } from "@/lib/db";

async function main() {
  console.log("[diag-poll-status] checking helpdesk poll health\n");

  const keys = [
    "helpdesk_poll_last_tick_at",
    "helpdesk_poll_last_outcome",
    "helpdesk_poll_last_summary",
  ];
  const settings = await db.appSetting.findMany({ where: { key: { in: keys } } });
  const map = new Map(settings.map((s) => [s.key, s.value]));

  const lastTick = map.get("helpdesk_poll_last_tick_at") as string | undefined;
  const outcome = map.get("helpdesk_poll_last_outcome") as string | undefined;
  const summary = map.get("helpdesk_poll_last_summary") as
    | { durationMs?: number; summaries?: unknown; error?: string | null }
    | undefined;

  console.log("== Last poll ==");
  console.log("  tickedAt:  ", lastTick ?? "(never)");
  if (lastTick) {
    const ageSec = Math.round((Date.now() - new Date(lastTick).getTime()) / 1000);
    console.log("  age:       ", `${Math.floor(ageSec / 60)}m ${ageSec % 60}s ago`);
  }
  console.log("  outcome:   ", outcome ?? "(unknown)");
  console.log("  durationMs:", summary?.durationMs ?? "(n/a)");
  console.log("  error:     ", summary?.error ?? "(none)");
  if (summary?.summaries) {
    console.log("\n  per-integration summaries:");
    console.log(JSON.stringify(summary.summaries, null, 2));
  }

  // Show the difference between when eBay says the buyer sent the message
  // (sentAt) and when our system actually persisted the row (createdAt).
  // If createdAt is recent but recordHelpdeskPollStatus is stale, the cron
  // path is broken but something else (manual sync? backfill?) is writing
  // messages.
  const recentInbound = await db.helpdeskMessage.findMany({
    where: { direction: "INBOUND" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      sentAt: true,
      createdAt: true,
      source: true,
      ticket: { select: { channel: true, ebayOrderNumber: true, buyerUserId: true } },
    },
  });
  console.log("\n== 10 most recently PERSISTED INBOUND messages (orderBy createdAt desc) ==");
  for (const m of recentInbound) {
    const ageSec = Math.round((Date.now() - m.createdAt.getTime()) / 1000);
    const ageStr = `${Math.floor(ageSec / 60)}m`;
    console.log(
      `  saved ${m.createdAt.toISOString()} (${ageStr} ago)  sent ${m.sentAt.toISOString()}  ${m.ticket.channel}  order=${m.ticket.ebayOrderNumber ?? "-"}  buyer=${m.ticket.buyerUserId ?? "-"}  src=${m.source}`,
    );
  }

  // Same for OUTBOUND so we can detect whether sent-folder polling is alive
  const recentOutbound = await db.helpdeskMessage.findMany({
    where: { direction: "OUTBOUND" },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      sentAt: true,
      createdAt: true,
      source: true,
      ticket: { select: { channel: true, ebayOrderNumber: true } },
    },
  });
  console.log("\n== 5 most recently PERSISTED OUTBOUND messages ==");
  for (const m of recentOutbound) {
    const ageSec = Math.round((Date.now() - m.createdAt.getTime()) / 1000);
    console.log(
      `  saved ${m.createdAt.toISOString()} (${Math.floor(ageSec / 60)}m ago)  ${m.ticket.channel}  order=${m.ticket.ebayOrderNumber ?? "-"}  src=${m.source}`,
    );
  }

  // Active integrations we'd be polling
  const integrations = await db.integration.findMany({
    where: {
      platform: { in: ["TPP_EBAY", "TT_EBAY"] },
      enabled: true,
    },
    select: {
      id: true,
      platform: true,
      label: true,
      enabled: true,
      lastSyncAt: true,
    },
  });
  console.log("\n== Active integrations ==");
  for (const i of integrations) {
    console.log(
      `  ${i.platform}  ${i.label ?? i.id}  enabled=${i.enabled}  lastSync=${i.lastSyncAt?.toISOString() ?? "(never)"}`,
    );
  }

  // Outbound queue health — if the cron isn't running, queued replies
  // pile up in PENDING forever
  const outboundCounts = await db.helpdeskOutboundJob.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  console.log("\n== Outbound queue ==");
  for (const c of outboundCounts) {
    console.log(`  ${c.status}: ${c._count._all}`);
  }

  const oldestPending = await db.helpdeskOutboundJob.findFirst({
    where: { status: "PENDING" },
    orderBy: { scheduledAt: "asc" },
    select: { id: true, scheduledAt: true, lastError: true },
  });
  if (oldestPending) {
    const ageMin = Math.round(
      (Date.now() - oldestPending.scheduledAt.getTime()) / 60_000,
    );
    console.log(
      `  oldest PENDING: scheduled ${oldestPending.scheduledAt.toISOString()} (${ageMin}m overdue)  err=${oldestPending.lastError ?? "(none)"}`,
    );
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
