import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import {
  getIntegrationConfig,
  type SyncMode,
} from "@/lib/integrations/runtime-config";
import { startIntegrationSync, resolveIntegrationSyncModes } from "@/lib/services/sync-control";

interface SchedulerPlanItem {
  integrationId: string;
  platform: string;
  label: string;
  autoSyncEnabled: boolean;
  due: boolean;
  intervalMinutes: number;
  requestedMode: SyncMode;
  effectiveMode: SyncMode;
  fallbackReason: string | null;
  reason: string;
}

function getHourInTimeZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  return hour ? parseInt(hour, 10) : date.getHours();
}

function getCurrentIntervalMinutes(date: Date, config: ReturnType<typeof getIntegrationConfig>): number {
  const hour = getHourInTimeZone(date, config.syncProfile.timezone);
  const isDaytime =
    hour >= config.syncProfile.dayStartHour &&
    hour < config.syncProfile.dayEndHour;

  return isDaytime
    ? config.syncProfile.dayIntervalMinutes
    : config.syncProfile.overnightIntervalMinutes;
}

function getLastScheduledRunAt(config: ReturnType<typeof getIntegrationConfig>): Date | null {
  if (!config.syncState.lastScheduledSyncAt) return null;
  const parsed = new Date(config.syncState.lastScheduledSyncAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function planScheduledSyncs(now = new Date()) {
  const [integrations, runningJobs] = await Promise.all([
    db.integration.findMany({ orderBy: { platform: "asc" } }),
    db.syncJob.findMany({
      where: { status: "RUNNING" },
      select: { integrationId: true },
    }),
  ]);

  const runningIds = new Set(runningJobs.map((job) => job.integrationId));

  const items: SchedulerPlanItem[] = integrations.map((integration) => {
    const config = getIntegrationConfig(integration);
    const intervalMinutes = getCurrentIntervalMinutes(now, config);
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
      return {
        integrationId: integration.id,
        platform: integration.platform,
        label: integration.label,
        autoSyncEnabled: config.syncProfile.autoSyncEnabled,
        due: false,
        intervalMinutes,
        requestedMode: modes.requestedMode,
        effectiveMode: modes.effectiveMode,
        fallbackReason: modes.fallbackReason,
        reason: "Integration is not connected.",
      };
    }

    if (!config.syncProfile.autoSyncEnabled) {
      return {
        integrationId: integration.id,
        platform: integration.platform,
        label: integration.label,
        autoSyncEnabled: false,
        due: false,
        intervalMinutes,
        requestedMode: modes.requestedMode,
        effectiveMode: modes.effectiveMode,
        fallbackReason: modes.fallbackReason,
        reason: "Auto sync is disabled for this integration.",
      };
    }

    if (runningIds.has(integration.id)) {
      return {
        integrationId: integration.id,
        platform: integration.platform,
        label: integration.label,
        autoSyncEnabled: true,
        due: false,
        intervalMinutes,
        requestedMode: modes.requestedMode,
        effectiveMode: modes.effectiveMode,
        fallbackReason: modes.fallbackReason,
        reason: "A sync job is already running.",
      };
    }

    if (minutesSinceLastRun < intervalMinutes) {
      return {
        integrationId: integration.id,
        platform: integration.platform,
        label: integration.label,
        autoSyncEnabled: true,
        due: false,
        intervalMinutes,
        requestedMode: modes.requestedMode,
        effectiveMode: modes.effectiveMode,
        fallbackReason: modes.fallbackReason,
        reason: `Next run is not due yet (${Math.floor(minutesSinceLastRun)} / ${intervalMinutes} minutes).`,
      };
    }

    return {
      integrationId: integration.id,
      platform: integration.platform,
      label: integration.label,
      autoSyncEnabled: true,
      due: true,
      intervalMinutes,
      requestedMode: modes.requestedMode,
      effectiveMode: modes.effectiveMode,
      fallbackReason: modes.fallbackReason,
      reason: "Integration is due for a scheduled pull.",
    };
  });

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
    });

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
