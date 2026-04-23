import { PrismaClient, HelpdeskTicketStatus, HelpdeskTicketType } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const todoTickets = await db.helpdeskTicket.count({
    where: {
      status: { in: [HelpdeskTicketStatus.NEW, HelpdeskTicketStatus.TO_DO] },
      isArchived: false,
      isSpam: false,
      type: { not: HelpdeskTicketType.SYSTEM },
      NOT: { tags: { some: { tag: { name: "Buyer Request Cancellation" } } } },
    },
  });

  const todoReadOnEbay = await db.helpdeskTicket.count({
    where: {
      status: { in: [HelpdeskTicketStatus.NEW, HelpdeskTicketStatus.TO_DO] },
      isArchived: false,
      isSpam: false,
      type: { not: HelpdeskTicketType.SYSTEM },
      NOT: { tags: { some: { tag: { name: "Buyer Request Cancellation" } } } },
      unreadCount: 0,
    },
  });

  const todoUnread = await db.helpdeskTicket.count({
    where: {
      status: { in: [HelpdeskTicketStatus.NEW, HelpdeskTicketStatus.TO_DO] },
      isArchived: false,
      isSpam: false,
      type: { not: HelpdeskTicketType.SYSTEM },
      NOT: { tags: { some: { tag: { name: "Buyer Request Cancellation" } } } },
      unreadCount: { gt: 0 },
    },
  });

  // Check read sync setting
  const readSyncSetting = await db.appSetting.findUnique({
    where: { key: "helpdesk_read_sync" },
  });
  const safeModeSetting = await db.appSetting.findUnique({
    where: { key: "helpdesk_safe_mode" },
  });
  const writeLock = await db.appSetting.findUnique({
    where: { key: "global_write_lock" },
  });

  console.log("=== To Do Folder State ===");
  console.log(`  Total To Do tickets: ${todoTickets}`);
  console.log(`  To Do + read on eBay (unreadCount=0): ${todoReadOnEbay}`);
  console.log(`  To Do + still unread (unreadCount>0): ${todoUnread}`);
  console.log();
  console.log("=== Settings ===");
  console.log(`  helpdesk_read_sync: ${readSyncSetting?.value ?? "(not set)"}`);
  console.log(`  helpdesk_safe_mode: ${safeModeSetting?.value ?? "(not set)"}`);
  console.log(`  global_write_lock: ${writeLock?.value ?? "(not set)"}`);
  console.log();

  if (todoReadOnEbay > 0) {
    console.log(`>>> ${todoReadOnEbay} tickets are in To Do but already READ on eBay.`);
    console.log("    These could be resolved to align the count.");
  }
  if (todoUnread > 0) {
    console.log(`>>> ${todoUnread} tickets are in To Do and still UNREAD.`);
    console.log("    These are genuine unread buyer messages needing attention.");
  }

  await db.$disconnect();
}

main().catch(console.error);
