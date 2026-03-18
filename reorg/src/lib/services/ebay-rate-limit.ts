import type { Platform } from "@prisma/client";
import type { IntegrationConfigRecord } from "@/lib/integrations/runtime-config";

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
) {
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
