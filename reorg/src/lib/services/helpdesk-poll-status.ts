import { db } from "@/lib/db";

/**
 * Persists the "last tick" status for the Help Desk message poll.
 *
 * Used by both the cron route (`/api/cron/helpdesk-poll`) and the manual
 * sync route (`/api/helpdesk/sync`) so that the "Synced X ago" indicator in
 * the Help Desk header reflects every successful poll, not just cron-driven
 * ones. Previously the manual route skipped this write, which is why
 * clicking "Sync now" never cleared the "Synced never" label even though
 * messages were arriving.
 *
 * Three keys live in `app_settings`:
 *   - helpdesk_poll_last_tick_at   ISO string of when the poll started
 *   - helpdesk_poll_last_outcome   "completed" | "failed" | "skipped"
 *   - helpdesk_poll_last_summary   { durationMs, summaries, error }
 *
 * The keys are namespaced with `helpdesk_poll_` so the Engine Room status
 * page can surface them next to other automation health metrics.
 */
export async function recordHelpdeskPollStatus(payload: {
  tickedAt: string;
  outcome: "completed" | "failed" | "skipped";
  durationMs: number;
  summaries: unknown;
  error: string | null;
}): Promise<void> {
  await Promise.all([
    db.appSetting.upsert({
      where: { key: "helpdesk_poll_last_tick_at" },
      create: { key: "helpdesk_poll_last_tick_at", value: payload.tickedAt as never },
      update: { value: payload.tickedAt as never },
    }),
    db.appSetting.upsert({
      where: { key: "helpdesk_poll_last_outcome" },
      create: { key: "helpdesk_poll_last_outcome", value: payload.outcome as never },
      update: { value: payload.outcome as never },
    }),
    db.appSetting.upsert({
      where: { key: "helpdesk_poll_last_summary" },
      create: {
        key: "helpdesk_poll_last_summary",
        value: {
          durationMs: payload.durationMs,
          summaries: payload.summaries,
          error: payload.error,
        } as never,
      },
      update: {
        value: {
          durationMs: payload.durationMs,
          summaries: payload.summaries,
          error: payload.error,
        } as never,
      },
    }),
  ]);
}
