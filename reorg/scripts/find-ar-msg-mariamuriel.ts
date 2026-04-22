/**
 * Find the AR helpdesk message for buyer mariamuriel2002787 around Apr 11.
 * The AR send log says item=204353756625, but no externalMessageId was
 * recorded so we have to search by buyer + body fragment.
 */
import { db } from "@/lib/db";

const BUYER = "mariamuriel2002787";

async function main() {
  // Find by buyer + body marker.
  const msgs = await db.helpdeskMessage.findMany({
    where: {
      direction: "OUTBOUND",
      ticket: { buyerUserId: { equals: BUYER, mode: "insensitive" } },
      bodyText: { contains: "Great News" },
    },
    select: {
      id: true,
      ticketId: true,
      sentAt: true,
      source: true,
      subject: true,
      ticket: {
        select: {
          threadKey: true,
          ebayItemId: true,
          ebayOrderNumber: true,
          buyerUserId: true,
          isArchived: true,
          status: true,
        },
      },
    },
    orderBy: { sentAt: "asc" },
  });
  console.log(
    `\nOutbound 'Great News' helpdesk messages for ${BUYER}: ${msgs.length}\n`,
  );
  for (const m of msgs) {
    console.log(
      `  ${m.id} ticket=${m.ticketId} sent=${m.sentAt.toISOString()} src=${m.source}`,
    );
    console.log(
      `    key=${m.ticket.threadKey} item=${m.ticket.ebayItemId} order=${m.ticket.ebayOrderNumber} archived=${m.ticket.isArchived} status=${m.ticket.status}`,
    );
  }

  // Show ALL tickets for this buyer.
  console.log(`\nAll tickets for buyer ${BUYER}:`);
  const tickets = await db.helpdeskTicket.findMany({
    where: { buyerUserId: { equals: BUYER, mode: "insensitive" } },
    select: {
      id: true,
      threadKey: true,
      ebayItemId: true,
      ebayOrderNumber: true,
      isArchived: true,
      status: true,
      createdAt: true,
      lastBuyerMessageAt: true,
      lastAgentMessageAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  for (const t of tickets) {
    const cnt = await db.helpdeskMessage.count({ where: { ticketId: t.id } });
    console.log(
      `  ${t.id} key=${t.threadKey} item=${t.ebayItemId} order=${t.ebayOrderNumber} status=${t.status} archived=${t.isArchived} msgs=${cnt}`,
    );
    console.log(
      `    created=${t.createdAt.toISOString()} lastBuyer=${t.lastBuyerMessageAt?.toISOString() ?? "—"} lastAgent=${t.lastAgentMessageAt?.toISOString() ?? "—"}`,
    );
  }

  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
