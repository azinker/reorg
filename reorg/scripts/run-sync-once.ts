/**
 * Trigger a single helpdesk sync poll cycle. Useful when waiting for a
 * specific message to land that's known to be sitting on eBay but hasn't
 * been pulled yet (cron next-tick latency).
 */
import { runHelpdeskPoll } from "../src/lib/services/helpdesk-ebay-sync";
import { db } from "../src/lib/db";

async function main() {
  console.log("[sync] starting helpdesk poll");
  const result = await runHelpdeskPoll();
  console.log("[sync] result:");
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((e) => {
    console.error("[sync] failed:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
