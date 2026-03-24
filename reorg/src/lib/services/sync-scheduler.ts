import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import {
  getIntegrationConfig,
  type SyncMode,
} from "@/lib/integrations/runtime-config";
import { startIntegrationSync, resolveIntegrationSyncModes } from "@/lib/services/sync-control";
import { failStaleRunningJob, isRunningJobStale } from "@/lib/services/sync-jobs";
import {
  getCurrentSyncIntervalMinutes,
  getEbayRateLimitCooldownUntil,
} from "@/lib/services/ebay-rate-limit";
import {
  getEbayCredentialFingerprint,
  getEbayCooldownUntilFromSnapshot,
  getEbayTradingRateLimitSnapshotForIntegration,
} from "@/lib/services/ebay-analytics";
import {
  formatEbayAutoSyncSchedule,
  getEbayAutoSyncIntervalMinutes,
  getNextEbayAutoSyncAt,
} from "@/lib/services/ebay-sync-policy";

export interface SchedulerPlanItem {
  integrationId: string;
  platform: string;
  label: string;
  autoSyncEnabled: boolean;
  due: boolean;
  running: boolean;
  intervalMinutes: number;
  requestedMode: SyncMode;
  effectiveMode: SyncMode;
  fallbackReason: string | null;
  lastScheduledSyncAt: string | null;
  nextDueAt: string | null;
  minutesUntilDue: number | null;
  reason: string;
}

