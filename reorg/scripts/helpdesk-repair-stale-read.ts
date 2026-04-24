/**
 * One-off repair (reverse direction): reconcile ALL local tickets with
 * unreadCount = 0 against eBay's current read state, not just the 7-day
 * incremental window.
 *
 * Why: reconcileEbayReadState only runs on messages inside the 7-day sync
 * window, and the sister script (helpdesk-repair-stale-unread) only probes
 * tickets that are already unread locally. If an agent marked a ticket
 * UNREAD on eBay months after the original message, reorG stays stuck at
 * unreadCount=0 forever — the message is "read" on reorG but the buyer
 * inbox still shows it unread, so it silently falls out of our unread
 * triage even though the agent wanted it back in the queue.
 *
 * This script is ALSO the fallback for tickets that were incorrectly
 * flipped read by the (now-patched) hover-prefetch bug. Any ticket where
 * reorG says read but eBay says unread gets restored to local unread.
 *
 * What it does:
 *   1. For each enabled TPP_EBAY + TT_EBAY integration, finds every
 *      non-spam, non-SYSTEM ticket with unreadCount = 0 and at least
 *      one INBOUND message carrying an ebayMessageId.
 *   2. Optionally filters to tickets whose latest INBOUND message is
 *      within --days N days (default: last 60 days, to stay under the
 *      eBay Trading API daily call quota). Pass --days 0 to probe all.
 *   3. Grabs the latest INBOUND ebayMessageId per ticket.
 *   4. Chunks 10 IDs per GetMyMessages call, fetches bodies (which
 *      include Read state in the header portion). Message-ID lookup is
 *      NOT bounded by eBay's 7-day header window.
 *   5. For any message where eBay reports Read=false, sets local
 *      unreadCount=1. Folder/status/archive state is NOT changed — this
 *      matches reconcileEbayReadState's rule that marking unread on eBay
 *      is a read-state signal, not a workflow-routing signal. The ticket
 *      stays in whatever folder it was in (Waiting, Archived, Resolved)
 *      but the unread badge re-appears.
 *
 * This is a PURE PULL: nothing is pushed to eBay, so it's safe to run
 * with eBay Read/Unread Sync either ON or OFF.
 *
 * Safe to re-run. Dry-run mode available via --dry-run.
 *
 * Usage:
 *   npx tsx scripts/helpdesk-repair-stale-read.ts
 *   npx tsx scripts/helpdesk-repair-stale-read.ts --dry-run
 *   npx tsx scripts/helpdesk-repair-stale-read.ts --days 90
 *   npx tsx scripts/helpdesk-repair-stale-read.ts --days 0   # all history
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

function parseFlag(name: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === `--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.split("=", 2)[1];
  return undefined;
}

const DRY_RUN = process.argv.includes("--dry-run");
const DAYS_RAW = parseFlag("days");
const DAYS = DAYS_RAW != null ? Number.parseInt(DAYS_RAW, 10) : 60;

interface TicketInspect {
  id: string;
  integrationId: string;
  platform: Platform;
  messageId: string;
  ebayRead: boolean | undefined;
}

async function main(): Promise<void> {
  const windowLabel =
    DAYS > 0 ? `last ${DAYS} days of inbound activity` : "ALL history";
  console.log(
    `[repair-stale-read] starting${DRY_RUN ? " (dry-run)" : ""}, window: ${windowLabel}`,
  );

  const integrations = await db.integration.findMany({
    where: {
      enabled: true,
      platform: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] },
    },
  });
  console.log(
    `[repair-stale-read] found ${integrations.length} enabled eBay integrations`,
  );

  const inspect: TicketInspect[] = [];

  for (const integration of integrations) {
    const config = buildEbayConfig(integration);
    if (!config.appId || !config.refreshToken) {
      console.warn(
        `[repair-stale-read] ${integration.platform} (${integration.id}) missing credentials; skipping`,
      );
      continue;
    }

    const ticketWhere = {
      integrationId: integration.id,
      unreadCount: 0,
      isSpam: false,
      type: { not: HelpdeskTicketType.SYSTEM },
      messages: {
        some: {
          direction: HelpdeskMessageDirection.INBOUND,
          ebayMessageId: { not: null },
          ...(DAYS > 0
            ? {
                sentAt: {
                  gte: new Date(Date.now() - DAYS * 86_400_000),
                },
              }
            : {}),
        },
      },
    } as const;

    const tickets = await db.helpdeskTicket.findMany({
      where: ticketWhere,
      select: {
        id: true,
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
      orderBy: { lastBuyerMessageAt: "desc" },
    });

    console.log(
      `[repair-stale-read] ${integration.platform}: ${tickets.length} locally-read tickets to verify against eBay`,
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
      `[repair-stale-read] ${integration.platform}: querying eBay for ${messageIds.length} message IDs in batches of 10...`,
    );

    const ticketsToMarkUnread: string[] = [];
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
            ebayRead: body.read,
          });
          if (body.read === false) {
            ticketsToMarkUnread.push(ticket.id);
          }
        }
      } catch (err) {
        console.warn(
          `[repair-stale-read] ${integration.platform}: chunk ${i / 10} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    console.log(
      `[repair-stale-read] ${integration.platform}: ${apiCalls} API calls, ${ticketsToMarkUnread.length} tickets to re-mark unread (eBay reports read=false)`,
    );

    if (ticketsToMarkUnread.length > 0 && !DRY_RUN) {
      // Read-state only — folder / status / archive are intentionally
      // left alone to match reconcileEbayReadState's rule that marking
      // unread on eBay is a read-state signal, not a routing signal.
      const markResult = await db.helpdeskTicket.updateMany({
        where: { id: { in: ticketsToMarkUnread }, unreadCount: 0 },
        data: { unreadCount: 1 },
      });
      console.log(
        `[repair-stale-read] ${integration.platform}: set unreadCount=1 on ${markResult.count} tickets`,
      );
    }
  }

  const ebayReadTrue = inspect.filter((x) => x.ebayRead === true).length;
  const ebayReadFalse = inspect.filter((x) => x.ebayRead === false).length;
  const ebayReadUnknown = inspect.filter((x) => x.ebayRead == null).length;
  console.log(`[repair-stale-read] SUMMARY:`);
  console.log(`  tickets inspected: ${inspect.length}`);
  console.log(`  eBay says read=true (no drift): ${ebayReadTrue}`);
  console.log(
    `  eBay says read=false (drift — we re-marked these unread): ${ebayReadFalse}`,
  );
  console.log(`  eBay returned no Read flag: ${ebayReadUnknown}`);
  if (DRY_RUN) console.log(`  (dry-run — no DB writes performed)`);

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
