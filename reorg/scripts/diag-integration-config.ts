/**
 * Inspect Integration.config for the eBay integrations so we can find
 * the seller's eBay username (to filter it out of buyerUserId).
 */
import { db } from "@/lib/db";

async function main() {
  const integrations = await db.integration.findMany({
    where: { platform: { in: ["TPP_EBAY", "TT_EBAY"] } },
  });
  for (const i of integrations) {
    console.log(`\n=== ${i.label} (${i.platform}) ===`);
    const cfg = i.config as Record<string, unknown>;
    console.log("config keys:", Object.keys(cfg));
    console.log("accountUserId:", cfg.accountUserId);
    console.log("syncProfile:", cfg.syncProfile);
    console.log("webhookState:", cfg.webhookState);
  }
  await db.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
