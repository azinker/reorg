// One-off: run the returns sync once against PROD (pull-only into our own
// HelpdeskReturnCase table — no eBay writes) and print the summary. Used to
// verify the bucket-tagging populates ITEM_SHIPPED / ITEM_DELIVERED / CLOSED.
//
//   pwsh scripts/run-with-prod.ps1 -Script scripts/_run-returns-sync.ts

import { db } from "@/lib/db";
import { runHelpdeskReturnsSync } from "@/lib/services/helpdesk-returns-sync";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "<unknown>";
  console.log(`[sync] connected to ${host}`);
  const res = await runHelpdeskReturnsSync();
  console.log(`[sync] durationMs=${res.durationMs}`);
  for (const s of res.summaries) {
    console.log(`  ${s.platform}: upserted=${s.upserted} errors=${JSON.stringify(s.errors)}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
