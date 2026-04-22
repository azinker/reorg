/**
 * Auto-resolve tickets where the last response is from US (not the buyer).
 *
 * The user's spec is explicit:
 *
 *   "...any current message that is in All tickets (to do, waiting) that
 *    has the last response is NOT from the buyer, which means its from us,
 *    to the resolved folder as its waiting for a response from the buyer
 *    and there is no more action needing to be done from our end, unless
 *    the buyer messages back on that ticket and in that case, it should
 *    bounce that message out of resolved and back into To Do as its
 *    waiting for a response from the agent now."
 *
 * The bounce-back side of that contract is already implemented:
 *   - `deriveStatusOnInbound` (status-routing.ts) returns TO_DO for any
 *     non-spam ticket regardless of its current status, so RESOLVED
 *     tickets re-open automatically when the buyer replies.
 *   - `helpdesk-ebay-sync.ts` clears `isArchived` on inbound too, so the
 *     same path works for archived tickets.
 *
 * This script just runs the FORWARD side once: find every ticket whose
 * latest matchable message is OUTBOUND and flip it to RESOLVED.
 *
 * Selection criteria
 * ──────────────────
 * - status is currently NEW, TO_DO, or WAITING (these are the "open"
 *   folders the user wants empty of "we replied last" tickets).
 * - NOT archived, NOT spam, NOT snoozed.
 * - The most recent message (by sentAt desc) is OUTBOUND.
 *   - This catches both human agent replies (source=EBAY/EBAY_UI with
 *     authorUserId) and auto-responder messages (source=AUTO_RESPONDER).
 *   - It deliberately does NOT exclude system OUTBOUND notifications
 *     (`authorUserId IS NULL`) — eBay shipping confirmations etc are
 *     "we sent something to the buyer" too, and the user wants a clean
 *     open inbox with NO such tickets.
 *
 * Safety
 * ──────
 * - `--apply` flag required to actually write.
 * - Per-ticket update wrapped in try/catch so a single bad row doesn't
 *   stop the run.
 * - Audit logged so we can see who/when/how-many.
 */
import { db } from "@/lib/db";
import { HelpdeskTicketStatus } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const PAGE_SIZE = 1000;

async function main() {
  const mode = APPLY ? "APPLY" : "DRY-RUN";
  console.log(`[auto-resolve-we-replied-last] starting (${mode})`);

  // Pull every open ticket — we have to look at the latest message per
  // ticket, which means we can't pre-filter in SQL without a window
  // function. Project just what we need.
  const openTickets = await db.helpdeskTicket.findMany({
    where: {
      status: {
        in: [
          HelpdeskTicketStatus.NEW,
          HelpdeskTicketStatus.TO_DO,
          HelpdeskTicketStatus.WAITING,
        ],
      },
      isArchived: false,
      isSpam: false,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lt: new Date() } }],
    },
    select: {
      id: true,
      status: true,
      buyerName: true,
      ebayOrderNumber: true,
    },
  });
  console.log(`  candidate open tickets: ${openTickets.length}`);

  let toResolve = 0;
  let alreadyBuyer = 0;
  let noMessages = 0;
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < openTickets.length; i += PAGE_SIZE) {
    const batch = openTickets.slice(i, i + PAGE_SIZE);
    const ticketIds = batch.map((t) => t.id);

    // For each ticket, find the most recent message. We do this in a
    // single query using a self-join trick: pull every message for these
    // tickets, then in JS keep only the latest per ticketId.
    //
    // Postgres can do this in pure SQL with DISTINCT ON, but Prisma's
    // query builder doesn't expose it cleanly, so the JS pass is the
    // simplest correct option. The total volume per batch is bounded
    // (≤1000 tickets × maybe 30 msgs each ≈ 30k rows) which is fine.
    const messages = await db.helpdeskMessage.findMany({
      where: { ticketId: { in: ticketIds } },
      orderBy: { sentAt: "desc" },
      select: {
        ticketId: true,
        direction: true,
        sentAt: true,
      },
    });

    const latestByTicket = new Map<
      string,
      { direction: "INBOUND" | "OUTBOUND"; sentAt: Date }
    >();
    for (const m of messages) {
      if (latestByTicket.has(m.ticketId)) continue; // first hit per ticket = latest
      latestByTicket.set(m.ticketId, {
        direction: m.direction,
        sentAt: m.sentAt,
      });
    }

    for (const t of batch) {
      const latest = latestByTicket.get(t.id);
      if (!latest) {
        noMessages++;
        continue;
      }
      if (latest.direction === "INBOUND") {
        alreadyBuyer++;
        continue;
      }

      // OUTBOUND last → we replied last → should be RESOLVED.
      toResolve++;
      if (!APPLY) continue;

      try {
        await db.helpdeskTicket.update({
          where: { id: t.id },
          data: {
            status: HelpdeskTicketStatus.RESOLVED,
            resolvedAt: latest.sentAt,
          },
        });
        updated++;
      } catch (err) {
        failed++;
        console.error(`  failed to resolve ${t.id}:`, err);
      }
    }

    if ((i + PAGE_SIZE) % 5000 === 0 || i + PAGE_SIZE >= openTickets.length) {
      console.log(
        `  scanned ${Math.min(i + PAGE_SIZE, openTickets.length)}/${openTickets.length} (would resolve ${toResolve} so far)`,
      );
    }
  }

  if (APPLY) {
    await db.auditLog.create({
      data: {
        action: "helpdesk_auto_resolve_we_replied_last",
        entityType: "helpdesk_ticket",
        entityId: new Date().toISOString(),
        details: {
          scanned: openTickets.length,
          resolved: updated,
          alreadyBuyer,
          noMessages,
          failed,
        },
      },
    });
  }

  console.log("\n[auto-resolve-we-replied-last] done");
  console.log(`  scanned open tickets:           ${openTickets.length}`);
  console.log(`  latest msg INBOUND (kept open): ${alreadyBuyer}`);
  console.log(`  no messages (skipped):          ${noMessages}`);
  console.log(`  candidates to resolve:          ${toResolve}`);
  console.log(`  successfully resolved:          ${updated}`);
  console.log(`  failed:                         ${failed}`);
  if (!APPLY) {
    console.log("\n  (dry-run — pass --apply to actually update)");
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
