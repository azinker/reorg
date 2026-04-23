/**
 * reconcile-ticket-statuses.ts
 *
 * One-time script to align Help Desk ticket statuses with reality:
 *
 *   1. Archive AR-only tickets (only auto-responder messages, no buyer reply)
 *   2. Mark RESOLVED tickets where the agent already sent the last reply
 *   3. Move FROM EBAY (SYSTEM) tickets out of To Do into the From eBay folder
 *
 * Usage:
 *   npx dotenv-cli -e .env.production -- npx tsx scripts/reconcile-ticket-statuses.ts
 *   npx dotenv-cli -e .env.production -- npx tsx scripts/reconcile-ticket-statuses.ts --apply
 *
 * Without --apply it runs in dry-run mode (read-only, logs what it would do).
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const apply = process.argv.includes("--apply");

async function main() {
  console.log(`\n=== Reconcile Ticket Statuses (${apply ? "APPLY" : "DRY RUN"}) ===\n`);

  // ── 1. Archive AR-only tickets ──────────────────────────────────────────────
  // Tickets with zero INBOUND messages and at least one AUTO_RESPONDER message
  // that are not already archived.
  const allTickets = await db.helpdeskTicket.findMany({
    where: {
      isArchived: false,
    },
    select: {
      id: true,
      status: true,
      _count: {
        select: {
          messages: true,
        },
      },
    },
  });

  console.log(`Total non-archived tickets: ${allTickets.length}`);

  let arOnlyCount = 0;
  const arOnlyIds: string[] = [];

  for (const ticket of allTickets) {
    const [inboundCount, arCount] = await Promise.all([
      db.helpdeskMessage.count({
        where: {
          ticketId: ticket.id,
          direction: "INBOUND",
          deletedAt: null,
        },
      }),
      db.helpdeskMessage.count({
        where: {
          ticketId: ticket.id,
          source: "AUTO_RESPONDER",
          deletedAt: null,
        },
      }),
    ]);

    if (inboundCount === 0 && arCount > 0) {
      arOnlyIds.push(ticket.id);
      arOnlyCount++;
    }
  }

  console.log(`AR-only tickets to archive: ${arOnlyCount}`);

  if (apply && arOnlyIds.length > 0) {
    const result = await db.helpdeskTicket.updateMany({
      where: { id: { in: arOnlyIds } },
      data: { isArchived: true, status: "RESOLVED" },
    });
    console.log(`  → Archived ${result.count} AR-only tickets`);
  }

  // ── 2. Resolve tickets where agent sent the last message ───────────────────
  // If the most recent non-AR outbound message is newer than the most recent
  // inbound message, the agent already replied → mark RESOLVED.
  const todoTickets = await db.helpdeskTicket.findMany({
    where: {
      status: { in: ["TO_DO", "NEW"] },
      isArchived: false,
      id: { notIn: arOnlyIds },
    },
    select: { id: true },
  });

  console.log(`\nTO_DO/NEW tickets (non-AR) to check: ${todoTickets.length}`);

  let resolvedCount = 0;
  const resolveIds: string[] = [];

  for (const ticket of todoTickets) {
    const lastInbound = await db.helpdeskMessage.findFirst({
      where: {
        ticketId: ticket.id,
        direction: "INBOUND",
        deletedAt: null,
      },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    });

    const lastOutbound = await db.helpdeskMessage.findFirst({
      where: {
        ticketId: ticket.id,
        direction: "OUTBOUND",
        source: { not: "AUTO_RESPONDER" },
        deletedAt: null,
      },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    });

    if (
      lastOutbound?.sentAt &&
      lastInbound?.sentAt &&
      lastOutbound.sentAt > lastInbound.sentAt
    ) {
      resolveIds.push(ticket.id);
      resolvedCount++;
    }
  }

  console.log(`Tickets where agent already replied (→ RESOLVED): ${resolvedCount}`);

  if (apply && resolveIds.length > 0) {
    const result = await db.helpdeskTicket.updateMany({
      where: { id: { in: resolveIds } },
      data: { status: "RESOLVED" },
    });
    console.log(`  → Resolved ${result.count} tickets`);
  }

  // ── 3. Move SYSTEM tickets to correct status ───────────────────────────────
  // FROM EBAY (type=SYSTEM) tickets should NOT be in To Do.
  const systemInTodo = await db.helpdeskTicket.count({
    where: {
      type: "SYSTEM",
      status: { in: ["TO_DO", "NEW"] },
      isArchived: false,
    },
  });

  console.log(`\nSYSTEM tickets stuck in TO_DO/NEW: ${systemInTodo}`);

  if (apply && systemInTodo > 0) {
    const result = await db.helpdeskTicket.updateMany({
      where: {
        type: "SYSTEM",
        status: { in: ["TO_DO", "NEW"] },
        isArchived: false,
      },
      data: { status: "RESOLVED", isArchived: true },
    });
    console.log(`  → Archived ${result.count} SYSTEM tickets`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const remainingTodo = await db.helpdeskTicket.count({
    where: { status: { in: ["TO_DO", "NEW"] }, isArchived: false },
  });

  console.log(`\n=== Summary ===`);
  console.log(`AR-only → archived: ${arOnlyCount}`);
  console.log(`Agent-replied → resolved: ${resolvedCount}`);
  console.log(`SYSTEM → archived: ${systemInTodo}`);
  console.log(`Remaining TO_DO/NEW after reconciliation: ${remainingTodo - (apply ? 0 : arOnlyCount + resolvedCount + systemInTodo)}`);
  if (!apply) {
    console.log(`\n⚠️  DRY RUN — no changes made. Add --apply to execute.`);
  } else {
    console.log(`\n✅ Reconciliation applied.`);
  }
}

main()
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
