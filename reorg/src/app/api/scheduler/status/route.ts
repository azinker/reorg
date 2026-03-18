import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { planScheduledSyncs } from "@/lib/services/sync-scheduler";

type SchedulerOutcome = "dry_run" | "completed" | "failed";

function asOutcome(value: unknown): SchedulerOutcome | null {
  return value === "dry_run" || value === "completed" || value === "failed"
    ? value
    : null;
}

export async function GET() {
  try {
    const [settings, recentJobsRaw, recentWebhooks, automationEvents, plan] = await Promise.all([
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
        take: 20,
        include: {
          integration: {
            select: {
              id: true,
              platform: true,
              label: true,
              lastSyncAt: true,
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
      db.auditLog.findMany({
        where: {
          action: {
            in: [
              "scheduler_tick",
              "webhook_received",
              "webhook_reconcile_completed",
              "webhook_reconcile_failed",
              "sync_stale_failed",
            ],
          },
        },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
      planScheduledSyncs(),
    ]);

    const map = Object.fromEntries(settings.map((setting) => [setting.key, setting.value]));
    const planLabelMap = new Map(plan.map((item) => [item.integrationId, item.label]));
    const latestJobByIntegration = new Map<string, (typeof recentJobsRaw)[number]>();
    for (const job of recentJobsRaw) {
      const integrationId = job.integration?.id;
      if (!integrationId || latestJobByIntegration.has(integrationId)) continue;
      latestJobByIntegration.set(integrationId, job);
    }
    const recentJobs = [...latestJobByIntegration.values()];
    const orderedPlan = [...plan].sort((a, b) => {
      if (a.due !== b.due) return a.due ? -1 : 1;
      if (a.running !== b.running) return a.running ? -1 : 1;
      if (a.nextDueAt && b.nextDueAt) {
        return new Date(a.nextDueAt).getTime() - new Date(b.nextDueAt).getTime();
      }
      if (a.nextDueAt) return -1;
      if (b.nextDueAt) return 1;
      return a.label.localeCompare(b.label);
    });

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
          latestStoreSyncAt: job.integration?.lastSyncAt?.toISOString() ?? null,
          recoveredAfterScheduledFailure:
            job.status === "FAILED" &&
            !!job.integration?.lastSyncAt &&
            !!job.completedAt &&
            job.integration.lastSyncAt.getTime() > job.completedAt.getTime(),
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
        dueNowCount: orderedPlan.filter((item) => item.due).length,
        upcoming: orderedPlan.map((item) => ({
          integrationId: item.integrationId,
          platform: item.platform,
          label: item.label,
          due: item.due,
          running: item.running,
          requestedMode: item.requestedMode,
          effectiveMode: item.effectiveMode,
          intervalMinutes: item.intervalMinutes,
          lastScheduledSyncAt: item.lastScheduledSyncAt,
          nextDueAt: item.nextDueAt,
          minutesUntilDue: item.minutesUntilDue,
          reason: item.reason,
          fallbackReason: item.fallbackReason,
        })),
        automationEvents: automationEvents.map((entry) => {
          const details = (entry.details as Record<string, unknown>) ?? {};

          if (entry.action === "scheduler_tick") {
            return {
              id: entry.id,
              type: "scheduler_tick",
              title: "Scheduler tick",
              status:
                details.outcome === "failed"
                  ? "failed"
                  : details.outcome === "dry_run"
                    ? "dry_run"
                    : "completed",
              platform: null,
              detail: `Due ${typeof details.dueCount === "number" ? details.dueCount : 0}, dispatched ${typeof details.dispatchedCount === "number" ? details.dispatchedCount : 0}`,
              occurredAt: entry.createdAt.toISOString(),
            };
          }

          if (
            entry.action === "webhook_reconcile_completed" ||
            entry.action === "webhook_reconcile_failed"
          ) {
            const isFailed = entry.action === "webhook_reconcile_failed";
            const platform =
              typeof details.platform === "string" ? details.platform : null;
            const productCount =
              typeof details.productCount === "number" ? details.productCount : 0;
            const deletedProductCount =
              typeof details.deletedProductCount === "number"
                ? details.deletedProductCount
                : 0;
            const changedVariantCount =
              typeof details.changedVariantCount === "number"
                ? details.changedVariantCount
                : 0;
            const itemsProcessed =
              typeof details.itemsProcessed === "number"
                ? details.itemsProcessed
                : 0;
            const prunedListings =
              typeof details.prunedListings === "number"
                ? details.prunedListings
                : 0;
            const durationMs =
              typeof details.durationMs === "number" ? details.durationMs : null;

            return {
              id: entry.id,
              type: "webhook",
              title: isFailed
                ? "Webhook reconcile failed"
                : "Webhook reconcile completed",
              status: isFailed ? "failed" : "completed",
              platform,
              detail: isFailed
                ? typeof details.error === "string"
                  ? details.error
                  : "Targeted webhook reconcile failed."
                : `Products ${productCount}, deletes ${deletedProductCount}, variants ${changedVariantCount}, processed ${itemsProcessed}, pruned ${prunedListings}${durationMs != null ? ` in ${Math.max(0, Math.round(durationMs / 1000))}s` : ""}`,
              occurredAt: entry.createdAt.toISOString(),
            };
          }

          if (entry.action === "sync_stale_failed") {
            return {
              id: entry.id,
              type: "stale_job",
              title: "Stale sync auto-failed",
              status: "warning",
              platform:
                typeof details.integrationId === "string"
                  ? planLabelMap.get(details.integrationId) ?? details.integrationId
                  : null,
              detail:
                typeof details.reason === "string"
                  ? details.reason
                  : "A stale running sync job was marked failed automatically.",
              occurredAt: entry.createdAt.toISOString(),
            };
          }

          return {
            id: entry.id,
            type: "webhook",
            title:
              typeof details.topic === "string"
                ? details.topic
                : "Webhook received",
            status:
              typeof details.status === "string" ? details.status : "unknown",
            platform:
              typeof details.platform === "string" ? details.platform : null,
            detail:
              typeof details.message === "string"
                ? details.message
                : "Webhook event recorded.",
            occurredAt: entry.createdAt.toISOString(),
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
