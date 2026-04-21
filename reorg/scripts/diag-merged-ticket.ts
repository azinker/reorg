/**
 * Diagnose the suspected ticket-merge bug.
 *
 * User report: a ticket whose subject says it's about
 *   "telitetech has sent a question about item #226336545285 ... order 08-14471-32723"
 * is showing messages from *other* orders in the same ticket's thread.
 *
 * This script:
 *   1. Finds the ticket by order number and/or item id.
 *   2. Dumps every HelpdeskMessage on that ticket with its own
 *      ebayOrderId (from rawData) and ebayItemId so we can see which
 *      ones don't belong.
 *   3. Dumps the ticket's own canonical identifiers so we can see how
 *      the sync decided to co-locate them.
 *
 * Read-only. Safe to run against prod.
 */
import { db } from "@/lib/db";

const TARGET_ORDER = "08-14471-32723";
const TARGET_ITEM = "226336545285";

async function main() {
  const variants = [
    TARGET_ORDER,
    TARGET_ORDER.replace(/-/g, ""),
  ];
  const tickets = await db.helpdeskTicket.findMany({
    where: {
      OR: [
        { ebayOrderNumber: { in: variants } },
        { ebayItemId: TARGET_ITEM },
      ],
    },
    select: {
      id: true,
      threadKey: true,
      subject: true,
      ebayOrderNumber: true,
      ebayItemId: true,
      buyerUserId: true,
      buyerName: true,
      status: true,
      isArchived: true,
      createdAt: true,
      integrationId: true,
      integration: { select: { platform: true, label: true } },
      _count: { select: { messages: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  console.log(`\nFound ${tickets.length} candidate ticket(s):\n`);
  for (const t of tickets) {
    console.log(`  TICKET ${t.id}`);
    console.log(`    subject:     ${t.subject ?? "(null)"}`);
    console.log(`    threadKey:   ${t.threadKey ?? "(null)"}`);
    console.log(`    order:       ${t.ebayOrderNumber ?? "(null)"}`);
    console.log(`    item:        ${t.ebayItemId ?? "(null)"}`);
    console.log(`    buyer:       ${t.buyerUserId ?? "?"} (${t.buyerName ?? "?"})`);
    console.log(`    integration: ${t.integration.label} (${t.integration.platform})`);
    console.log(`    messages:    ${t._count.messages}`);
    console.log(`    status:      ${t.status} archived=${t.isArchived}`);
    console.log();
  }

  if (tickets.length === 0) {
    console.log("No ticket matched. Trying a broader subject LIKE search...");
    const like = await db.helpdeskTicket.findMany({
      where: { subject: { contains: "226336545285" } },
      select: { id: true, subject: true, ebayOrderNumber: true, ebayItemId: true, _count: { select: { messages: true } } },
      take: 5,
    });
    for (const t of like) {
      console.log(`  ${t.id}  order=${t.ebayOrderNumber} item=${t.ebayItemId} msgs=${t._count.messages}`);
      console.log(`    ${t.subject}`);
    }
    await db.$disconnect();
    return;
  }

  // Pick the one the user most likely screenshotted: the busiest ticket that
  // matches both order/item.
  const target =
    tickets.find((t) => t.ebayOrderNumber && variants.includes(t.ebayOrderNumber)) ??
    tickets[0];

  console.log(`\n--- Dumping messages on ticket ${target.id} ---\n`);

  const messages = await db.helpdeskMessage.findMany({
    where: { ticketId: target.id },
    orderBy: { sentAt: "asc" },
    select: {
      id: true,
      direction: true,
      source: true,
      subject: true,
      fromName: true,
      fromIdentifier: true,
      sentAt: true,
      ebayMessageId: true,
      externalId: true,
      rawData: true,
      bodyText: true,
    },
  });

  console.log(`${messages.length} message(s) on this ticket:\n`);

  const byOrder = new Map<string, number>();
  const byItem = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const raw = (m.rawData ?? {}) as Record<string, unknown>;
    const ebayOrderId =
      (raw.orderLineItemID as string | undefined) ??
      (raw.externalTransactionID as string | undefined) ??
      (raw.orderID as string | undefined) ??
      null;
    const ebayItemId =
      (raw.itemID as string | undefined) ??
      (raw.itemId as string | undefined) ??
      null;
    const subjectShort = (m.subject ?? "").slice(0, 80);
    const bodyPreview = (m.bodyText ?? "").replace(/\s+/g, " ").slice(0, 120);

    console.log(`  [${i + 1}/${messages.length}] ${m.direction.padEnd(8)} ${m.sentAt.toISOString()}`);
    console.log(`      from:      ${m.fromName ?? m.fromIdentifier ?? "?"}`);
    console.log(`      subject:   ${subjectShort}`);
    console.log(`      ebayMsgId: ${m.ebayMessageId ?? "(null)"}`);
    console.log(`      raw.order: ${ebayOrderId ?? "(null)"}`);
    console.log(`      raw.item:  ${ebayItemId ?? "(null)"}`);
    console.log(`      body:      ${bodyPreview}`);
    console.log();

    if (ebayOrderId) byOrder.set(ebayOrderId, (byOrder.get(ebayOrderId) ?? 0) + 1);
    if (ebayItemId) byItem.set(ebayItemId, (byItem.get(ebayItemId) ?? 0) + 1);
  }

  console.log(`\n--- Breakdown of messages by their own eBay orderId ---`);
  for (const [order, count] of [...byOrder.entries()].sort((a, b) => b[1] - a[1])) {
    const flag = order !== target.ebayOrderNumber ? "  <-- DIFFERENT FROM TICKET" : "";
    console.log(`  ${order}: ${count}${flag}`);
  }
  console.log(`\n--- Breakdown of messages by their own eBay itemId ---`);
  for (const [item, count] of [...byItem.entries()].sort((a, b) => b[1] - a[1])) {
    const flag = item !== target.ebayItemId ? "  <-- DIFFERENT FROM TICKET" : "";
    console.log(`  ${item}: ${count}${flag}`);
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
