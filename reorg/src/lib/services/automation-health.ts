import { db } from "@/lib/db";
import { planScheduledSyncs, type SchedulerPlanItem } from "@/lib/services/sync-scheduler";

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
}

export interface AutomationHealthSummary {
  status: MonitorHealthStatus;
  healthyCount: number;
  delayedCount: number;
  attentionCount: number;
  headline: string;
  detail: string;
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

export async function buildAutomationHealthSnapshot(
  plan: SchedulerPlanItem[],
  now = new Date(),
): Promise<AutomationHealthSnapshot> {
  const integrations = await db.integration.findMany({
    where: { enabled: true },
    orderBy: { platform: "asc" },
    select: {
      id: true,
      label: true,
      platform: true,
      lastSyncAt: true,
    },
  });

  const recentWebhookEntries = await db.auditLog.findMany({
    where: { action: "webhook_received" },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      createdAt: true,
      details: true,
    },
  });

  const lastWebhookByPlatform = new Map<string, Date>();
  for (const entry of recentWebhookEntries) {
    const details = (entry.details as Record<string, unknown>) ?? {};
    const platform = typeof details.platform === "string" ? details.platform : null;
    if (!platform || lastWebhookByPlatform.has(platform)) continue;
    lastWebhookByPlatform.set(platform, entry.createdAt);
  }

  const integrationMap = new Map(integrations.map((integration) => [integration.id, integration]));
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
      const sync = getSyncHealthStatus(item, lastSyncAt, now);
      const webhook = getWebhookHealthStatus(
        integration.platform,
        item.intervalMinutes,
        lastWebhookAt,
        now,
      );

      return {
        integrationId: integration.id,
        label: integration.label,
        platform: integration.platform,
        status: sync.status,
        syncStatus: sync.syncStatus,
        syncMessage: sync.syncMessage,
        lastSyncAt: lastSyncAt?.toISOString() ?? null,
        minutesSinceSync: sync.minutesSinceSync,
        intervalMinutes: item.intervalMinutes,
        due: item.due,
        running: item.running,
        nextDueAt: item.nextDueAt,
        webhookExpected: webhook.webhookExpected,
        lastWebhookAt: lastWebhookAt?.toISOString() ?? null,
        minutesSinceWebhook: webhook.minutesSinceWebhook,
        webhookStatus: webhook.webhookStatus,
        webhookMessage: webhook.webhookMessage,
      } satisfies IntegrationHealthSnapshot;
    })
    .sort((a, b) => {
      if (statusRank[a.status] !== statusRank[b.status]) {
        return statusRank[a.status] - statusRank[b.status];
      }
      return a.label.localeCompare(b.label);
    });

  const healthyCount = integrationHealth.filter((item) => item.status === "healthy").length;
  const delayedCount = integrationHealth.filter((item) => item.status === "delayed").length;
  const attentionCount = integrationHealth.filter((item) => item.status === "attention").length;
  const attentionLabels = integrationHealth
    .filter((item) => item.status === "attention")
    .map((item) => item.label);
  const delayedLabels = integrationHealth
    .filter((item) => item.status === "delayed")
    .map((item) => item.label);

  let summary: AutomationHealthSummary;
  if (attentionCount > 0) {
    summary = {
      status: "attention",
      healthyCount,
      delayedCount,
      attentionCount,
      headline: "Attention needed",
      detail: `${attentionLabels.join(", ")} need fresher completed pulls.`,
    };
  } else if (delayedCount > 0) {
    summary = {
      status: "delayed",
      healthyCount,
      delayedCount,
      attentionCount,
      headline: "Running behind",
      detail: `${delayedLabels.join(", ")} are behind their usual pull window.`,
    };
  } else {
    summary = {
      status: "healthy",
      healthyCount,
      delayedCount,
      attentionCount,
      headline: "Healthy",
      detail: "All connected stores are refreshing within their expected window.",
    };
  }

  return { integrationHealth, summary };
}

export async function getAutomationHealthSnapshot(now = new Date()) {
  const plan = await planScheduledSyncs(now);
  return buildAutomationHealthSnapshot(plan, now);
}
