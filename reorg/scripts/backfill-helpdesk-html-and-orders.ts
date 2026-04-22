/**
 * One-shot backfill for the Help Desk schema cleanups landed alongside the
 * SafeHtml + ebayOrderNumber refactor.
 *
 * Run with: `npx tsx scripts/backfill-helpdesk-html-and-orders.ts`
 *
 * Two passes, both idempotent:
 *   1. Re-sniff every HelpdeskMessage where isHtml=false. If the body
 *      contains real (or entity-encoded) HTML markup, flip isHtml=true so
 *      SafeHtml renders it through the sanitiser instead of the plain-text
 *      branch.
 *   2. Walk every post-sales HelpdeskTicket missing ebayOrderNumber and try
 *      to populate it from message text or the AutoResponderSendLog.
 */

import { db } from "../src/lib/db";
import {
  backfillTicketOrderNumbers,
  looksLikeHtmlBody,
} from "../src/lib/services/helpdesk-ebay-sync";

async function main(): Promise<void> {
  console.log("[backfill] starting Help Desk HTML + order-number backfill");

  // ── Pass 1: re-flag HTML bodies ────────────────────────────────────────────
  const candidates = await db.helpdeskMessage.findMany({
    where: { isHtml: false },
    select: { id: true, bodyText: true },
  });
  console.log(`[backfill] inspecting ${candidates.length} messages for HTML markup`);
  let htmlFlagged = 0;
  for (const m of candidates) {
    if (!m.bodyText) continue;
    if (looksLikeHtmlBody(m.bodyText)) {
      await db.helpdeskMessage.update({
        where: { id: m.id },
        data: { isHtml: true },
      });
      htmlFlagged++;
    }
  }
  console.log(`[backfill] flagged ${htmlFlagged} messages as HTML`);

  // ── Pass 2: order numbers ─────────────────────────────────────────────────
  const orderResult = await backfillTicketOrderNumbers({
    withinDays: 365,
    maxTickets: 5_000,
  });
  console.log("[backfill] order-number pass complete", orderResult);

  console.log("[backfill] done");
}

main()
  .catch((err) => {
    console.error("[backfill] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
