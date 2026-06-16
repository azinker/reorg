/**
 * READ-ONLY inspection: feedback history data for an order.
 * Usage: npx tsx scripts/_inspect-feedback-history.ts --order=26-14643-94920
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const orderArg = process.argv.find((a) => a.startsWith("--order="));
const orderNumber = orderArg?.split("=")[1];
if (!orderNumber) {
  console.error("Missing --order=");
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL ?? "";
const host = dbUrl.match(/@([^/]+)\//)?.[1] ?? "(unknown)";
console.log(`DB host: ${host}`);
if (!host.includes("little-fire")) {
  console.error("Refusing to run: DATABASE_URL is not the prod little-fire host.");
  process.exit(1);
}

const db = new PrismaClient();

async function main() {
  const tickets = await db.helpdeskTicket.findMany({
    where: { ebayOrderNumber: orderNumber },
    select: {
      id: true,
      threadKey: true,
      type: true,
      systemMessageType: true,
      subject: true,
      buyerUserId: true,
      ebayItemId: true,
      integrationId: true,
      createdAt: true,
    },
  });
  console.log(`\nTickets for order ${orderNumber}: ${tickets.length}`);
  for (const t of tickets) {
    console.log(JSON.stringify(t, null, 2));
  }

  const buyer = tickets.find((t) => t.buyerUserId)?.buyerUserId ?? null;
  const itemIds = tickets.map((t) => t.ebayItemId).filter(Boolean);

  const fbByOrder = await db.helpdeskFeedback.findMany({
    where: { ebayOrderNumber: orderNumber },
  });
  console.log(`\nFeedback mirror rows with ebayOrderNumber=${orderNumber}: ${fbByOrder.length}`);

  const fbByTicket = await db.helpdeskFeedback.findMany({
    where: { ticketId: { in: tickets.map((t) => t.id) } },
  });
  console.log(`Feedback mirror rows linked by ticketId: ${fbByTicket.length}`);
  for (const f of fbByTicket) {
    console.log(JSON.stringify({ ...f, rawData: undefined }, null, 2));
  }

  if (buyer) {
    const fbByBuyer = await db.helpdeskFeedback.findMany({
      where: { buyerUserId: { equals: buyer, mode: "insensitive" } },
      orderBy: { leftAt: "desc" },
      take: 10,
    });
    console.log(`\nFeedback mirror rows for buyer ${buyer}: ${fbByBuyer.length}`);
    for (const f of fbByBuyer) {
      console.log(
        JSON.stringify(
          {
            id: f.id,
            externalId: f.externalId,
            kind: f.kind,
            comment: f.comment,
            ebayOrderNumber: f.ebayOrderNumber,
            ebayItemId: f.ebayItemId,
            ticketId: f.ticketId,
            leftAt: f.leftAt,
          },
          null,
          2,
        ),
      );
    }
  }
  console.log(`\nItem ids on tickets: ${itemIds.join(", ")}`);

  // The removal notification system ticket + its message body (first 1500 chars)
  const sysTickets = tickets.filter((t) => t.systemMessageType);
  for (const t of sysTickets) {
    const msgs = await db.helpdeskMessage.findMany({
      where: { ticketId: t.id, deletedAt: null },
      orderBy: { sentAt: "asc" },
      select: { id: true, subject: true, bodyText: true, sentAt: true },
    });
    for (const m of msgs) {
      console.log(`\n--- System msg on ${t.systemMessageType} (${m.sentAt?.toISOString()}) ---`);
      console.log(`Subject: ${m.subject}`);
      console.log((m.bodyText ?? "").slice(0, 2000));
    }
  }

  // Overall stats: how many feedback rows have null order numbers
  const total = await db.helpdeskFeedback.count();
  const nullOrder = await db.helpdeskFeedback.count({ where: { ebayOrderNumber: null } });
  const nullTicket = await db.helpdeskFeedback.count({ where: { ticketId: null } });
  console.log(`\nMirror stats: total=${total} nullOrderNumber=${nullOrder} nullTicketId=${nullTicket}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
