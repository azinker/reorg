// One-off: snapshot what's actually persisted in HelpdeskReturnCase for TPP so
// we can see whether ebayBuckets is populated and why the list filters are
// empty. Read-only. Run against PROD (little-fire).
//
//   pwsh scripts/run-with-prod.ps1 -Script scripts/_inspect-returns-db.ts

import { db } from "@/lib/db";
import { Platform } from "@prisma/client";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "<unknown>";
  console.log(`[inspect] connected to ${host}`);

  const integration = await db.integration.findFirst({ where: { platform: Platform.TPP_EBAY } });
  if (!integration) {
    console.error("no TPP integration");
    return;
  }

  const total = await db.helpdeskReturnCase.count({ where: { integrationId: integration.id } });
  console.log(`\nTotal TPP return rows: ${total}`);

  const rows = await db.helpdeskReturnCase.findMany({
    where: { integrationId: integration.id },
    select: { returnId: true, returnState: true, ebayBuckets: true, lastSyncedAt: true },
  });

  const bucketCounts = new Map<string, number>();
  let withBuckets = 0;
  let emptyBuckets = 0;
  for (const r of rows) {
    const b = Array.isArray(r.ebayBuckets) ? (r.ebayBuckets as string[]) : [];
    if (b.length > 0) withBuckets++;
    else emptyBuckets++;
    for (const x of b) bucketCounts.set(x, (bucketCounts.get(x) ?? 0) + 1);
  }
  console.log(`rows with ebayBuckets populated: ${withBuckets}`);
  console.log(`rows with EMPTY ebayBuckets:     ${emptyBuckets}`);
  console.log("\nbucket membership counts (from DB):");
  for (const [k, v] of [...bucketCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  const stateCounts = new Map<string, number>();
  for (const r of rows) {
    const s = r.returnState ?? "(null)";
    stateCounts.set(s, (stateCounts.get(s) ?? 0) + 1);
  }
  console.log("\nreturnState counts (from DB):");
  for (const [k, v] of [...stateCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  const newest = rows
    .map((r) => r.lastSyncedAt?.getTime() ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);
  console.log(`\nnewest lastSyncedAt: ${newest ? new Date(newest).toISOString() : "never"}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
