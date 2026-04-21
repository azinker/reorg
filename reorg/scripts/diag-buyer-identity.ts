/**
 * Diagnose how buyer identity is currently being captured.
 *
 * Goal: prove that buyerUserId/buyerName on tickets are being populated
 * with the SELLER's eBay user id (e.g. "telitetech", "theperfectpart"),
 * not the buyer's. Then sample raw message data so we know which fields
 * actually carry the buyer identity for system / shipping / refund
 * messages that arrive in the eBay Inbox folder.
 *
 * Read-only. Safe to run against prod.
 */
import { db } from "@/lib/db";

async function main() {
  // Distribution of distinct buyerUserId values per integration.
  const integrations = await db.integration.findMany({
    where: { platform: { in: ["TPP_EBAY", "TT_EBAY"] } },
    select: { id: true, label: true, platform: true },
  });

  for (const integ of integrations) {
    console.log(`\n=== ${integ.label} (${integ.platform}) ===`);

    const distinct = (await db.helpdeskTicket.groupBy({
      by: ["buyerUserId"],
      where: { integrationId: integ.id },
      _count: true,
      orderBy: { _count: { buyerUserId: "desc" } },
      take: 10,
    })) as Array<{ buyerUserId: string | null; _count: number }>;

    console.log(`Top 10 buyerUserId values on tickets:`);
    for (const row of distinct) {
      console.log(`  ${String(row.buyerUserId ?? "(null)").padEnd(30)}  ${row._count} tickets`);
    }

    // Sample one ticket where buyerUserId looks suspicious (== integration handle).
    const sample = await db.helpdeskTicket.findFirst({
      where: { integrationId: integ.id },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        subject: true,
        buyerUserId: true,
        buyerName: true,
        ebayOrderNumber: true,
        messages: {
          take: 3,
          orderBy: { sentAt: "asc" },
          select: {
            id: true,
            direction: true,
            source: true,
            fromName: true,
            fromIdentifier: true,
            subject: true,
            bodyText: true,
            rawData: true,
          },
        },
      },
    });

    if (!sample) continue;
    console.log(`\nSample ticket ${sample.id}`);
    console.log(`  subject:        ${(sample.subject ?? "").slice(0, 80)}`);
    console.log(`  buyer on ticket: ${sample.buyerUserId} / ${sample.buyerName ?? "?"}`);
    console.log(`  order:          ${sample.ebayOrderNumber ?? "(none)"}`);
    console.log(`  first 3 messages:`);
    for (const m of sample.messages) {
      const raw = (m.rawData ?? {}) as Record<string, unknown>;
      console.log(`    - ${m.direction.padEnd(8)} ${m.source.padEnd(15)} from=${m.fromName ?? "?"}`);
      console.log(`        subject:        ${(m.subject ?? "").slice(0, 80)}`);
      console.log(`        rawData keys:   ${Object.keys(raw).join(",")}`);
      console.log(`        recipientUserID:${raw.recipientUserID ?? "(null)"}`);
      console.log(`        body[0..120]:   ${(m.bodyText ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
