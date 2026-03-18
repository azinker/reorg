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
      select: { id: true, integrationId: true, createdAt: true, startedAt: true, errors: true },
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

  const items: SchedulerPlanItem[] = integrations.map((integration) => {
    const config = getIntegrationConfig(integration);
    const intervalMinutes = getCurrentSyncIntervalMinutes(now, config);
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

    const rateLimitCooldownUntil = getEbayRateLimitCooldownUntil(
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
        reason: "Cooling down after an eBay API usage-limit response before the next retry.",
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

  const ebayDueIndexes = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.due && (item.platform === "TPP_EBAY" || item.platform === "TT_EBAY"))
    .sort((a, b) => a.item.label.localeCompare(b.item.label));

  for (let i = 1; i < ebayDueIndexes.length; i += 1) {
    const { index } = ebayDueIndexes[i];
    const delayedUntil = new Date(now.getTime() + 15 * 60 * 1000);
    items[index] = {
      ...items[index],
      due: false,
      nextDueAt: delayedUntil.toISOString(),
      minutesUntilDue: 15,
      reason: "Delayed to the next scheduler tick to avoid eBay Trading API rate-limit spikes.",
    };
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
