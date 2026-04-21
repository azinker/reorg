/**
 * Sample what buyer info we have on MarketplaceSaleOrder rows so we know
 * how confident we can be when resolving HelpdeskTicket.buyer*.
 *
 * Read-only.
 */
import { db } from "@/lib/db";

async function main() {
  // Look at one ticket that has an order number and try to find the matching sale order.
  const tkt = await db.helpdeskTicket.findFirst({
    where: { ebayOrderNumber: { not: null } },
    select: { id: true, ebayOrderNumber: true, channel: true, integrationId: true },
  });
  if (!tkt) { console.log("no ticket"); return; }

  console.log(`Ticket ${tkt.id} order=${tkt.ebayOrderNumber} channel=${tkt.channel}`);

  const order = await db.marketplaceSaleOrder.findFirst({
    where: {
      platform: tkt.channel,
      externalOrderId: tkt.ebayOrderNumber!,
    },
    select: {
      id: true,
      externalOrderId: true,
      buyerIdentifier: true,
      buyerDisplayLabel: true,
      buyerEmail: true,
      rawData: true,
    },
  });

  if (!order) {
    console.log(`  no MarketplaceSaleOrder for that order number`);
  } else {
    console.log(`  found order ${order.id}`);
    console.log(`    buyerIdentifier:   ${order.buyerIdentifier}`);
    console.log(`    buyerDisplayLabel: ${order.buyerDisplayLabel}`);
    console.log(`    buyerEmail:        ${order.buyerEmail}`);
    const raw = order.rawData as Record<string, unknown>;
    console.log(`    rawData keys:      ${Object.keys(raw).slice(0, 30).join(",")}`);
    // Look for buyer-ish nested fields.
    const dump = JSON.stringify(raw, null, 2);
    console.log(`    rawData first 1500 chars:\n${dump.slice(0, 1500)}`);
  }

  // Check counts.
  const totalOrders = await db.marketplaceSaleOrder.count();
  const totalEbayOrders = await db.marketplaceSaleOrder.count({ where: { platform: { in: ["TPP_EBAY", "TT_EBAY"] } } });
  const totalTicketsWithOrder = await db.helpdeskTicket.count({ where: { ebayOrderNumber: { not: null } } });
  console.log(`\nMarketplaceSaleOrder total: ${totalOrders}`);
  console.log(`MarketplaceSaleOrder for TPP/TT eBay: ${totalEbayOrders}`);
  console.log(`HelpdeskTicket with ebayOrderNumber: ${totalTicketsWithOrder}`);

  await db.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
