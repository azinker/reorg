/**
 * Diagnostic: inspect current helpdesk state to verify the From-eBay fix.
 *
 * Usage: npx dotenv-cli -e .env.production -- npx tsx scripts/diagnose-helpdesk-state.ts
 */
import { db } from "../src/lib/db";

async function main() {
  const totalTickets = await db.helpdeskTicket.count();
  const systemTickets = await db.helpdeskTicket.count({
    where: { type: "SYSTEM" },
  });
  const queryTickets = await db.helpdeskTicket.count({
    where: { type: "QUERY" },
  });
  const toDoTickets = await db.helpdeskTicket.count({
    where: { status: "TO_DO", isArchived: false, isSpam: false },
  });
  const toDoUnread = await db.helpdeskTicket.count({
    where: {
      status: "TO_DO",
      isArchived: false,
      isSpam: false,
      unreadCount: { gt: 0 },
    },
  });
  const toDoAwaiting = await db.helpdeskTicket.count({
    where: {
      status: "TO_DO",
      isArchived: false,
      isSpam: false,
      unreadCount: 0,
    },
  });

  console.log("=== COUNTS ===");
  console.log(`total tickets: ${totalTickets}`);
  console.log(`SYSTEM: ${systemTickets}`);
  console.log(`QUERY: ${queryTickets}`);
  console.log(`To Do total: ${toDoTickets}`);
  console.log(`  Unread: ${toDoUnread}`);
  console.log(`  Awaiting Reply: ${toDoAwaiting}`);

  console.log("\n=== SAMPLE SYSTEM tickets (checking threadKey format) ===");
  const sysSamples = await db.helpdeskTicket.findMany({
    where: { type: "SYSTEM" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      threadKey: true,
      type: true,
      systemMessageType: true,
      ebayOrderNumber: true,
      buyerUserId: true,
      subject: true,
      _count: { select: { messages: true } },
    },
  });
  for (const t of sysSamples) {
    const prefix = t.threadKey.startsWith("sys:") ? "GOOD" : "BAD ";
    console.log(
      `  [${prefix}] tk="${t.threadKey}" order=${t.ebayOrderNumber} buyer=${t.buyerUserId} subj="${(t.subject ?? "").slice(0, 60)}" sysType=${t.systemMessageType} msgs=${t._count.messages}`
    );
  }

  console.log("\n=== Target ticket 17-14480-10344 ===");
  const targets = await db.helpdeskTicket.findMany({
    where: { ebayOrderNumber: "17-14480-10344" },
    select: {
      id: true,
      threadKey: true,
      type: true,
      systemMessageType: true,
      status: true,
      isArchived: true,
      unreadCount: true,
      buyerUserId: true,
      subject: true,
      createdAt: true,
      _count: { select: { messages: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  for (const t of targets) {
    console.log(
      `  id=${t.id} tk="${t.threadKey}" type=${t.type} sys=${t.systemMessageType} status=${t.status} unread=${t.unreadCount} buyer=${t.buyerUserId} msgs=${t._count.messages}`
    );
    console.log(`    subject: "${(t.subject ?? "").slice(0, 120)}"`);
  }

  if (targets.length > 0) {
    console.log("\n=== Messages on each 17-14480-10344 ticket ===");
    for (const t of targets) {
      const msgs = await db.helpdeskMessage.findMany({
        where: { ticketId: t.id },
        orderBy: { createdAt: "asc" },
        select: {
          direction: true,
          fromName: true,
          subject: true,
          bodyText: true,
          createdAt: true,
          externalId: true,
        },
      });
      console.log(`\n  --- ticket ${t.id} (tk=${t.threadKey}) ---`);
      for (const m of msgs) {
        const snippet = (m.bodyText ?? "").replace(/\s+/g, " ").slice(0, 100);
        console.log(
          `    ${m.direction.padEnd(8)} from="${m.fromName ?? "?"}" subj="${(m.subject ?? "").slice(0, 50)}" body="${snippet}"`
        );
      }
    }
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
