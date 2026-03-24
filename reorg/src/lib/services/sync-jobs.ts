import { db } from "@/lib/db";

// Shopify/BigCommerce full pulls run across multiple serverless chunks; give
// in-progress jobs enough wall-clock so checkpoint continuations can finish.
// Zero-progress runs are still cleaned up relatively quickly.
const STALE_RUNNING_JOB_MS = 55 * 60 * 1000;
const STALE_RUNNING_ACTIVE_JOB_MS = 90 * 60 * 1000;
const LARGE_PROGRESS_ITEM_THRESHOLD = 1000;
const STALE_RUNNING_ZERO_PROGRESS_MS = 12 * 60 * 1000;
export const SYNC_CANCELLED_ERROR = "Sync cancelled by user.";

export function isRunningJobStale(
  job: {
    startedAt: Date | null;
    createdAt: Date;
    itemsProcessed?: number | null;
  },
  now = new Date(),
) {
  const startedAt = job.startedAt ?? job.createdAt;
  const processed = job.itemsProcessed ?? 0;
  const staleThresholdMs =
    processed === 0
      ? STALE_RUNNING_ZERO_PROGRESS_MS
      : processed >= LARGE_PROGRESS_ITEM_THRESHOLD
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

export async function cancelRunningSyncJob(
  job: {
    id: string;
    integrationId?: string | null;
    triggeredBy?: string | null;
    errors: unknown;
  },
  reason = SYNC_CANCELLED_ERROR,
) {
  const existingErrors = Array.isArray(job.errors) ? job.errors : [];
  const nextErrors = existingErrors.includes(reason)
    ? existingErrors
    : [...existingErrors, reason];

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
      action: "sync_cancelled",
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

export async function throwIfSyncJobStopped(jobId: string) {
  const job = await db.syncJob.findUnique({
    where: { id: jobId },
    select: { status: true },
  });

  if (!job || job.status !== "RUNNING") {
    throw new Error(SYNC_CANCELLED_ERROR);
  }
}