function getLastScheduledRunAt(config: ReturnType<typeof getIntegrationConfig>): Date | null {
  if (!config.syncState.lastScheduledSyncAt) return null;
  const parsed = new Date(config.syncState.lastScheduledSyncAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getNextDueAt(
  now: Date,
  lastRunAt: Date | null,
  intervalMinutes: number,
  due: boolean,
) {
  if (due) return now;
  if (!lastRunAt) return null;

  return new Date(lastRunAt.getTime() + intervalMinutes * 60 * 1000);
}

function getMinutesUntilDue(now: Date, nextDueAt: Date | null) {
  if (!nextDueAt) return null;
  return Math.max(0, Math.ceil((nextDueAt.getTime() - now.getTime()) / 60000));
}

export async function planScheduledSyncs(now = new Date()) {
  const [integrations, runningJobs] = await Promise.all([
    db.integration.findMany({ orderBy: { platform: "asc" } }),
    db.syncJob.findMany({
      where: { status: "RUNNING" },
      select: {
        id: true,
        integrationId: true,
        createdAt: true,
        startedAt: true,
        itemsProcessed: true,
        errors: true,
      },
    }),
  ]);

  const activeRunningJobs = [];
  for (const job of runningJobs) {
    if (isRunningJobStale(job, now)) {
      await failStaleRunningJob(
        job,
        "Marked failed automatically because the sync job exceeded the stale running threshold.",
      );
      continue;
    }

    activeRunningJobs.push(job);
  }

  const runningIds = new Set(activeRunningJobs.map((job) => job.integrationId));
  const ebaySnapshots = new Map<string, Awaited<ReturnType<typeof getEbayTradingRateLimitSnapshotForIntegration>>>();
  await Promise.all(
    integrations.map(async (integration) => {
      if (integration.platform !== "TPP_EBAY" && integration.platform !== "TT_EBAY") {
        return;
      }
      try {
        const snapshot = await getEbayTradingRateLimitSnapshotForIntegration(integration);
        ebaySnapshots.set(integration.id, snapshot);
      } catch (error) {
        console.error(`[sync-scheduler] ${integration.platform} analytics lookup failed`, error);
      }
    }),
  );

  const items: SchedulerPlanItem[] = integrations.map((integration) => {
    const config = getIntegrationConfig(integration);
    const ebayIntervalMinutes =
      integration.platform === "TPP_EBAY" || integration.platform === "TT_EBAY"
        ? getEbayAutoSyncIntervalMinutes(now, config.syncProfile.timezone)
        : null;
    const intervalMinutes = getCurrentSyncIntervalMinutes(
      now,
      config,
      integration.platform,
    );
    const lastRunAt = getLastScheduledRunAt(config);
    const minutesSinceLastRun =
      lastRunAt == null
        ? Number.POSITIVE_INFINITY
        : (now.getTime() - lastRunAt.getTime()) / 60000;
    const modes = resolveIntegrationSyncModes(
      integration,
      config.syncProfile.preferredMode,
    );

    if (!integration.enabled) {
      const nextDueAt = getNextDueAt(now, lastRunAt, intervalMinutes, false);
      return {
        integrationId: integration.id,
        platform: integration.platform,
        label: integration.label,
        autoSyncEnabled: config.syncProfile.autoSyncEnabled,
        due: false,
        running: false,
        intervalMinutes,
        requestedMode: modes.requestedMode,
        effectiveMode: modes.effectiveMode,
        fallbackReason: modes.fallbackReason,
        lastScheduledSyncAt: config.syncState.lastScheduledSyncAt,
        nextDueAt: nextDueAt?.toISOString() ?? null,
        minutesUntilDue: getMinutesUntilDue(now, nextDueAt),
        reason: "Integration is not connected.",
      };
    }

    if (!config.syncProfile.autoSyncEnabled) {
      const nextDueAt = getNextDueAt(now, lastRunAt, intervalMinutes, false);
      return {
        integrationId: integration.id,
        platform: integration.platform,
        label: integration.label,
        autoSyncEnabled: false,
        due: false,
        running: false,
        intervalMinutes,
        requestedMode: modes.requestedMode,
        effectiveMode: modes.effectiveMode,
        fallbackReason: modes.fallbackReason,
        lastScheduledSyncAt: config.syncState.lastScheduledSyncAt,
        nextDueAt: nextDueAt?.toISOString() ?? null,
        minutesUntilDue: getMinutesUntilDue(now, nextDueAt),
        reason: "Auto sync is disabled for this integration.",
      };
    }

    if (
      (integration.platform === "TPP_EBAY" || integration.platform === "TT_EBAY") &&
      ebayIntervalMinutes == null
    ) {
      const nextDueAt = getNextEbayAutoSyncAt(now, config.syncProfile.timezone);
      return {
        integrationId: integration.id,
        platform: integration.platform,
        label: integration.label,
        autoSyncEnabled: true,
        due: false,
        running: false,
        intervalMinutes,
        requestedMode: modes.requestedMode,
        effectiveMode: modes.effectiveMode,
        fallbackReason: modes.fallbackReason,
        lastScheduledSyncAt: config.syncState.lastScheduledSyncAt,
        nextDueAt: nextDueAt.toISOString(),
        minutesUntilDue: getMinutesUntilDue(now, nextDueAt),
        reason: `Paused outside eBay business hours. ${formatEbayAutoSyncSchedule()}.`,
      };
    }

    if (runningIds.has(integration.id)) {
      const nextDueAt = getNextDueAt(now, lastRunAt, intervalMinutes, false);
      return {
        integrationId: integration.id,
        platform: integration.platform,
        label: integration.label,
        autoSyncEnabled: true,
        due: false,
        running: true,
        intervalMinutes,
        requestedMode: modes.requestedMode,
        effectiveMode: modes.effectiveMode,
        fallbackReason: modes.fallbackReason,
        lastScheduledSyncAt: config.syncState.lastScheduledSyncAt,
        nextDueAt: nextDueAt?.toISOString() ?? null,
        minutesUntilDue: getMinutesUntilDue(now, nextDueAt),
        reason: "A sync job is already running.",
      };
    }

    const liveRateLimitCooldownUntil = getEbayCooldownUntilFromSnapshot(
      ebaySnapshots.get(integration.id) ?? null,
      config.syncState.lastRateLimitMessage,
      now,
    );
    const rateLimitCooldownUntil = liveRateLimitCooldownUntil ?? getEbayRateLimitCooldownUntil(
      integration.platform,
      config,
      now,
    );
    if (rateLimitCooldownUntil) {
      return {
        integrationId: integration.id,
        platform: integration.platform,
        label: integration.label,
        autoSyncEnabled: true,
        due: false,
        running: false,
        intervalMinutes,
        requestedMode: modes.requestedMode,
        effectiveMode: modes.effectiveMode,
        fallbackReason: modes.fallbackReason,
        lastScheduledSyncAt: config.syncState.lastScheduledSyncAt,
        nextDueAt: rateLimitCooldownUntil.toISOString(),
        minutesUntilDue: getMinutesUntilDue(now, rateLimitCooldownUntil),
        reason: liveRateLimitCooldownUntil
          ? "Waiting for the eBay Trading API reset window based on live Analytics API usage data."
          : "Cooling down after an eBay API usage-limit response before the next retry.",
      };
    }

    if (minutesSinceLastRun < intervalMinutes) {
      const nextDueAt = getNextDueAt(now, lastRunAt, intervalMinutes, false);
      return {
        integrationId: integration.id,
        platform: integration.platform,
        label: integration.label,
        autoSyncEnabled: true,
        due: false,
        running: false,
        intervalMinutes,
        requestedMode: modes.requestedMode,
        effectiveMode: modes.effectiveMode,
        fallbackReason: modes.fallbackReason,
        lastScheduledSyncAt: config.syncState.lastScheduledSyncAt,
        nextDueAt: nextDueAt?.toISOString() ?? null,
        minutesUntilDue: getMinutesUntilDue(now, nextDueAt),
        reason: `Next run is not due yet (${Math.floor(minutesSinceLastRun)} / ${intervalMinutes} minutes).`,
      };
    }

    const nextDueAt = getNextDueAt(now, lastRunAt, intervalMinutes, true);
    return {
      integrationId: integration.id,
      platform: integration.platform,
      label: integration.label,
      autoSyncEnabled: true,
      due: true,
      running: false,
      intervalMinutes,
      requestedMode: modes.requestedMode,
      effectiveMode: modes.effectiveMode,
      fallbackReason: modes.fallbackReason,
      lastScheduledSyncAt: config.syncState.lastScheduledSyncAt,
      nextDueAt: nextDueAt?.toISOString() ?? null,
      minutesUntilDue: getMinutesUntilDue(now, nextDueAt),
      reason: "Integration is due for a scheduled pull.",
    };
  });

  const integrationById = new Map(integrations.map((integration) => [integration.id, integration]));
  const ebayDueGroups = new Map<string, Array<{ index: number; item: SchedulerPlanItem }>>();
  items.forEach((item, index) => {
    if (!item.due || (item.platform !== "TPP_EBAY" && item.platform !== "TT_EBAY")) {
      return;
    }
    const integration = integrationById.get(item.integrationId);
    const groupKey =
      (integration && getEbayCredentialFingerprint(integration)) ?? `platform:${item.platform}`;
    const group = ebayDueGroups.get(groupKey) ?? [];
    group.push({ index, item });
    ebayDueGroups.set(groupKey, group);
  });

  for (const group of ebayDueGroups.values()) {
    group.sort((a, b) => {
      const integrationA = integrationById.get(a.item.integrationId);
      const integrationB = integrationById.get(b.item.integrationId);
      const lastSyncA = integrationA?.lastSyncAt?.getTime() ?? 0;
      const lastSyncB = integrationB?.lastSyncAt?.getTime() ?? 0;
      if (lastSyncA !== lastSyncB) return lastSyncA - lastSyncB;
      return a.item.label.localeCompare(b.item.label);
    });

    for (let i = 1; i < group.length; i += 1) {
      const { index } = group[i];
      const delayedUntil = new Date(now.getTime() + 15 * 60 * 1000);
      items[index] = {
        ...items[index],
        due: false,
        nextDueAt: delayedUntil.toISOString(),
        minutesUntilDue: 15,
        reason:
          "Queued behind another eBay store that shares the same Trading API quota window.",
      };
    }
  }

  return items;
}

export async function executeScheduledSyncs(now = new Date()) {
  const plan = await planScheduledSyncs(now);
  const dueItems = plan.filter((item) => item.due);
  const dispatched = [];

  for (const item of dueItems) {
    const integration = await db.integration.findUnique({
      where: { id: item.integrationId },
    });

    if (!integration) continue;

    const result = await startIntegrationSync(integration, {
      requestedMode: item.requestedMode,
      triggerSource: "scheduler",
    }, "inline");

    const config = getIntegrationConfig(integration);
    const nextConfig = {
      ...config,
      syncState: {
        ...config.syncState,
        lastScheduledSyncAt: now.toISOString(),
      },
    };

    await db.integration.update({
      where: { id: integration.id },
      data: { config: nextConfig as unknown as Prisma.InputJsonValue },
    });

    dispatched.push(result);
  }

  return { plan, dispatched };
}
