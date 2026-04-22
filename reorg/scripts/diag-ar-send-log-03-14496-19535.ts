/**
 * Look at AutoResponderSendLog and AutoResponderJob for this specific order.
 * Did the AR system actually send a message for it?
 */
import { db } from "@/lib/db";

const ORDER = "03-14496-19535";

async function main() {
  console.log(`\n=== AR send log diag for ${ORDER} ===\n`);

  const logs = await db.autoResponderSendLog.findMany({
    where: { orderNumber: ORDER },
    orderBy: { createdAt: "asc" },
  });
  console.log(`AutoResponderSendLog rows: ${logs.length}`);
  for (const r of logs) {
    console.log(
      `  ${r.id} status=${r.status} channel=${r.channel} sent=${r.sentAt?.toISOString() ?? "—"} created=${r.createdAt.toISOString()}`,
    );
    console.log(
      `    buyer=${r.ebayBuyerUserId ?? "—"} item=${r.ebayItemId ?? "—"}`,
    );
    console.log(`    externalMessageId=${r.externalMessageId ?? "—"}`);
    console.log(`    reason=${r.reason ?? "—"}`);
  }

  const jobs = await db.autoResponderJob.findMany({
    where: { orderNumber: ORDER },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nAutoResponderJob rows: ${jobs.length}`);
  for (const j of jobs) {
    console.log(
      `  ${j.id} status=${j.status} channel=${j.channel} created=${j.createdAt.toISOString()} processAfter=${j.processAfter.toISOString()}`,
    );
  }

  // Look for any HelpdeskMessage anywhere with this order's AR copy.
  // The AR copy lands in the Sent folder which the helpdesk sync ingests
  // as OUTBOUND. Search by ebayMessageId == AR's logged ebayMessageId.
  const arEbayIds = logs
    .map((l) => l.externalMessageId)
    .filter((id): id is string => Boolean(id));
  if (arEbayIds.length > 0) {
    const helpdeskHits = await db.helpdeskMessage.findMany({
      where: { ebayMessageId: { in: arEbayIds } },
      select: {
        id: true,
        ticketId: true,
        sentAt: true,
        direction: true,
        source: true,
        ebayMessageId: true,
        ticket: {
          select: { threadKey: true, ebayOrderNumber: true, isArchived: true },
        },
      },
    });
    console.log(
      `\nHelpdeskMessage rows whose ebayMessageId matches the AR send: ${helpdeskHits.length}`,
    );
    for (const h of helpdeskHits) {
      console.log(
        `  ${h.id} ticket=${h.ticketId} key=${h.ticket.threadKey} order=${h.ticket.ebayOrderNumber} archived=${h.ticket.isArchived} dir=${h.direction} source=${h.source}`,
      );
    }
  }

  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
