import { db } from "@/lib/db";
import { planScheduledSyncs, type SchedulerPlanItem } from "@/lib/services/sync-scheduler";
import type { Prisma } from "@prisma/client";
import {
  formatCooldownRetryAt,
  getEbayRateLimitCooldownUntil,
  isEbayUsageLimitMessage,
} from "@/lib/services/ebay-rate-limit";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";

export type MonitorHealthStatus = "healthy" | "delayed" | "attention";
export type WebhookMonitorStatus = "ok" | "quiet" | "missing" | "n/a";

export interface IntegrationHealthSnapshot {
  integrationId: string;
  label: string;
  platform: string;
  status: MonitorHealthStatus;
  syncStatus: "fresh" | "delayed" | "stale" | "never";
  syncMessage: string;
  lastSyncAt: string | null;
  minutesSinceSync: number | null;
  intervalMinutes: number;
  due: boolean;
  running: boolean;
  nextDueAt: string | null;
  webhookExpected: boolean;
  lastWebhookAt: string | null;
  minutesSinceWebhook: number | null;
  webhookStatus: WebhookMonitorStatus;
  webhookMessage: string;
  recommendedAction: string;
  combinedStatus: MonitorHealthStatus;
}

export interface AutomationHealthSummary {
  status: MonitorHealthStatus;
  healthyCount: number;
  delayedCount: number;
  attentionCount: number;
  missingWebhookCount: number;
  headline: string;
  detail: string;
  recommendedAction: string;
  affectedLabels: string[];
}

export interface AutomationHealthSnapshot {
  integrationHealth: IntegrationHealthSnapshot[];
  summary: AutomationHealthSummary;
}

const WEBHOOK_PLATFORMS = new Set(["SHOPIFY", "BIGCOMMERCE"]);

function minutesBetween(now: Date, earlier: Date | null) {
  if (!earlier) return null;
  return Math.max(0, Math.floor((now.getTime() - earlier.getTime()) / 60000));
}

function formatMinutesLabel(totalMinutes: number) {
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function getGraceMinutes(intervalMinutes: number) {
  return Math.max(15, Math.min(60, Math.round(intervalMinutes * 0.25)));
}

function formatLabelList(labels: string[]) {
  if (labels.length <= 1) return labels.join("");
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function getPlatformDisplayName(platform: string) {
  if (platform === "SHOPIFY") return "Shopify";
  if (platform === "BIGCOMMERCE") return "BigCommerce";
  if (platform === "TPP_EBAY" || platform === "TT_EBAY") return "eBay";
  return platform;
}

function summarizeSyncJobError(errors: Prisma.JsonValue | null): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0];
  if (
    first &&
    typeof first === "object" &&
    !Array.isArray(first) &&
    "message" in first &&
    typeof (first as { message?: unknown }).message === "string"
  ) {
    return (first as { message: string }).message;
  }

  if (typeof first === "string") return first;
  return null;
}

function getWebhookTroubleshootingAction(platform: string) {
  if (platform === "SHOPIFY") {
    return "Check the Shopify webhook destination, signing secret, and recent delivery attempts in Integrations and the Shopify admin.";
  }

  if (platform === "BIGCOMMERCE") {
    return "Check the BigCommerce webhook destination, webhook secret, and recent delivery attempts in Integrations and the BigCommerce control panel.";
  }

  return "Check the webhook destination, secret, and recent delivery attempts for this store.";
}

function getSyncHealthStatus(
  planItem: SchedulerPlanItem,
  lastSyncAt: Date | null,
  now: Date,
) {
  if (!lastSyncAt) {
    return {
      status: "attention" as const,
      syncStatus: "never" as const,
      minutesSinceSync: null,
      syncMessage: "No completed pull recorded yet.",
    };
  }

  const minutesSinceSync = minutesBetween(now, lastSyncAt) ?? 0;
  const graceMinutes = getGraceMinutes(planItem.intervalMinutes);
  const delayedThreshold = planItem.intervalMinutes + graceMinutes;
  const attentionThreshold = planItem.intervalMinutes * 2 + graceMinutes;

  if (minutesSinceSync > attentionThreshold) {
    return {
      status: "attention" as const,
      syncStatus: "stale" as const,
      minutesSinceSync,
      syncMessage: `Last completed pull was ${formatMinutesLabel(minutesSinceSync)} ago.`,
    };
  }

  if (minutesSinceSync > delayedThreshold) {
    return {
      status: "delayed" as const,
      syncStatus: "delayed" as const,
      minutesSinceSync,
      syncMessage: `Last completed pull was ${formatMinutesLabel(minutesSinceSync)} ago.`,
    };
  }

  return {
    status: "healthy" as const,
    syncStatus: "fresh" as const,
    minutesSinceSync,
    syncMessage: planItem.running
      ? "A fresh pull is running now."
      : `Last completed pull was ${formatMinutesLabel(minutesSinceSync)} ago.`,
  };
}

