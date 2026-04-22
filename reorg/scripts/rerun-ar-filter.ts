/**
 * Re-run the "Auto Responder Initial Message" filter (and any other named
 * filter passed via --name) over the entire inbox. The filter engine in
 * filters.ts already paginates through all eligible messages and applies
 * each filter's action, but it only runs automatically when:
 *   - a new inbound message lands (live evaluation in helpdesk-ebay-sync)
 *   - the user clicks "Run filter now" in the UI
 *
 * This script invokes the same code path manually so we can clean up any
 * backlog after a fresh deploy without clicking through the UI.
 */
import { db } from "@/lib/db";
import { runFilterOverInbox } from "@/lib/helpdesk/filters";

function parseArgs(): { name: string } {
  const argv = process.argv.slice(2);
  let name = "Auto Responder Initial Message";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") name = argv[++i] ?? name;
  }
  return { name };
}

async function main() {
  const { name } = parseArgs();
  console.log(`[rerun-ar-filter] looking up filter "${name}"`);

  const filter = await db.helpdeskFilter.findFirst({
    where: { name },
    select: { id: true, name: true, enabled: true },
  });

  if (!filter) {
    console.error(`  no filter named "${name}" — aborting`);
    process.exit(1);
  }
  if (!filter.enabled) {
    console.warn(`  filter "${filter.name}" is disabled — running anyway`);
  }

  console.log(`  running filter ${filter.id} (${filter.name})...`);
  const start = Date.now();
  const result = await runFilterOverInbox(filter.id, null);
  console.log(
    `  done in ${Date.now() - start}ms — scanned ${result.scanned}, matched ${result.matched}, applied ${result.applied}`,
  );

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
