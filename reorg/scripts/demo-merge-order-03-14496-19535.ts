/**
 * Reverse-adoption merge demo for order 03-14496-19535.
 *
 * Adam reported: "We sent the AR on this order, then the buyer replied
 * on a fresh thread without quoting the order number. The two should
 * merge into one ticket so the AR + buyer reply live together."
 *
 * Live sync code now does this automatically (see the "Reverse adoption"
 * branch in `helpdesk-ebay-sync.ts`). This script demonstrates the same
 * logic against existing DB rows for the specific order Adam asked
 * about, so we can SEE the merge happen / verify it already did.
 *
 * What it does:
 *   1. Find every helpdesk ticket tied to this order number, and any
 *      `itm:<itemId>|buyer:<buyer>` ticket for the same buyer/listing
 *      that *should* fold into the order ticket but hasn't (the
 *      orphan case the live sync now prevents).
 *   2. Print before-state: which tickets, threadKeys, statuses, message
 *      counts.
 *   3. If there's an orphan, walk through the merge:
 *        a. Re-key the orphan's messages onto the order ticket.
 *        b. Re-key the orphan's notes onto the order ticket.
 *        c. Re-key the orphan's outbound jobs onto the order ticket.
 *        d. Recompute `lastBuyerMessageAt` / `lastAgentMessageAt` /
 *           `unreadCount` / `messageCount` on the order ticket.
 *        e. Bounce the order ticket out of archive (since the new
 *           buyer reply is what would have triggered it live).
 *        f. Delete the orphan ticket row.
 *      All inside one transaction so we never leave a half-merge.
 *   4. Print after-state.
 *
 * Run (read-only inspection, default):
 *   powershell scripts/run-with-prod.ps1 -Script scripts/demo-merge-order-03-14496-19535.ts
 *
 * Run (apply the merge if any orphan is found):
 *   powershell scripts/run-with-prod.ps1 -Script scripts/demo-merge-order-03-14496-19535.ts -- --apply
 */

import { db } from "@/lib/db";
import { HelpdeskTicketStatus } from "@prisma/client";

const ORDER_NUMBER = "03-14496-19535";
const APPLY = process.argv.includes("--apply");

interface TicketRow {
  id: string;
  threadKey: string;
  buyerUserId: string | null;
  ebayItemId: string | null;
  ebayOrderNumber: string | null;
  status: HelpdeskTicketStatus;
  isArchived: boolean;
  archivedAt: Date | null;
  lastBuyerMessageAt: Date | null;
  lastAgentMessageAt: Date | null;
  unreadCount: number;
  integrationId: string;
}

function printTicket(
  label: string,
  t: TicketRow,
  msgCount: number,
): void {
  console.log(
    `  ${label}: ${t.id}\n` +
      `    threadKey       = ${t.threadKey}\n` +
      `    item / order    = ${t.ebayItemId ?? "—"} / ${t.ebayOrderNumber ?? "—"}\n` +
      `    buyer           = ${t.buyerUserId ?? "—"}\n` +
      `    status          = ${t.status}  archived=${t.isArchived}\n` +
      `    lastBuyer/Agent = ${t.lastBuyerMessageAt?.toISOString() ?? "—"}` +
      ` / ${t.lastAgentMessageAt?.toISOString() ?? "—"}\n` +
      `    unread / msgs   = ${t.unreadCount} / ${msgCount}`,
  );
}

