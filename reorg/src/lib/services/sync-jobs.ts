import { db } from "@/lib/db";

// Keep a reasonably aggressive stale-job guard for jobs that never really got
// going, but give large in-flight catalog pulls more room once they've already
// processed a substantial amount of data.
const STALE_RUNNING_JOB_MS = 90 * 60 * 1000;
const STALE_RUNNING_ACTIVE_JOB_MS = 4 * 60 * 60 * 1000;
const LARGE_PROGRESS_ITEM_THRESHOLD = 1000;

export function isRunningJobStale(
  job: {
    startedAt: Date | null;
    createdAt: Date;
    itemsProcessed?: number | null;
  },
  now = new Date(),
) {
  const startedAt = job.startedAt ?? job.createdAt;
  const staleThresholdMs =
    (job.itemsProcessed ?? 0) >= LARGE_PROGRESS_ITEM_THRESHOLD
      ? STALE_RUNNING_ACTIVE_JOB_MS
      : STALE_RUNNING_JOB_MS;

  return now.getTime() - startedAt.getTime() >= staleThresholdMs;
}

export async function failStaleRunningJob(
  job: {
    id: string;
    integrationId?: string | null;
    triggeredBy?: string | null;
    errors: unknown;
  },
  reason: string,
) {
  const existingErrors = Array.isArray(job.errors) ? job.errors : [];
  const nextErrors = [...existingErrors, reason];

  await db.syncJob.update({
    where: { id: job.id },
    data: {
      status: "FAILED",
      completedAt: new Date(),
      errors: JSON.parse(JSON.stringify(nextErrors)),
    },
  });

  await db.auditLog.create({
    data: {
      action: "sync_stale_failed",
      entityType: "sync_job",
      entityId: job.id,
      details: {
        integrationId: job.integrationId ?? null,
        triggeredBy: job.triggeredBy ?? null,
        reason,
      },
    },
  });
}
