/**
 * Sweep — re-run every enabled filter whose action moves tickets out of
 * the open folders (Archive, Cancel Requests). This catches anything that
 * leaked into All/To Do/Waiting before the live-evaluation fix shipped.
 */
import { db } from "@/lib/db";
import { runFilterOverInbox } from "@/lib/helpdesk/filters";

async function main() {
  const filters = await db.helpdeskFilter.findMany({
    where: { enabled: true },
    select: { id: true, name: true, action: true },
    orderBy: { sortOrder: "asc" },
  });

  console.log(`[rerun-all-archive-filters] found ${filters.length} enabled filters`);

  let totalApplied = 0;
  for (const f of filters) {
    const action = f.action as Record<string, unknown> | null;
    const folder =
      action && typeof action.folder === "string"
        ? action.folder.toLowerCase()
        : null;
    // Only re-run filters whose action actually moves the ticket out of
    // open folders — mark-as-read, set-priority etc don't need a sweep.
    const movesOutOfOpen =
      folder === "archived" || folder === "cancel_requests" || folder === "spam";
    if (!movesOutOfOpen) {
      console.log(`  skipping "${f.name}" — action folder=${folder}`);
      continue;
    }

    console.log(`\n── running "${f.name}" (folder=${folder}) ──`);
    const start = Date.now();
    try {
      const result = await runFilterOverInbox(f.id, null);
      console.log(
        `  ${Date.now() - start}ms — scanned ${result.scanned}, matched ${result.matched}, applied ${result.applied}`,
      );
      totalApplied += result.applied;
    } catch (err) {
      console.error(`  failed:`, err);
    }
  }

  console.log(`\n[rerun-all-archive-filters] done — total applied: ${totalApplied}`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
