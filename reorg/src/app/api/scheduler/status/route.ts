import { NextResponse } from "next/server";
import { db } from "@/lib/db";

type SchedulerOutcome = "dry_run" | "completed" | "failed";

function asOutcome(value: unknown): SchedulerOutcome | null {
  return value === "dry_run" || value === "completed" || value === "failed"
    ? value
    : null;
}

export async function GET() {
  try {
    const [settings, recentJobs, recentWebhooks] = await Promise.all([
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
      db.syncJob.findMany({
        where: {
          triggeredBy: {
            startsWith: "scheduler:",
          },
        },
        orderBy: { createdAt: "desc" },
        take: 8,
        include: {
          integration: {
            select: {
              platform: true,
              label: true,
            },
          },
        },
      }),
      db.auditLog.findMany({
        where: {
          action: "webhook_received",
        },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
    ]);

    const map = Object.fromEntries(settings.map((setting) => [setting.key, setting.value]));

    return NextResponse.json({
      data: {
        enabled: map.scheduler_enabled === true,
        lastTickAt:
          typeof map.scheduler_last_tick_at === "string"
            ? map.scheduler_last_tick_at
            : null,
        lastOutcome: asOutcome(map.scheduler_last_outcome),
        lastDueCount:
          typeof map.scheduler_last_due_count === "number"
            ? map.scheduler_last_due_count
            : 0,
        lastDispatchedCount:
          typeof map.scheduler_last_dispatched_count === "number"
            ? map.scheduler_last_dispatched_count
            : 0,
        lastError:
          typeof map.scheduler_last_error === "string"
            ? map.scheduler_last_error
            : null,
        runningCount: recentJobs.filter((job) => job.status === "RUNNING").length,
        recentJobs: recentJobs.map((job) => ({
          id: job.id,
          platform: job.integration?.platform ?? "UNKNOWN",
          label: job.integration?.label ?? job.integration?.platform ?? "Unknown",
          mode:
            typeof job.triggeredBy === "string" && job.triggeredBy.startsWith("scheduler:")
              ? job.triggeredBy.slice("scheduler:".length)
              : "unknown",
          status: job.status,
          itemsProcessed: job.itemsProcessed,
          itemsCreated: job.itemsCreated,
          itemsUpdated: job.itemsUpdated,
          startedAt: job.startedAt?.toISOString() ?? null,
          completedAt: job.completedAt?.toISOString() ?? null,
        })),
        recentWebhooks: recentWebhooks.map((entry) => {
          const details = (entry.details as Record<string, unknown>) ?? {};
          return {
            id: entry.id,
            platform:
              typeof details.platform === "string" ? details.platform : "UNKNOWN",
            topic: typeof details.topic === "string" ? details.topic : "unknown",
            status: typeof details.status === "string" ? details.status : "unknown",
            message:
              typeof details.message === "string" ? details.message : "No message",
            receivedAt: entry.createdAt.toISOString(),
          };
        }),
      },
    });
  } catch (error) {
    console.error("[scheduler/status] GET failed", error);
    return NextResponse.json(
      { error: "Failed to fetch scheduler status" },
      { status: 500 },
    );
  }
}
