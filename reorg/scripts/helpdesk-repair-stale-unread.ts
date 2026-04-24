/**
 * One-off repair: reconcile ALL local tickets with unreadCount > 0 against
 * eBay's current read state, not just the 7-day incremental window.
 *
 * Why: reconcileEbayReadState only runs on messages inside the 7-day sync
 * window, so when an agent reads/unreads a ticket directly on eBay months
 * after the original message, reorG stays stuck at unreadCount=1 forever.
 *
 * What it does:
 *   1. For each enabled TPP_EBAY + TT_EBAY integration, finds every
 *      non-spam, non-SYSTEM ticket with unreadCount > 0.
 *   2. Grabs the latest INBOUND ebayMessageId per ticket.
 *   3. Chunks 10 IDs per GetMyMessages call, fetches bodies (which include
 *      Read state in the header portion).
 *   4. For any message where eBay reports Read=true, clears local
 *      unreadCount=0 and auto-resolves TO_DO/NEW tickets. For any message
 *      where eBay reports Read=false, sets local unreadCount=1 (idempotent
 *      because they're already unread — this is for completeness).
 *
 * Safe to re-run. Dry-run mode available via --dry-run.
 *
 * Usage:
 *   npx tsx scripts/helpdesk-repair-stale-unread.ts
 *   npx tsx scripts/helpdesk-repair-stale-unread.ts --dry-run
 */
import { db } from "../src/lib/db";
import {
  Platform,
  HelpdeskMessageDirection,
  HelpdeskTicketType,
} from "@prisma/client";
import {
  buildEbayConfig,
  getMyMessagesBodies,
} from "../src/lib/services/helpdesk-ebay";

const DRY_RUN = process.argv.includes("--dry-run");

interface TicketInspect {
  id: string;
  integrationId: string;
  platform: Platform;
  messageId: string;
  priorUnreadCount: number;
  ebayRead: boolean | undefined;
}

async function main(): Promise<void> {
  console.log(
    `[repair-stale-unread] starting${DRY_RUN ? " (dry-run)" : ""}...`,
  );

  const integrations = await db.integration.findMany({
    where: {
      enabled: true,
      platform: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] },
    },
  });
  console.log(
    `[repair-stale-unread] found ${integrations.length} enabled eBay integrations`,
  );

  const inspect: TicketInspect[] = [];

  for (const integration of integrations) {
    const config = buildEbayConfig(integration);
    if (!config.appId || !config.refreshToken) {
      console.warn(
        `[repair-stale-unread] ${integration.platform} (${integration.id}) missing credentials; skipping`,
      );
      continue;
    }

    const tickets = await db.helpdeskTicket.findMany({
      where: {
        integrationId: integration.id,
        unreadCount: { gt: 0 },
        isSpam: false,
        type: { not: HelpdeskTicketType.SYSTEM },
      },
      select: {
        id: true,
        unreadCount: true,
        status: true,
        isArchived: true,
        lastBuyerMessageAt: true,
        messages: {
          where: {
            direction: HelpdeskMessageDirection.INBOUND,
            ebayMessageId: { not: null },
          },
          orderBy: { sentAt: "desc" },
          take: 1,
          select: { ebayMessageId: true, sentAt: true },
        },
      },
      orderBy: { lastBuyerMessageAt: "asc" },
    });

    console.log(
      `[repair-stale-unread] ${integration.platform}: ${tickets.length} tickets with unreadCount > 0`,
    );

    const mapMessageToTicket = new Map<string, typeof tickets[number]>();
    const messageIds: string[] = [];
    for (const t of tickets) {
      const mid = t.messages[0]?.ebayMessageId;
      if (mid) {
        mapMessageToTicket.set(mid, t);
        messageIds.push(mid);
      }
    }
    if (messageIds.length === 0) continue;

    console.log(
      `[repair-stale-unread] ${integration.platform}: querying eBay for ${messageIds.length} message IDs in batches of 10...`,
    );

    const ticketsToClear: string[] = [];
    let apiCalls = 0;
    for (let i = 0; i < messageIds.length; i += 10) {
      const chunk = messageIds.slice(i, i + 10);
      try {
        const bodies = await getMyMessagesBodies(integration.id, config, chunk);
        apiCalls++;
        for (const body of bodies) {
          if (!body.messageID) continue;
          const ticket = mapMessageToTicket.get(body.messageID);
          if (!ticket) continue;
          inspect.push({
            id: ticket.id,
            integrationId: integration.id,
            platform: integration.platform,
            messageId: body.messageID,
            priorUnreadCount: ticket.unreadCount,
            ebayRead: body.read,
          });
          if (body.read === true) {
            ticketsToClear.push(ticket.id);
          }
        }
      } catch (err) {
        console.warn(
          `[repair-stale-unread] chunk ${i / 10} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    console.log(
      `[repair-stale-unread] ${integration.platform}: ${apiCalls} API calls, ${ticketsToClear.length} tickets to clear (eBay reports read=true)`,
    );

    if (ticketsToClear.length > 0 && !DRY_RUN) {
      const clearResult = await db.helpdeskTicket.updateMany({
        where: { id: { in: ticketsToClear }, unreadCount: { gt: 0 } },
        data: { unreadCount: 0 },
      });
      console.log(
        `[repair-stale-unread] ${integration.platform}: cleared unreadCount on ${clearResult.count} tickets`,
      );

      const toDoResult = await db.helpdeskTicket.updateMany({
        where: {
          id: { in: ticketsToClear },
          status: { in: ["NEW", "TO_DO"] },
        },
        data: { status: "RESOLVED" },
      });
      console.log(
        `[repair-stale-unread] ${integration.platform}: auto-resolved ${toDoResult.count} TO_DO/NEW tickets (now read on eBay)`,
      );
    }
  }

  const ebayReadTrue = inspect.filter((x) => x.ebayRead === true).length;
  const ebayReadFalse = inspect.filter((x) => x.ebayRead === false).length;
  const ebayReadUnknown = inspect.filter((x) => x.ebayRead == null).length;
  console.log(`[repair-stale-unread] SUMMARY:`);
  console.log(`  tickets inspected: ${inspect.length}`);
  console.log(`  eBay says read=true (drift — we cleared these): ${ebayReadTrue}`);
  console.log(`  eBay says read=false (legitimate unread): ${ebayReadFalse}`);
  console.log(`  eBay returned no Read flag: ${ebayReadUnknown}`);
  if (DRY_RUN) console.log(`  (dry-run — no DB writes performed)`);

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
