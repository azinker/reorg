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
  _platform?: Platform | string,
): number | null {
  const hour = getHourInTimeZone(date, config.syncProfile.timezone);
  const isDaytime =
    hour >= config.syncProfile.dayStartHour &&
    hour < config.syncProfile.dayEndHour;

  if (isDaytime) return config.syncProfile.dayIntervalMinutes;

  const overnight = config.syncProfile.overnightIntervalMinutes;
  return overnight === 0 ? null : overnight;
}

/**
 * eBay Trading API daily limits reset once per calendar day (typically midnight
 * Pacific). When we record a rate-limit hit we now also persist the actual
 * reset time (`lastRateLimitResetAt`) straight from the eBay
 * `GetApiAccessRules → PeriodicEndDate` response. The cooldown lasts until
 * that reset, NOT a fixed 90-minute window. If the exact reset time isn't
 * available we fall back to "next midnight Pacific".
 */
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

  // 1. Prefer the stored eBay reset time (from PeriodicEndDate)
  if (config.syncState.lastRateLimitResetAt) {
    const resetAt = new Date(config.syncState.lastRateLimitResetAt);
    if (!Number.isNaN(resetAt.getTime()) && resetAt.getTime() > now.getTime()) {
      return resetAt;
    }
    // Reset time has passed — no cooldown
    if (!Number.isNaN(resetAt.getTime()) && resetAt.getTime() <= now.getTime()) {
      return null;
    }
  }

  // 2. Fallback: compute the next midnight Pacific after the rate-limit hit.
  //    eBay daily counters reset at 00:00 America/Los_Angeles.
  const cooldownUntil = getNextEbayDailyReset(rateLimitAt);
  if (cooldownUntil.getTime() <= now.getTime()) return null;
  return cooldownUntil;
}

/**
 * Compute the next midnight Pacific (America/Los_Angeles) at or after `from`.
 * This is the eBay Trading API daily counter reset boundary.
 */
export function getNextEbayDailyReset(from: Date): Date {
  const tz = "America/Los_Angeles";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(from);

  const val = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  const year = val("year");
  const month = val("month");
  const day = val("day");
  const hour = val("hour");

  // If we're past midnight (hour > 0 or any minutes/seconds), next reset is
  // tomorrow midnight. If exactly midnight, treat as the reset just happening.
  const nextDay = hour > 0 ? day + 1 : day + 1;

  // Build "YYYY-MM-DDT00:00:00" in Pacific, then convert to UTC
  const midnightPacificGuessUtc = Date.UTC(year, month - 1, nextDay, 0, 0, 0);
  const offsetMs = getTimeZoneOffsetMs(new Date(midnightPacificGuessUtc), tz);
  return new Date(midnightPacificGuessUtc - offsetMs);
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const val = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    val("year"),
    val("month") - 1,
    val("day"),
    val("hour"),
    val("minute"),
    val("second"),
  );
  return asUtc - date.getTime();
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
  rateLimitResetAt?: string | null,
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
            lastRateLimitResetAt: rateLimitResetAt ?? null,
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
