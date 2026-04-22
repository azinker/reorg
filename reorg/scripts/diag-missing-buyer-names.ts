/**
 * Diagnose WHY most open tickets don't have a real first/last name.
 * For each open ticket missing a real name, check whether its
 * MarketplaceSaleOrder row exists and what fields it has.
 */
import { db } from "@/lib/db";
import { HelpdeskTicketStatus } from "@prisma/client";

function looksReal(label: string | null | undefined): boolean {
  if (!label) return false;
  const t = label.trim();
  return /^\S+\s+\S+/.test(t) && /[A-Za-z]/.test(t);
}

async function main() {
  const openTickets = await db.helpdeskTicket.findMany({
    where: {
      isArchived: false,
      isSpam: false,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lt: new Date() } }],
      status: {
        in: [
          HelpdeskTicketStatus.NEW,
          HelpdeskTicketStatus.TO_DO,
          HelpdeskTicketStatus.WAITING,
        ],
      },
      ebayOrderNumber: { not: null },
    },
    select: {
      id: true,
      channel: true,
      ebayOrderNumber: true,
      buyerName: true,
      buyerUserId: true,
    },
  });
  console.log(
    `\n${openTickets.length} open tickets with an order number\n`,
  );

  const keys = openTickets.map((t) => ({
    platform: t.channel,
    externalOrderId: t.ebayOrderNumber!,
  }));

  const orders = await db.marketplaceSaleOrder.findMany({
    where: {
      OR: keys.map((k) => ({
        platform: k.platform,
        externalOrderId: k.externalOrderId,
      })),
    },
    select: {
      platform: true,
      externalOrderId: true,
      buyerIdentifier: true,
      buyerDisplayLabel: true,
      buyerEmail: true,
    },
  });
  const orderMap = new Map(
    orders.map((o) => [`${o.platform}::${o.externalOrderId}`, o]),
  );

  // Categorize
  const byChannel = new Map<
    string,
    {
      total: number;
      orderMissing: number;
      orderHasNoLabel: number;
      orderHasUsernameLabel: number;
      orderHasRealLabel: number;
      ticketAlreadyReal: number;
    }
  >();

  const samples: string[] = [];

  for (const t of openTickets) {
    const ch = t.channel;
    if (!byChannel.has(ch)) {
      byChannel.set(ch, {
        total: 0,
        orderMissing: 0,
        orderHasNoLabel: 0,
        orderHasUsernameLabel: 0,
        orderHasRealLabel: 0,
        ticketAlreadyReal: 0,
      });
    }
    const stats = byChannel.get(ch)!;
    stats.total++;

    const ticketHasReal = looksReal(t.buyerName);
    if (ticketHasReal) stats.ticketAlreadyReal++;

    const key = `${t.channel}::${t.ebayOrderNumber}`;
    const order = orderMap.get(key);

    if (!order) {
      stats.orderMissing++;
      if (samples.length < 5) {
        samples.push(
          `MISSING ORDER  | ${t.channel} | ${t.ebayOrderNumber} | ticket buyer=${t.buyerName ?? "—"} (${t.buyerUserId ?? "—"})`,
        );
      }
      continue;
    }

    const label = order.buyerDisplayLabel?.trim() ?? "";
    if (!label) {
      stats.orderHasNoLabel++;
      if (samples.length < 5) {
        samples.push(
          `ORDER NO LABEL | ${order.platform} | ${order.externalOrderId} | buyerIdentifier=${order.buyerIdentifier ?? "—"}`,
        );
      }
    } else if (looksReal(label)) {
      stats.orderHasRealLabel++;
    } else {
      stats.orderHasUsernameLabel++;
      if (samples.length < 5) {
        samples.push(
          `ORDER USERNAME | ${order.platform} | ${order.externalOrderId} | label="${label}" buyerIdentifier=${order.buyerIdentifier ?? "—"}`,
        );
      }
    }
  }

  console.log("Per-channel breakdown:");
  for (const [ch, s] of byChannel) {
    console.log(`\n  ${ch}: ${s.total} tickets`);
    console.log(`    ticket already has real name:    ${s.ticketAlreadyReal}`);
    console.log(`    order missing entirely:          ${s.orderMissing}`);
    console.log(`    order exists, no buyerLabel:     ${s.orderHasNoLabel}`);
    console.log(`    order has username-only label:   ${s.orderHasUsernameLabel}`);
    console.log(`    order has REAL name label:       ${s.orderHasRealLabel}`);
  }

  console.log("\n\nSample rows that need help:");
  for (const s of samples) console.log("  " + s);

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