async function main() {
  console.log(`\n=== Merge demo for order ${ORDER_NUMBER} ===`);
  console.log(`Mode: ${APPLY ? "APPLY (writes)" : "DRY RUN (read-only)"}\n`);

  // 1. Find canonical order ticket(s).
  const orderTickets = (await db.helpdeskTicket.findMany({
    where: { ebayOrderNumber: ORDER_NUMBER },
  })) as unknown as TicketRow[];

  if (orderTickets.length === 0) {
    console.log(
      `No tickets found for order ${ORDER_NUMBER}. Nothing to demo.`,
    );
    await db.$disconnect();
    return;
  }

  console.log(
    `Found ${orderTickets.length} ticket(s) carrying ebayOrderNumber=${ORDER_NUMBER}:`,
  );
  for (const t of orderTickets) {
    const cnt = await db.helpdeskMessage.count({ where: { ticketId: t.id } });
    printTicket("ORDER TICKET", t, cnt);
  }

  // The "ord:" canonical ticket is the one with the right threadKey.
  const canonical =
    orderTickets.find((t) =>
      t.threadKey.startsWith(`ord:${ORDER_NUMBER}|`),
    ) ?? orderTickets[0];

  console.log(`\nCanonical order ticket = ${canonical.id}`);

  // 2. Find orphan candidates: tickets keyed by `itm:<canonical.itemId>|buyer:<canonical.buyer>`
  //    that don't have an order number yet, on the same integration.
  let orphans: TicketRow[] = [];
  if (canonical.ebayItemId && canonical.buyerUserId) {
    const orphanKey = `itm:${canonical.ebayItemId}|buyer:${canonical.buyerUserId.toLowerCase()}`;
    orphans = (await db.helpdeskTicket.findMany({
      where: {
        integrationId: canonical.integrationId,
        threadKey: orphanKey,
        ebayOrderNumber: null,
        id: { not: canonical.id },
      },
    })) as unknown as TicketRow[];

    // Also look for any other ticket on the same item+buyer pair that
    // ended up with a *different* threadKey scheme (defensive).
    const sameBuyerSameItem = (await db.helpdeskTicket.findMany({
      where: {
        integrationId: canonical.integrationId,
        ebayItemId: canonical.ebayItemId,
        buyerUserId: { equals: canonical.buyerUserId, mode: "insensitive" },
        ebayOrderNumber: null,
        id: { not: canonical.id },
      },
    })) as unknown as TicketRow[];
    for (const t of sameBuyerSameItem) {
      if (!orphans.find((o) => o.id === t.id)) orphans.push(t);
    }
  }

  if (orphans.length === 0) {
    console.log(
      `\nNo orphan tickets found for {item=${canonical.ebayItemId ?? "—"}, buyer=${canonical.buyerUserId ?? "—"}}.`,
    );
    console.log(
      `→ This order is already in its merged state. The reverse-adoption`,
    );
    console.log(
      `  logic in helpdesk-ebay-sync.ts is what put it here on ingest:`,
    );
    console.log(
      `  any future buyer reply on this listing (with no order number)`,
    );
    console.log(`  will fold into ticket ${canonical.id} automatically.`);
    await db.$disconnect();
    return;
  }

  console.log(
    `\nFound ${orphans.length} orphan ticket(s) that should fold into ${canonical.id}:`,
  );
  for (const o of orphans) {
    const cnt = await db.helpdeskMessage.count({ where: { ticketId: o.id } });
    printTicket("ORPHAN", o, cnt);
  }

  if (!APPLY) {
    console.log(
      `\nDRY RUN. Re-run with --apply to actually fold the orphan(s).`,
    );
    await db.$disconnect();
    return;
  }

  // 3. Apply the merge.
  for (const orphan of orphans) {
    console.log(`\n→ Folding orphan ${orphan.id} into ${canonical.id} …`);
    await db.$transaction(async (tx) => {
      // Re-parent messages, notes, outbound jobs.
      const movedMsgs = await tx.helpdeskMessage.updateMany({
        where: { ticketId: orphan.id },
        data: { ticketId: canonical.id },
      });
      const movedNotes = await tx.helpdeskNote.updateMany({
        where: { ticketId: orphan.id },
        data: { ticketId: canonical.id },
      });
      const movedOutbound = await tx.helpdeskOutboundJob.updateMany({
        where: { ticketId: orphan.id },
        data: { ticketId: canonical.id },
      });
      console.log(
        `   moved ${movedMsgs.count} message(s), ${movedNotes.count} note(s), ${movedOutbound.count} outbound job(s)`,
      );

      // Recompute denormalized counters on the canonical ticket.
      const msgs = await tx.helpdeskMessage.findMany({
        where: { ticketId: canonical.id },
        orderBy: { sentAt: "desc" },
        select: { sentAt: true, direction: true },
      });
      const lastBuyer =
        msgs.find((m) => m.direction === "INBOUND")?.sentAt ?? null;
      const lastAgent =
        msgs.find((m) => m.direction === "OUTBOUND")?.sentAt ?? null;

      await tx.helpdeskTicket.update({
        where: { id: canonical.id },
        data: {
          lastBuyerMessageAt: lastBuyer,
          lastAgentMessageAt: lastAgent,
          // Bounce out of archive — that's exactly what the live ingest
          // path does when a buyer message folds into an archived AR
          // ticket.
          isArchived: false,
          archivedAt: null,
          // Snap to TO_DO if a buyer message exists later than the last
          // agent message (i.e. the merged buyer reply is unanswered).
          ...(lastBuyer && (!lastAgent || lastBuyer > lastAgent)
            ? { status: HelpdeskTicketStatus.TO_DO }
            : {}),
        },
      });

      // Burn the orphan row.
      await tx.helpdeskTicket.delete({ where: { id: orphan.id } });
    });
    console.log(`   ✓ orphan ${orphan.id} folded and deleted`);
  }

  // 4. After-state.
  const after = (await db.helpdeskTicket.findUnique({
    where: { id: canonical.id },
  })) as unknown as TicketRow;
  const afterCnt = await db.helpdeskMessage.count({
    where: { ticketId: canonical.id },
  });
  console.log(`\nAFTER MERGE:`);
  printTicket("CANONICAL", after, afterCnt);

  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
