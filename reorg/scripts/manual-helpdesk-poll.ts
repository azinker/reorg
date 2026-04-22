/**
 * One-shot Help Desk poll using the same code path Vercel cron would take.
 * Useful when the cron has been silent (e.g. middleware was 401'ing it) and
 * you want to immediately catch up the inbox without waiting for the next
 * tick after deploy.
 *
 * Run via: powershell scripts/run-with-prod.ps1 -Script scripts/manual-helpdesk-poll.ts
 */
import { runHelpdeskPoll } from "@/lib/services/helpdesk-ebay-sync";
import { runHelpdeskActionsPoll } from "@/lib/services/helpdesk-ebay-actions";
import { recordHelpdeskPollStatus } from "@/lib/services/helpdesk-poll-status";
import { db } from "@/lib/db";

async function main() {
  const tickedAt = new Date().toISOString();
  console.log(`[manual-helpdesk-poll] starting at ${tickedAt}`);

  try {
    const result = await runHelpdeskPoll();
    console.log(`  poll completed in ${result.durationMs}ms`);
    let actions: Awaited<ReturnType<typeof runHelpdeskActionsPoll>> | null = null;
    try {
      actions = await runHelpdeskActionsPoll();
      console.log(`  actions worker completed`);
    } catch (err) {
      console.error("  actions worker failed (continuing):", err);
    }
    await recordHelpdeskPollStatus({
      tickedAt,
      outcome: "completed",
      durationMs: result.durationMs,
      summaries: result.summaries,
      error: null,
    });
    console.log("\n== Per-integration summaries ==");
    console.log(JSON.stringify(result.summaries, null, 2));
    if (actions) {
      console.log("\n== Actions summary ==");
      console.log(JSON.stringify(actions, null, 2));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordHelpdeskPollStatus({
      tickedAt,
      outcome: "failed",
      durationMs: 0,
      summaries: [],
      error: message,
    });
    console.error("\n[manual-helpdesk-poll] FAILED:", message);
    throw err;
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
