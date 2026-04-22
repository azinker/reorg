/**
 * Retroactive sweep — apply the new "agent replied directly on eBay → mark
 * RESOLVED" rule to tickets that synced before the rule shipped.
 *
 * The live sync now calls `deriveStatusOnSyncedOutbound` whenever an
 * outbound message lands, but every ticket that was synced before that
 * change is still sitting in WAITING (or sometimes TO_DO) even though the
 * latest message is an agent reply typed directly on eBay.com. This script
 * walks all non-resolved, non-spam, non-archived tickets and:
 *
 *   1. Loads the most-recent message on the thread.
 *   2. If that message is OUTBOUND with source=EBAY_UI and there are no
 *      newer INBOUND messages, flips the ticket to RESOLVED and stamps
 *      `resolvedAt` to that message's `sentAt`.
 *
 * Idempotent — re-running does nothing once tickets are RESOLVED.
 *
 * Run with: `npx tsx scripts/backfill-resolve-ebay-ui-replies.ts`
 */

import {
  HelpdeskMessageDirection,
  HelpdeskMessageSource,
  HelpdeskTicketStatus,
} from "@prisma/client";
import { db } from "../src/lib/db";

async function main(): Promise<void> {
  console.log(
    "[backfill] resolving tickets where last reply was agent on eBay (EBAY_UI)",
  );

  // Only consider tickets that COULD flip — RESOLVED/SPAM/ARCHIVED are out
  // by definition. We deliberately scan TO_DO too: a few of those are
  // mis-routed eBay-UI replies that landed before the sync rule existed.
  const candidates = await db.helpdeskTicket.findMany({
    where: {
      status: { in: [HelpdeskTicketStatus.WAITING, HelpdeskTicketStatus.TO_DO] },
      isArchived: false,
      isSpam: false,
    },
    select: { id: true, status: true },
  });

  console.log(`[backfill] inspecting ${candidates.length} candidate tickets`);

  let flipped = 0;
  for (const t of candidates) {
    // Find the most recent EBAY_UI outbound message on this ticket. We
    // can't just look at "latest message" because eBay digest envelopes
    // create two outbound rows at the same sentAt — one envelope tagged
    // EBAY_UI (the source we care about) and one exploded sub tagged
    // EBAY. A naive `findFirst` orderBy sentAt is non-deterministic
    // between them. Instead: anchor on the EBAY_UI row directly, then
    // confirm no INBOUND message is newer.
    const ebayUiOut = await db.helpdeskMessage.findFirst({
      where: {
        ticketId: t.id,
        direction: HelpdeskMessageDirection.OUTBOUND,
        source: HelpdeskMessageSource.EBAY_UI,
      },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    });
    if (!ebayUiOut) continue;

    const newerInbound = await db.helpdeskMessage.findFirst({
      where: {
        ticketId: t.id,
        direction: HelpdeskMessageDirection.INBOUND,
        sentAt: { gt: ebayUiOut.sentAt },
      },
      select: { id: true },
    });
    if (newerInbound) continue;

    await db.helpdeskTicket.update({
      where: { id: t.id },
      data: {
        status: HelpdeskTicketStatus.RESOLVED,
        resolvedAt: ebayUiOut.sentAt,
        unreadCount: 0,
      },
    });
    flipped++;
  }

  console.log(`[backfill] flipped ${flipped} tickets to RESOLVED`);
}

main()
  .catch((err) => {
    console.error("[backfill] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
