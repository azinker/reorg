/**
 * One-time reconciliation: resolve TO_DO tickets that are already marked
 * "read" on eBay (unreadCount = 0). These are tickets the eBay read sync
 * already processed but whose status was never updated from TO_DO.
 *
 * Usage:
 *   npx dotenv-cli -e .env.production -- npx tsx scripts/resolve-read-tickets.ts
 *   npx dotenv-cli -e .env.production -- npx tsx scripts/resolve-read-tickets.ts --apply
 */
import { PrismaClient, HelpdeskTicketStatus, HelpdeskTicketType } from "@prisma/client";

const db = new PrismaClient();
const apply = process.argv.includes("--apply");

async function main() {
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}\n`);

  const where = {
    status: { in: [HelpdeskTicketStatus.NEW, HelpdeskTicketStatus.TO_DO] as HelpdeskTicketStatus[] },
    isArchived: false,
    isSpam: false,
    type: { not: HelpdeskTicketType.SYSTEM },
    unreadCount: 0,
    NOT: { tags: { some: { tag: { name: "Buyer Request Cancellation" } } } },
  };

  const count = await db.helpdeskTicket.count({ where });
  console.log(`Found ${count} TO_DO tickets with unreadCount=0 (read on eBay)`);

  if (count === 0) {
    console.log("Nothing to do.");
    await db.$disconnect();
    return;
  }

  if (apply) {
    const result = await db.helpdeskTicket.updateMany({
      where,
      data: { status: HelpdeskTicketStatus.RESOLVED },
    });
    console.log(`Resolved ${result.count} tickets.`);
  } else {
    console.log(`Would resolve ${count} tickets. Run with --apply to execute.`);
  }

  // Show remaining To Do count
  const remaining = await db.helpdeskTicket.count({
    where: {
      status: { in: [HelpdeskTicketStatus.NEW, HelpdeskTicketStatus.TO_DO] },
      isArchived: false,
      isSpam: false,
      type: { not: HelpdeskTicketType.SYSTEM },
      NOT: { tags: { some: { tag: { name: "Buyer Request Cancellation" } } } },
    },
  });
  console.log(`\nRemaining To Do: ${remaining}`);

  await db.$disconnect();
}

main().catch(console.error);
