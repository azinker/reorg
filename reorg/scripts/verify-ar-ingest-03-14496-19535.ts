import { db } from "@/lib/db";

async function main() {
  const ticket = await db.helpdeskTicket.findFirst({
    where: { ebayOrderNumber: "03-14496-19535" },
    include: {
      messages: {
        orderBy: { sentAt: "asc" },
        select: {
          id: true,
          direction: true,
          source: true,
          externalId: true,
          ebayMessageId: true,
          fromName: true,
          subject: true,
          sentAt: true,
          bodyText: true,
        },
      },
    },
  });
  if (!ticket) {
    console.log("NO TICKET found for order");
    await db.$disconnect();
    return;
  }
  console.log(
    `Ticket ${ticket.id} status=${ticket.status} archived=${ticket.isArchived} threadKey=${ticket.threadKey} order=${ticket.ebayOrderNumber} buyer=${ticket.buyerUserId}`,
  );
  console.log(
    `lastBuyerMessageAt=${ticket.lastBuyerMessageAt?.toISOString() ?? "—"} lastAgentMessageAt=${ticket.lastAgentMessageAt?.toISOString() ?? "—"}`,
  );
  console.log(`Messages (${ticket.messages.length}):`);
  for (const m of ticket.messages) {
    console.log(
      `  ${m.sentAt.toISOString()} [${m.direction}/${m.source}] from=${m.fromName ?? "—"} ext=${m.externalId ?? "—"}`,
    );
    console.log(`    subject=${m.subject?.slice(0, 60) ?? "—"}`);
    console.log(`    body[0..80]=${m.bodyText.slice(0, 80).replace(/\s+/g, " ")}`);
  }
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
