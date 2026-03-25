import type { Platform, Prisma } from "@prisma/client";
import type { IntegrationConfigRecord } from "@/lib/integrations/runtime-config";
import { getIntegrationConfig, mergeIntegrationConfig } from "@/lib/integrations/runtime-config";
import { getEbayAutoSyncIntervalMinutes } from "@/lib/services/ebay-sync-policy";
import { db } from "@/lib/db";

export function isEbayPlatform(platform: string): platform is "TPP_EBAY" | "TT_EBAY" {
  return platform === "TPP_EBAY" || platform === "TT_EBAY";
}

export function isEbayUsageLimitMessage(message: string | null | undefined) {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes("exceeded usage limit") ||
    normalized.includes("usage limit on this call") ||
    normalized.includes("call usage limit has been reached")
  );
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

export function getCurrentSyncIntervalMinutes(
  date: Date,
  config: Pick<IntegrationConfigRecord, "syncProfile">,
  platform?: Platform | string,
) {
  if (platform === "TPP_EBAY" || platform === "TT_EBAY") {
    return (
      getEbayAutoSyncIntervalMinutes(date, config.syncProfile.timezone) ??
      config.syncProfile.overnightIntervalMinutes
    );
  }

  const hour = getHourInTimeZone(date, config.syncProfile.timezone);
  const isDaytime =
    hour >= config.syncProfile.dayStartHour &&
    hour < config.syncProfile.dayEndHour;

  return isDaytime
    ? config.syncProfile.dayIntervalMinutes
    : config.syncProfile.overnightIntervalMinutes;
}

export function getEbayRateLimitCooldownUntil(
  platform: string,
  config: Pick<IntegrationConfigRecord, "syncProfile" | "syncState">,
  now = new Date(),
) {
  if (!isEbayPlatform(platform) || !config.syncState.lastRateLimitAt) {
    return null;
  }

  const rateLimitAt = new Date(config.syncState.lastRateLimitAt);
  if (Number.isNaN(rateLimitAt.getTime())) return null;

  const intervalMinutes = getCurrentSyncIntervalMinutes(now, config);
  const cooldownMinutes = Math.max(intervalMinutes, 90);
  const cooldownUntil = new Date(rateLimitAt.getTime() + cooldownMinutes * 60 * 1000);

  if (cooldownUntil.getTime() <= now.getTime()) return null;
  return cooldownUntil;
}

export function formatCooldownRetryAt(value: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(date);
}

/**
 * Propagate a rate-limit cooldown to ALL eBay integrations that share the same
 * appId. Both TPP and TT use the same eBay developer app and quota pool — if
 * one hits the limit, the other is equally affected and should show the cooldown.
 */
export async function propagateEbayRateLimitToAllSharedIntegrations(
  sourceIntegrationId: string,
  message: string,
) {
  const sourceIntegration = await db.integration.findUnique({
    where: { id: sourceIntegrationId },
    select: { config: true },
  });
  if (!sourceIntegration) return;

  const sourceConfig = sourceIntegration.config as Record<string, unknown> | null;
  const appId =
    sourceConfig && typeof sourceConfig === "object" && typeof sourceConfig.appId === "string"
      ? sourceConfig.appId
      : null;
  if (!appId) return;

  const allEbayIntegrations = await db.integration.findMany({
    where: { platform: { in: ["TPP_EBAY", "TT_EBAY"] as Platform[] } },
    select: { id: true, platform: true, config: true },
  });

  const now = new Date().toISOString();

  await Promise.all(
    allEbayIntegrations
      .filter((integration) => {
        if (integration.id === sourceIntegrationId) return false;
        const cfg = integration.config as Record<string, unknown> | null;
        return cfg && typeof cfg === "object" && cfg.appId === appId;
      })
      .map(async (integration) => {
        const config = getIntegrationConfig(integration);
        const existingCooldownAt = config.syncState.lastRateLimitAt;
        if (existingCooldownAt && new Date(existingCooldownAt) > new Date(now)) return;

        const updated = mergeIntegrationConfig(integration.platform as Platform, integration.config, {
          syncState: {
            lastRateLimitAt: now,
            lastRateLimitMessage: message,
          },
        });
        await db.integration.update({
          where: { id: integration.id },
          data: { config: updated as unknown as Prisma.InputJsonValue },
        });
        console.log(
          `[ebay-rate-limit] Propagated cooldown from ${sourceIntegrationId} → ${integration.id} (${integration.platform})`,
        );
      }),
  );
}
