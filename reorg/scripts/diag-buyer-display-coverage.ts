/**
 * Quick coverage check — how many MarketplaceSaleOrder rows already have
 * a real-name buyerDisplayLabel vs how many still need backfilling?
 */
import { db } from "@/lib/db";

async function main() {
  const platforms = ["TPP_EBAY", "TT_EBAY"] as const;
  for (const platform of platforms) {
    const total = await db.marketplaceSaleOrder.count({
      where: { platform },
    });
    const withLabel = await db.marketplaceSaleOrder.count({
      where: {
        platform,
        buyerDisplayLabel: { not: null },
      },
    });
    // "real name" heuristic: the label has a space and isn't equal to
    // buyerIdentifier — proxy for first/last name.
    const realNames = await db.marketplaceSaleOrder.count({
      where: {
        platform,
        buyerDisplayLabel: { not: null, contains: " " },
      },
    });
    console.log(
      `${platform}: total=${total}  hasLabel=${withLabel}  realNames=${realNames}`,
    );
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