function getWebhookHealthStatus(
  platform: string,
  intervalMinutes: number,
  lastWebhookAt: Date | null,
  now: Date,
) {
  if (!WEBHOOK_PLATFORMS.has(platform)) {
    return {
      webhookExpected: false,
      webhookStatus: "n/a" as const,
      minutesSinceWebhook: null,
      webhookMessage: "This store relies on scheduled pulls, not change notices.",
    };
  }

  if (!lastWebhookAt) {
    return {
      webhookExpected: true,
      webhookStatus: "missing" as const,
      minutesSinceWebhook: null,
      webhookMessage:
        "No store change notice has been recorded yet. Scheduled pulls are still the safety net.",
    };
  }

  const minutesSinceWebhook = minutesBetween(now, lastWebhookAt) ?? 0;
  const quietThreshold = Math.max(intervalMinutes * 3, 12 * 60);
  const missingThreshold = Math.max(intervalMinutes * 6, 24 * 60);

  if (minutesSinceWebhook > missingThreshold) {
    return {
      webhookExpected: true,
      webhookStatus: "missing" as const,
      minutesSinceWebhook,
      webhookMessage: `No change notice in ${formatMinutesLabel(minutesSinceWebhook)}. Check webhook delivery for this store.`,
    };
  }

  if (minutesSinceWebhook > quietThreshold) {
    return {
      webhookExpected: true,
      webhookStatus: "quiet" as const,
      minutesSinceWebhook,
      webhookMessage: `No change notice in ${formatMinutesLabel(minutesSinceWebhook)}. That can be normal if the store was quiet.`,
    };
  }

  return {
    webhookExpected: true,
    webhookStatus: "ok" as const,
    minutesSinceWebhook,
    webhookMessage: `Recent change notice arrived ${formatMinutesLabel(minutesSinceWebhook)} ago.`,
  };
}

function getRecommendedAction(args: {
  label: string;
  platform: string;
  due: boolean;
  running: boolean;
  syncStatus: IntegrationHealthSnapshot["syncStatus"];
  syncMonitorStatus: MonitorHealthStatus;
  webhookExpected: boolean;
  webhookStatus: WebhookMonitorStatus;
  rateLimitCooldownUntil?: Date | null;
}) {
  const platformLabel = getPlatformDisplayName(args.platform);
  const cooldownLabel = formatCooldownRetryAt(args.rateLimitCooldownUntil ?? null);

  if (args.rateLimitCooldownUntil) {
    return cooldownLabel
      ? `Wait for the eBay cooldown window to end around ${cooldownLabel}. After that, let the next automatic check retry or run one manual pull from Sync.`
      : "Wait for the eBay cooldown window to end, then let the next automatic check retry or run one manual pull from Sync.";
  }

  if (args.syncStatus === "never") {
    return "Run a manual pull from Sync so this store records its first completed update.";
  }

  if (args.syncMonitorStatus === "attention") {
    if (args.running) {
      return "A pull is already running. Let it finish, then check Sync or Errors if this store still needs attention.";
    }
    if (args.due) {
      return "Start a manual pull from Sync now. If it still fails, check Errors and the integration credentials.";
    }
    return "Open Sync and run a manual pull. If this store stays behind after that, check Errors and the integration credentials.";
  }

  if (args.syncMonitorStatus === "delayed") {
    if (args.running) {
      return "A pull is already running. Refresh Sync after it finishes to confirm this store recovers.";
    }
    if (args.due) {
      return "This store is due now. Let the next automatic check start it, or run a manual pull from Sync if you need it refreshed immediately.";
    }
    return "Watch the next automatic check. If this store stays behind, run a manual pull from Sync.";
  }

  if (args.webhookExpected && args.webhookStatus === "missing") {
    return `Scheduled pulls are still covering this store. ${getWebhookTroubleshootingAction(args.platform)}`;
  }

  if (args.webhookExpected && args.webhookStatus === "quiet") {
    return `No immediate action is needed unless you expected recent ${platformLabel} changes to wake an early refresh. If you did, ${getWebhookTroubleshootingAction(args.platform).charAt(0).toLowerCase()}${getWebhookTroubleshootingAction(args.platform).slice(1)}`;
  }

  return "No action needed.";
}

