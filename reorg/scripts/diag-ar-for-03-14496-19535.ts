/**
 * Why is the Apr 11 auto-responder for order 03-14496-19535 not on the
 * canonical ticket? Look in three places:
 *   1. Any outbound messages anywhere referencing this order / item / buyer.
 *   2. Any tickets (any status, including archived/deleted) for this order
 *      / item / buyer.
 *   3. Any HelpdeskOutboundJob (queued/sent) for this order.
 *   4. AutoResponderRun rows for this order if the table exists.
 */
import { db } from "@/lib/db";

const ORDER = "03-14496-19535";
const ITEM = "205533001023";
const BUYER = "mariamuriel2002787";

async function main() {
  console.log(`\n=== AR diag for order ${ORDER} ===\n`);

  // 1. All tickets for this buyer (any state).
  const tickets = await db.helpdeskTicket.findMany({
    where: {
      OR: [
        { ebayOrderNumber: ORDER },
        { buyerUserId: { equals: BUYER, mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      threadKey: true,
      buyerUserId: true,
      ebayItemId: true,
      ebayOrderNumber: true,
      status: true,
      isArchived: true,
      createdAt: true,
      lastBuyerMessageAt: true,
      lastAgentMessageAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  console.log(`Tickets touching this order/buyer: ${tickets.length}`);
  for (const t of tickets) {
    console.log(
      `  ${t.id} key=${t.threadKey} buyer=${t.buyerUserId} item=${t.ebayItemId} order=${t.ebayOrderNumber} status=${t.status} archived=${t.isArchived} created=${t.createdAt.toISOString()}`,
    );
  }

  // 2. All outbound messages anywhere matching this buyer or item (across any
  //    ticket — even unrelated ones, in case the AR landed somewhere weird).
  const outboundMsgs = await db.helpdeskMessage.findMany({
    where: {
      direction: "OUTBOUND",
      OR: [
        { ticket: { ebayOrderNumber: ORDER } },
        { ticket: { ebayItemId: ITEM, buyerUserId: { equals: BUYER, mode: "insensitive" } } },
      ],
    },
    select: {
      id: true,
      ticketId: true,
      sentAt: true,
      source: true,
      subject: true,
      bodyText: true,
    },
    orderBy: { sentAt: "asc" },
  });
  console.log(
    `\nOutbound messages tied to this order/item+buyer: ${outboundMsgs.length}`,
  );
  for (const m of outboundMsgs) {
    console.log(
      `  ${m.id} ticket=${m.ticketId} sent=${m.sentAt.toISOString()} source=${m.source} subject=${(m.subject ?? "").slice(0, 60)}`,
    );
    console.log(`    body: ${(m.bodyText ?? "").slice(0, 120).replace(/\s+/g, " ")}`);
  }

  // 3. Outbound jobs (queue rows) touching this order/buyer.
  const jobs = await db.helpdeskOutboundJob.findMany({
    where: {
      OR: [
        { ticket: { ebayOrderNumber: ORDER } },
        { ticket: { ebayItemId: ITEM, buyerUserId: { equals: BUYER, mode: "insensitive" } } },
      ],
    },
    select: {
      id: true,
      ticketId: true,
      status: true,
      composerMode: true,
      createdAt: true,
      sentAt: true,
      bodyText: true,
    },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nOutbound jobs touching this order/item+buyer: ${jobs.length}`);
  for (const j of jobs) {
    console.log(
      `  ${j.id} ticket=${j.ticketId} status=${j.status} mode=${j.composerMode} created=${j.createdAt.toISOString()} sent=${j.sentAt?.toISOString() ?? "—"}`,
    );
    console.log(`    body: ${(j.bodyText ?? "").slice(0, 120).replace(/\s+/g, " ")}`);
  }

  // 4. Look for the AR send recorded by the AutoResponder service. It writes
  //    AutoResponderRun rows.
  try {
    // @ts-expect-error optional table presence
    const runs = await db.autoResponderRun.findMany({
      where: { ebayOrderNumber: ORDER },
      orderBy: { createdAt: "asc" },
    });
    console.log(`\nAutoResponderRun rows: ${runs.length}`);
    for (const r of runs as unknown as Array<{
      id: string;
      ebayOrderNumber: string | null;
      buyerUserId: string | null;
      status: string;
      sentAt: Date | null;
      createdAt: Date;
    }>) {
      console.log(
        `  ${r.id} order=${r.ebayOrderNumber} buyer=${r.buyerUserId} status=${r.status} sent=${r.sentAt?.toISOString() ?? "—"} created=${r.createdAt.toISOString()}`,
      );
    }
  } catch (e) {
    console.log(`AutoResponderRun lookup failed: ${(e as Error).message}`);
  }

  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
