/**
 * Full eBay read-state reconciliation.
 *
 * Fetches ALL message headers from eBay (in 7-day windows across 60 days)
 * for every Help Desk integration, cross-references with local DB, and:
 *   1. Sets unreadCount=0 on tickets where ALL eBay messages are read
 *   2. Flips status from TO_DO/NEW to RESOLVED for those tickets
 *
 * This is the one-shot fix for the "To Do 1,100 vs eBay 14" discrepancy.
 *
 * Usage:
 *   npx dotenv-cli -e .env.production -- npx tsx scripts/full-read-reconcile.ts
 *   npx dotenv-cli -e .env.production -- npx tsx scripts/full-read-reconcile.ts --apply
 */
import {
  PrismaClient,
  HelpdeskTicketStatus,
  HelpdeskTicketType,
  HelpdeskMessageDirection,
  Platform,
} from "@prisma/client";
import {
  buildEbayConfig,
  getMyMessagesHeaders,
} from "../src/lib/services/helpdesk-ebay";

const db = new PrismaClient();
const apply = process.argv.includes("--apply");

const WINDOW_DAYS = 7;
const TOTAL_DAYS = 70;

async function main() {
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}\n`);

  const integrations = await db.integration.findMany({
    where: {
      platform: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] },
      enabled: true,
    },
  });

  console.log(`Found ${integrations.length} active eBay integrations\n`);

  const allReadOnEbay = new Set<string>();
  const allUnreadOnEbay = new Set<string>();

  for (const integration of integrations) {
    console.log(`\n--- ${integration.label} (${integration.platform}) ---`);
    const config = buildEbayConfig(integration);

    const now = new Date();
    const startDate = new Date(now.getTime() - TOTAL_DAYS * 24 * 60 * 60 * 1000);

    let windowStart = new Date(startDate);
    let totalHeaders = 0;
    let readCount = 0;
    let unreadCount = 0;

    while (windowStart < now) {
      const windowEnd = new Date(
        Math.min(windowStart.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000, now.getTime()),
      );

      try {
        const headers = await getMyMessagesHeaders(integration.id, config, {
          startTime: windowStart,
          endTime: windowEnd,
          folderID: 0,
        });

        for (const h of headers) {
          if (!h.messageID) continue;
          totalHeaders++;
          if (h.read === true) {
            allReadOnEbay.add(h.messageID);
            readCount++;
          } else if (h.read === false) {
            allUnreadOnEbay.add(h.messageID);
            unreadCount++;
          }
        }

        // Also fetch sent folder
        const sentHeaders = await getMyMessagesHeaders(integration.id, config, {
          startTime: windowStart,
          endTime: windowEnd,
          folderID: 1,
        });
        for (const h of sentHeaders) {
          if (!h.messageID) continue;
          totalHeaders++;
          if (h.read === true) {
            allReadOnEbay.add(h.messageID);
            readCount++;
          }
        }
      } catch (err) {
        console.error(
          `  Error fetching ${windowStart.toISOString()} - ${windowEnd.toISOString()}:`,
          err instanceof Error ? err.message : err,
        );
      }

      windowStart = windowEnd;
    }

    console.log(`  Total headers fetched: ${totalHeaders}`);
    console.log(`  Read on eBay: ${readCount}`);
    console.log(`  Unread on eBay: ${unreadCount}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total read message IDs on eBay: ${allReadOnEbay.size}`);
  console.log(`Total unread message IDs on eBay: ${allUnreadOnEbay.size}`);

  // Find local messages that match eBay read messages and are in TO_DO tickets
  const readMessageIds = [...allReadOnEbay];
  const unreadMessageIds = [...allUnreadOnEbay];

  // Process in batches to avoid Prisma query limits
  const BATCH = 500;
  const ticketsToResolve = new Set<string>();
  const ticketsToKeepToDo = new Set<string>();

  // Find tickets that have unread messages on eBay -- these should stay TO_DO
  for (let i = 0; i < unreadMessageIds.length; i += BATCH) {
    const chunk = unreadMessageIds.slice(i, i + BATCH);
    const msgs = await db.helpdeskMessage.findMany({
      where: {
        ebayMessageId: { in: chunk },
        direction: HelpdeskMessageDirection.INBOUND,
        ticket: {
          type: { not: HelpdeskTicketType.SYSTEM },
        },
      },
      select: { ticketId: true },
    });
    for (const m of msgs) ticketsToKeepToDo.add(m.ticketId);
  }

  // Find all TO_DO tickets with inbound messages that have eBay message IDs
  const todoTickets = await db.helpdeskTicket.findMany({
    where: {
      status: { in: [HelpdeskTicketStatus.NEW, HelpdeskTicketStatus.TO_DO] },
      isArchived: false,
      isSpam: false,
      type: { not: HelpdeskTicketType.SYSTEM },
    },
    select: { id: true },
  });

  console.log(`\nTO_DO tickets in DB: ${todoTickets.length}`);
  console.log(`Tickets with unread messages on eBay: ${ticketsToKeepToDo.size}`);

  // Any TO_DO ticket NOT in the unread set should be resolved
  for (const t of todoTickets) {
    if (!ticketsToKeepToDo.has(t.id)) {
      ticketsToResolve.add(t.id);
    }
  }

  console.log(`Tickets to resolve (read on eBay or no matching unread): ${ticketsToResolve.size}`);
  console.log(`Tickets to keep as TO_DO (genuinely unread): ${todoTickets.length - ticketsToResolve.size}`);

  if (apply && ticketsToResolve.size > 0) {
    const ids = [...ticketsToResolve];
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      const result = await db.helpdeskTicket.updateMany({
        where: { id: { in: chunk } },
        data: { status: HelpdeskTicketStatus.RESOLVED, unreadCount: 0 },
      });
      console.log(`  Resolved batch ${Math.floor(i / 1000) + 1}: ${result.count} tickets`);
    }
    console.log(`\nDone. Resolved ${ticketsToResolve.size} tickets.`);
  } else if (!apply) {
    console.log(`\nDry run complete. Run with --apply to execute.`);
  }

  // Final count
  const finalToDo = await db.helpdeskTicket.count({
    where: {
      status: { in: [HelpdeskTicketStatus.NEW, HelpdeskTicketStatus.TO_DO] },
      isArchived: false,
      isSpam: false,
      type: { not: HelpdeskTicketType.SYSTEM },
      NOT: { tags: { some: { tag: { name: "Buyer Request Cancellation" } } } },
    },
  });
  console.log(`\nFinal To Do count: ${finalToDo}`);

  await db.$disconnect();
}

main().catch(console.error);
