/**
 * Help Desk ticket purge service.
 *
 * Deletes tickets whose linked order is older than a configurable
 * threshold (default 70 days). Uses the order date from
 * MarketplaceSaleOrder when available, otherwise falls back to the
 * ticket's own createdAt.
 *
 * HelpdeskTicket has cascade deletes for messages, notes, tags,
 * assignments, presence, drafts, and outbound jobs — so deleting the
 * ticket cleans up all related data automatically.
 */

import { db } from "@/lib/db";

const PURGE_DAYS = parseInt(process.env.HELPDESK_PURGE_DAYS ?? "70", 10);
const BATCH_SIZE = 200;

interface PurgeResult {
  ticketsDeleted: number;
  scanned: number;
  cutoffDate: Date;
}

/**
 * Purge old helpdesk tickets whose orders are older than PURGE_DAYS.
 *
 * Strategy:
 *   1. Find tickets with an ebayOrderNumber
 *   2. Look up the order date from MarketplaceSaleOrder
 *   3. If order date > PURGE_DAYS ago → delete the ticket
 *   4. For tickets without an order number, use ticket.createdAt
 */
export async function purgeOldTickets(
  dryRun = true,
): Promise<PurgeResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - PURGE_DAYS);

  const result: PurgeResult = {
    ticketsDeleted: 0,
    scanned: 0,
    cutoffDate: cutoff,
  };

  console.log(
    `[purge] mode=${dryRun ? "DRY-RUN" : "EXECUTE"} cutoff=${cutoff.toISOString()} (${PURGE_DAYS} days)`,
  );

  // Build a map of order number → order date for quick lookup
  const orders = await db.marketplaceSaleOrder.findMany({
    where: { orderDate: { lt: cutoff } },
    select: { externalOrderId: true, orderDate: true },
  });
  const oldOrderIds = new Set(orders.map((o) => o.externalOrderId));
  console.log(
    `[purge] found ${oldOrderIds.size} orders older than ${PURGE_DAYS} days`,
  );

  // Page through tickets
  let cursor: string | undefined;

  while (true) {
    const batch = await db.helpdeskTicket.findMany({
      take: BATCH_SIZE,
      ...(cursor
        ? { skip: 1, cursor: { id: cursor } }
        : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        ebayOrderNumber: true,
        createdAt: true,
      },
    });

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;
    result.scanned += batch.length;

    const toDelete: string[] = [];

    for (const t of batch) {
      let shouldDelete = false;

      if (t.ebayOrderNumber && oldOrderIds.has(t.ebayOrderNumber)) {
        shouldDelete = true;
      } else if (t.createdAt < cutoff) {
        shouldDelete = true;
      }

      if (shouldDelete) {
        toDelete.push(t.id);
      }
    }

    if (toDelete.length > 0) {
      if (!dryRun) {
        await db.helpdeskTicket.deleteMany({
          where: { id: { in: toDelete } },
        });
      }
      result.ticketsDeleted += toDelete.length;
    }

    if (result.scanned % 5000 === 0) {
      console.log(`[purge] scanned=${result.scanned} deleted=${result.ticketsDeleted}`);
    }
  }

  console.log(
    `[purge] done. scanned=${result.scanned} deleted=${result.ticketsDeleted}`,
  );

  return result;
}
