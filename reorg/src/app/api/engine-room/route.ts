import { NextResponse } from "next/server";
import { db } from "@/lib/db";

const PLATFORM_LABEL: Record<string, string> = {
  TPP_EBAY: "eBay (TPP)",
  TT_EBAY: "eBay (TT)",
  BIGCOMMERCE: "BigCommerce",
  SHOPIFY: "Shopify",
};

function normalizeErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const sku = typeof record.sku === "string" ? record.sku : null;
    const message = typeof record.message === "string" ? record.message : null;

    if (sku && message) return `${sku}: ${message}`;
    if (message) return message;
  }

  return JSON.stringify(error);
}

export async function GET() {
  try {
    const [syncJobs, stagedChanges, auditLogs, globalLock, schedulerSettings] = await Promise.all([
      db.syncJob.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { integration: { select: { platform: true, label: true } } },
      }),
      db.stagedChange.findMany({
        where: { status: "STAGED" },
        orderBy: { createdAt: "desc" },
        include: {
          masterRow: { select: { sku: true } },
          changedBy: { select: { name: true } },
          marketplaceListing: {
            select: { integration: { select: { platform: true, label: true } } },
          },
        },
      }),
      db.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { user: { select: { name: true } } },
      }),
      db.appSetting.findUnique({
        where: { key: "global_write_lock" },
      }),
      db.appSetting.findMany({
        where: {
          key: {
            in: [
              "scheduler_enabled",
              "scheduler_last_tick_at",
              "scheduler_last_outcome",
              "scheduler_last_due_count",
              "scheduler_last_dispatched_count",
              "scheduler_last_error",
            ],
          },
        },
      }),
    ]);

    const schedulerMap = Object.fromEntries(
      schedulerSettings.map((setting) => [setting.key, setting.value]),
    );

    const syncJobsPayload = syncJobs.map((job) => {
      const duration =
        job.startedAt && job.completedAt
          ? Math.round((job.completedAt.getTime() - job.startedAt.getTime()) / 1000)
          : null;
      const label =
        job.integration?.label ??
        PLATFORM_LABEL[job.integration?.platform ?? ""] ??
        job.integration?.platform ??
        "-";
      const errors = Array.isArray(job.errors) ? job.errors.map(normalizeErrorMessage) : [];

      return {
        id: job.id,
        platform: label,
        status:
          job.status === "RUNNING"
            ? "in_progress"
            : job.status === "COMPLETED"
              ? "completed"
              : job.status === "FAILED"
                ? "failed"
                : "pending",
        items: job.itemsProcessed,
        started: job.startedAt?.toISOString() ?? null,
        completedAt: job.completedAt?.toISOString() ?? null,
        durationSeconds: duration,
        errors,
        source:
          typeof job.triggeredBy === "string" && job.triggeredBy.startsWith("scheduler:")
            ? "scheduler"
            : "manual",
      };
    });

    const pushQueuePayload = stagedChanges.map((sc) => {
      const platform =
        sc.marketplaceListing?.integration?.label ??
        PLATFORM_LABEL[sc.marketplaceListing?.integration?.platform ?? ""] ??
        sc.marketplaceListing?.integration?.platform ??
        "-";
      const field = sc.field === "adRate" ? "Ad Rate" : sc.field === "salePrice" ? "Price" : sc.field;

      return {
        id: sc.id,
        sku: sc.masterRow?.sku ?? "-",
        field,
        oldValue: sc.liveValue ?? "-",
        newValue: sc.stagedValue,
        platform,
        status: "queued" as const,
        editedBy: sc.changedBy?.name ?? "-",
      };
    });

    const changeLogPayload = auditLogs.map((entry) => {
      const details = (entry.details as Record<string, unknown>) ?? {};
      let detail = "";

      if (entry.action === "sync_completed") {
        const d = details as { itemsProcessed?: number };
        detail = `${entry.entityType === "integration" ? "Integration" : "Sync"} - ${d.itemsProcessed ?? 0} items`;
      } else if (entry.action === "sync_failed") {
        const d = details as { error?: string };
        detail = d.error ?? "Unknown error";
      } else if (entry.action === "edit_master") {
        const d = details as { field?: string; oldValue?: unknown; newValue?: unknown };
        detail = d.field ? `${String(d.oldValue ?? "")} -> ${String(d.newValue ?? "")}` : JSON.stringify(details);
      } else if (entry.action === "push_price" || entry.action === "push_ad_rate") {
        const d = details as { oldValue?: unknown; newPrice?: unknown };
        detail = `${String(d.oldValue ?? "")} -> ${String(d.newPrice ?? "")}`;
      } else if (entry.action === "staged_change") {
        const d = details as { field?: string; oldValue?: unknown; newValue?: unknown };
        detail = d.field ? `${String(d.oldValue ?? "")} -> ${String(d.newValue ?? "")}` : JSON.stringify(details);
      } else {
        detail = Object.keys(details).length ? JSON.stringify(details) : entry.action;
      }

      const actionLabel =
        entry.action === "sync_completed"
          ? "Sync completed"
          : entry.action === "sync_failed"
            ? "Sync failed"
            : entry.action === "edit_master"
              ? "Master edit"
              : entry.action === "push_price"
                ? "Pushed price"
                : entry.action === "push_ad_rate"
                  ? "Pushed ad rate"
                  : entry.action === "staged_change"
                    ? "Staged change"
                    : entry.action;
      const sku = details.sku != null ? String(details.sku) : "-";

      return {
        timestamp: entry.createdAt.toISOString(),
        user: entry.user?.name ?? "System",
        action: actionLabel,
        sku,
        detail,
      };
    });

    const rawEventsPayload = auditLogs.slice(0, 30).map((entry) => ({
      time: entry.createdAt.toISOString(),
      entry: `${entry.action}  ${entry.entityType ?? ""}  ${entry.entityId ?? ""}  ${JSON.stringify(entry.details).slice(0, 100)}`,
    }));

    const activeSyncs = syncJobs.filter((j) => j.status === "RUNNING").length;
    const queuedPushes = stagedChanges.length;
    const failedInLast7Days = syncJobs.filter(
      (j) => j.status === "FAILED" && j.completedAt && Date.now() - j.completedAt.getTime() < 7 * 24 * 60 * 60 * 1000,
    );
    const recentErrors = failedInLast7Days.length;
    const recentErrorDetail =
      failedInLast7Days.length > 0
        ? Array.isArray(failedInLast7Days[0].errors) && failedInLast7Days[0].errors.length > 0
          ? normalizeErrorMessage(failedInLast7Days[0].errors[0])
          : "Sync failed (no message)"
        : null;
    const writeLockOn = globalLock?.value === true;
    const schedulerEnabled = schedulerMap.scheduler_enabled === true;
    const schedulerLastTickAt =
      typeof schedulerMap.scheduler_last_tick_at === "string"
        ? schedulerMap.scheduler_last_tick_at
        : null;
    const schedulerLastOutcome =
      schedulerMap.scheduler_last_outcome === "dry_run" ||
      schedulerMap.scheduler_last_outcome === "completed" ||
      schedulerMap.scheduler_last_outcome === "failed"
        ? schedulerMap.scheduler_last_outcome
        : null;
    const schedulerLastDueCount =
      typeof schedulerMap.scheduler_last_due_count === "number"
        ? schedulerMap.scheduler_last_due_count
        : 0;
    const schedulerLastDispatchedCount =
      typeof schedulerMap.scheduler_last_dispatched_count === "number"
        ? schedulerMap.scheduler_last_dispatched_count
        : 0;
    const schedulerLastError =
      typeof schedulerMap.scheduler_last_error === "string"
        ? schedulerMap.scheduler_last_error
        : null;
    const schedulerActiveJobs = syncJobs.filter(
      (job) =>
        job.status === "RUNNING" &&
        typeof job.triggeredBy === "string" &&
        job.triggeredBy.startsWith("scheduler:"),
    ).length;

    return NextResponse.json({
      data: {
        syncJobs: syncJobsPayload,
        pushQueue: pushQueuePayload,
        changeLog: changeLogPayload,
        rawEvents: rawEventsPayload,
        summary: {
          activeSyncs,
          queuedPushes,
          recentErrors,
          recentErrorDetail,
          writeLockOn,
          schedulerEnabled,
          schedulerLastTickAt,
          schedulerLastOutcome,
          schedulerLastDueCount,
          schedulerLastDispatchedCount,
          schedulerLastError,
          schedulerActiveJobs,
        },
      },
    });
  } catch (error) {
    console.error("[engine-room] GET failed", error);
    return NextResponse.json({ error: "Failed to load engine room data" }, { status: 500 });
  }
}
