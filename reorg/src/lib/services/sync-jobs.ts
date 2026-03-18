import { db } from "@/lib/db";

const STALE_RUNNING_JOB_MS = 45 * 60 * 1000;

export function isRunningJobStale(
  job: {
    startedAt: Date | null;
    createdAt: Date;
  },
  now = new Date(),
) {
  const startedAt = job.startedAt ?? job.createdAt;
  return now.getTime() - startedAt.getTime() >= STALE_RUNNING_JOB_MS;
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
