// One-off: inspect recent HelpdeskMessage rows for the ticket the user is
// staring at (order number 14-14511-37521) on the PROD ("little-fire") DB.
// Prints direction/source/externalId/authorUserId/fromName/bodyText preview
// so we can see whether post-deploy sends carry the new cm:/author fields
// or whether there's a stale row lingering with the old shape.

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "<unknown>";
  console.log(`[inspect] connected to ${host}`);
  if (!host.includes("little-fire")) {
    console.warn(
      `[inspect] WARNING: expected little-fire (prod). Set DATABASE_URL to the prod pooler URL before running.`,
    );
  }

  const ticket = await db.helpdeskTicket.findFirst({
    where: { ebayOrderNumber: "14-14511-37521" },
    select: { id: true, ebayConversationId: true, subject: true },
  });
  if (!ticket) {
    console.error("[inspect] no ticket found for 14-14511-37521");
    return;
  }
  console.log(`[inspect] ticket ${ticket.id} conv=${ticket.ebayConversationId}`);

  const messages = await db.helpdeskMessage.findMany({
    where: { ticketId: ticket.id },
    orderBy: { sentAt: "desc" },
    take: 20,
    select: {
      id: true,
      direction: true,
      source: true,
      externalId: true,
      ebayMessageId: true,
      authorUserId: true,
      fromName: true,
      bodyText: true,
      sentAt: true,
    },
  });

  for (const m of messages) {
    const bodyPreview = (m.bodyText ?? "").slice(0, 80).replace(/\s+/g, " ");
    console.log(
      [
        m.sentAt.toISOString(),
        m.direction.padEnd(8),
        m.source.padEnd(10),
        `ext=${m.externalId ?? "-"}`.padEnd(30),
        `author=${m.authorUserId ? "Y" : "N"}`,
        `fromName=${m.fromName ?? "-"}`.padEnd(25),
        `body="${bodyPreview}"`,
      ].join(" | "),
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
