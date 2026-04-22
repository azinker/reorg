/**
 * Final-state check after running the AR-filter sweep, the
 * resync-orders backfill, and the auto-resolve script.
 *
 * Reports:
 *   1. Open ticket counts by status (NEW/TO_DO/WAITING).
 *   2. How many open tickets still have OUTBOUND as their latest message
 *      (should be zero — auto-resolve should've moved them all to
 *      RESOLVED).
 *   3. Buyer name coverage — how many tickets have a real first/last
 *      name vs just a username.
 *   4. AR-filter coverage — how many open tickets still have the
 *      auto-responder body but were not archived.
 */
import { db } from "@/lib/db";
import { HelpdeskTicketStatus } from "@prisma/client";

async function main() {
  console.log("\n══════════════════════════════════════════════════");
  console.log("  HELPDESK INBOX FINAL STATE");
  console.log("══════════════════════════════════════════════════\n");

  // 1. Open ticket counts
  const openWhere = {
    isArchived: false,
    isSpam: false,
    OR: [{ snoozedUntil: null }, { snoozedUntil: { lt: new Date() } }],
  };
  const byStatus = await db.helpdeskTicket.groupBy({
    by: ["status"],
    where: openWhere,
    _count: { _all: true },
  });
  console.log("OPEN ticket counts by status:");
  for (const row of byStatus) {
    console.log(`   ${row.status.padEnd(10)} ${row._count._all}`);
  }
  console.log();

  // 2. Open tickets where the latest msg is OUTBOUND (we replied last)
  const openInOpenFolders = await db.helpdeskTicket.findMany({
    where: {
      ...openWhere,
      status: {
        in: [
          HelpdeskTicketStatus.NEW,
          HelpdeskTicketStatus.TO_DO,
          HelpdeskTicketStatus.WAITING,
        ],
      },
    },
    select: { id: true, status: true },
  });
  console.log(`Open in NEW/TO_DO/WAITING: ${openInOpenFolders.length}`);

  let weRepliedLast = 0;
  let buyerRepliedLast = 0;
  let noMessages = 0;
  if (openInOpenFolders.length > 0) {
    const ids = openInOpenFolders.map((t) => t.id);
    const messages = await db.helpdeskMessage.findMany({
      where: { ticketId: { in: ids } },
      orderBy: { sentAt: "desc" },
      select: { ticketId: true, direction: true },
    });
    const latest = new Map<string, "INBOUND" | "OUTBOUND">();
    for (const m of messages) {
      if (latest.has(m.ticketId)) continue;
      latest.set(m.ticketId, m.direction);
    }
    for (const t of openInOpenFolders) {
      const d = latest.get(t.id);
      if (!d) noMessages++;
      else if (d === "INBOUND") buyerRepliedLast++;
      else weRepliedLast++;
    }
  }
  console.log(`   buyer replied last (correct): ${buyerRepliedLast}`);
  console.log(`   we replied last (BAD):        ${weRepliedLast}`);
  console.log(`   no messages:                  ${noMessages}\n`);

  // 3. Buyer name coverage
  const totalOpen = openInOpenFolders.length;
  const tickets = await db.helpdeskTicket.findMany({
    where: {
      ...openWhere,
      status: {
        in: [
          HelpdeskTicketStatus.NEW,
          HelpdeskTicketStatus.TO_DO,
          HelpdeskTicketStatus.WAITING,
        ],
      },
    },
    select: { buyerName: true, buyerUserId: true },
  });
  let realName = 0;
  let usernameOnly = 0;
  let unknown = 0;
  for (const t of tickets) {
    const name = t.buyerName?.trim() ?? "";
    const userId = t.buyerUserId?.trim() ?? "";
    if (!name && !userId) unknown++;
    else if (name && /\s/.test(name) && name.toLowerCase() !== userId.toLowerCase())
      realName++;
    else usernameOnly++;
  }
  console.log(`Open tickets buyer-name coverage (n=${totalOpen}):`);
  console.log(`   real first/last name:  ${realName}`);
  console.log(`   only username:         ${usernameOnly}`);
  console.log(`   no buyer at all:       ${unknown}\n`);

  // 4. AR-filter check — open tickets whose latest message body matches
  //    the AR trigger phrase
  const ARphrase = "🚨🚨 Great News! Your item was shipped on time! 🚨🚨";
  const leakyAR = await db.helpdeskMessage.count({
    where: {
      bodyText: { contains: ARphrase },
      ticket: {
        ...openWhere,
        status: {
          in: [
            HelpdeskTicketStatus.NEW,
            HelpdeskTicketStatus.TO_DO,
            HelpdeskTicketStatus.WAITING,
          ],
        },
      },
    },
  });
  console.log(`AR-trigger msgs still in open folders: ${leakyAR}`);
  if (leakyAR > 0) {
    console.log(
      "   ↑ these tickets matched the AR filter but are still in an open folder — investigate!",
    );
  } else {
    console.log("   ✓ AR filter is clean.");
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