export async function buildAutomationHealthSnapshot(
  plan: SchedulerPlanItem[],
  now = new Date(),
): Promise<AutomationHealthSnapshot> {
  const [integrations, recentWebhookEntries, recentFailedJobs] = await Promise.all([
    db.integration.findMany({
      where: { enabled: true },
      orderBy: { platform: "asc" },
      select: {
        id: true,
        label: true,
        platform: true,
        lastSyncAt: true,
        config: true,
      },
    }),
    db.auditLog.findMany({
      where: { action: "webhook_received" },
      orderBy: { createdAt: "desc" },
      take: 5000,
      select: {
        createdAt: true,
        details: true,
      },
    }),
    db.syncJob.findMany({
      where: { status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        integrationId: true,
        completedAt: true,
        startedAt: true,
        createdAt: true,
        errors: true,
      },
    }),
  ]);

  const lastWebhookByPlatform = new Map<string, Date>();
  for (const entry of recentWebhookEntries) {
    const details = (entry.details as Record<string, unknown>) ?? {};
    const platform = typeof details.platform === "string" ? details.platform : null;
    if (!platform || lastWebhookByPlatform.has(platform)) continue;
    lastWebhookByPlatform.set(platform, entry.createdAt);
  }

  const integrationMap = new Map(integrations.map((integration) => [integration.id, integration]));
  const latestFailedJobByIntegration = new Map<
    string,
    { failedAt: Date; message: string | null }
  >();
  for (const job of recentFailedJobs) {
    if (latestFailedJobByIntegration.has(job.integrationId)) continue;
    latestFailedJobByIntegration.set(job.integrationId, {
      failedAt: job.completedAt ?? job.startedAt ?? job.createdAt,
      message: summarizeSyncJobError(job.errors),
    });
  }
  const statusRank: Record<MonitorHealthStatus, number> = {
    attention: 0,
    delayed: 1,
    healthy: 2,
  };

  const integrationHealth = plan
    .filter((item) => integrationMap.has(item.integrationId))
    .map((item) => {
      const integration = integrationMap.get(item.integrationId)!;
      const lastSyncAt = integration.lastSyncAt;
      const lastWebhookAt = lastWebhookByPlatform.get(integration.platform) ?? null;
      const storedConfig = getIntegrationConfig(integration);
      const sync = getSyncHealthStatus(item, lastSyncAt, now);
      const recentFailure = latestFailedJobByIntegration.get(integration.id);
      const rateLimitCooldownUntil =
        item.reason.toLowerCase().includes("ebay") && item.nextDueAt
          ? new Date(item.nextDueAt)
          : getEbayRateLimitCooldownUntil(
              integration.platform,
              storedConfig,
              now,
            );
      const failedAfterLastSuccess =
        recentFailure &&
        (!lastSyncAt || recentFailure.failedAt.getTime() > lastSyncAt.getTime());
      const syncMonitor = failedAfterLastSuccess
        ? {
            ...sync,
            status: "attention" as const,
            syncStatus: "stale" as const,
            syncMessage:
              recentFailure.message && isEbayUsageLimitMessage(recentFailure.message)
                ? rateLimitCooldownUntil
                  ? `Latest pull hit eBay API usage limits. Next retry window opens around ${formatCooldownRetryAt(rateLimitCooldownUntil) ?? "the next automatic check"}.`
                  : "Latest pull hit eBay API usage limits. The next retry should happen after the cooldown window."
                : recentFailure.message
                  ? `Latest pull failed: ${recentFailure.message}`
                  : "Latest pull failed before this store recorded a newer successful update.",
          }
        : sync;
      const webhook = getWebhookHealthStatus(
        integration.platform,
        item.intervalMinutes,
        lastWebhookAt,
        now,
      );
      const combinedStatus =
        webhook.webhookStatus === "missing"
          ? syncMonitor.status === "healthy"
            ? "delayed"
            : "attention"
          : syncMonitor.status;
      const recommendedAction = getRecommendedAction({
        label: integration.label,
        platform: integration.platform,
        due: item.due,
        running: item.running,
        syncStatus: syncMonitor.syncStatus,
        syncMonitorStatus: syncMonitor.status,
        webhookExpected: webhook.webhookExpected,
        webhookStatus: webhook.webhookStatus,
        rateLimitCooldownUntil,
      });

      return {
        integrationId: integration.id,
        label: integration.label,
        platform: integration.platform,
        status: syncMonitor.status,
        syncStatus: syncMonitor.syncStatus,
        syncMessage: syncMonitor.syncMessage,
        lastSyncAt: lastSyncAt?.toISOString() ?? null,
        minutesSinceSync: syncMonitor.minutesSinceSync,
        intervalMinutes: item.intervalMinutes,
        due: item.due,
        running: item.running,
        nextDueAt: item.nextDueAt,
        webhookExpected: webhook.webhookExpected,
        lastWebhookAt: lastWebhookAt?.toISOString() ?? null,
        minutesSinceWebhook: webhook.minutesSinceWebhook,
        webhookStatus: webhook.webhookStatus,
        webhookMessage: webhook.webhookMessage,
        recommendedAction,
        combinedStatus,
      } satisfies IntegrationHealthSnapshot;
    })
    .sort((a, b) => {
      if (statusRank[a.combinedStatus] !== statusRank[b.combinedStatus]) {
        return statusRank[a.combinedStatus] - statusRank[b.combinedStatus];
      }
      return a.label.localeCompare(b.label);
    });

  const healthyCount = integrationHealth.filter((item) => item.combinedStatus === "healthy").length;
  const delayedCount = integrationHealth.filter((item) => item.combinedStatus === "delayed").length;
  const attentionCount = integrationHealth.filter((item) => item.combinedStatus === "attention").length;
  const attentionItems = integrationHealth.filter((item) => item.combinedStatus === "attention");
  const attentionLabels = integrationHealth
    .filter((item) => item.combinedStatus === "attention")
    .map((item) => item.label);
  const delayedLabels = integrationHealth
    .filter((item) => item.combinedStatus === "delayed")
    .map((item) => item.label);
  const missingWebhookCount = integrationHealth.filter(
    (item) => item.webhookStatus === "missing",
  ).length;
  const delayedSyncLabels = integrationHealth
    .filter((item) => item.status === "delayed")
    .map((item) => item.label);
  const missingWebhookLabels = integrationHealth
    .filter((item) => item.webhookStatus === "missing")
    .map((item) => item.label);

  let summary: AutomationHealthSummary;
  if (attentionCount > 0) {
    const labels = formatLabelList(attentionLabels);
    const allAttentionItemsCoolingDown =
      attentionItems.length > 0 &&
      attentionItems.every((item) =>
        item.recommendedAction.startsWith("Wait for the eBay cooldown window"),
      );
    summary = {
      status: "attention",
      healthyCount,
      delayedCount,
      attentionCount,
      missingWebhookCount,
      headline: "Attention needed",
      detail:
        allAttentionItemsCoolingDown
          ? `${labels} are cooling down after eBay API call-limit responses.`
          : missingWebhookCount > 0
          ? `${labels} need fresher completed pulls or webhook follow-up.`
          : `${labels} need fresher completed pulls.`,
      recommendedAction: allAttentionItemsCoolingDown
        ? attentionItems.length === 1
          ? attentionItems[0]?.recommendedAction ?? "Wait for the cooldown window to end before retrying."
          : `Wait for the eBay cooldown windows to end for ${labels}, then let the next automatic checks retry or run one manual pull per store afterward if needed.`
        : attentionLabels.length === 1
          ? `Open Sync or Errors and run a manual pull for ${labels}. If it still falls behind, review credentials and webhook delivery.`
          : `Open Sync or Errors and run manual pulls for ${labels}. If any store still falls behind, review credentials and webhook delivery.`,
      affectedLabels: attentionLabels,
    };
  } else if (delayedCount > 0) {
    const labels = formatLabelList(delayedLabels);
    const onlyWebhookCoverageIssue =
      delayedSyncLabels.length === 0 && missingWebhookLabels.length > 0;
    summary = {
      status: "delayed",
      healthyCount,
      delayedCount,
      attentionCount,
      missingWebhookCount,
      headline: "Running behind",
      detail: onlyWebhookCoverageIssue
        ? `${labels} are still refreshing on schedule, but their store change notices have gone quiet.`
        : `${labels} are behind their usual pull window.`,
      recommendedAction: onlyWebhookCoverageIssue
        ? `Check the webhook destination, signing secret, and recent delivery attempts for ${labels} so early refreshes can resume.`
        : `Watch the next automatic check for ${labels}. If they stay behind, run a manual pull from Sync.`,
      affectedLabels: delayedLabels,
    };
  } else {
    summary = {
      status: "healthy",
      healthyCount,
      delayedCount,
      attentionCount,
      missingWebhookCount,
      headline: "Healthy",
      detail: "All connected stores are refreshing within their expected window.",
      recommendedAction: "No action needed.",
      affectedLabels: [],
    };
  }

  return { integrationHealth, summary };
}

export async function getAutomationHealthSnapshot(now = new Date()) {
  const plan = await planScheduledSyncs(now);
  return buildAutomationHealthSnapshot(plan, now);
}
