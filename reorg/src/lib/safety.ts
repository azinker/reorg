import { db } from "@/lib/db";
import { getAppEnv } from "@/lib/env";
import type { Platform } from "@prisma/client";

export interface WriteSafetyResult {
  allowed: boolean;
  reason?: string;
}

export async function checkWriteSafety(
  platform?: Platform
): Promise<WriteSafetyResult> {
  const env = getAppEnv();
  if (env === "staging") {
    return {
      allowed: false,
      reason: "Writes are blocked in the staging environment by default.",
    };
  }

  const globalLock = await db.appSetting.findUnique({
    where: { key: "global_write_lock" },
  });

  if (globalLock && globalLock.value === true) {
    return {
      allowed: false,
      reason: "Global write lock is enabled. Disable it in Settings to allow writes.",
    };
  }

  if (platform) {
    const integration = await db.integration.findUnique({
      where: { platform },
    });

    if (!integration) {
      return {
        allowed: false,
        reason: `Integration for ${platform} not found.`,
      };
    }

    if (integration.writeLocked) {
      return {
        allowed: false,
        reason: `Write lock is enabled for ${integration.label}. Disable it in Integrations to allow writes.`,
      };
    }

    if (!integration.enabled) {
      return {
        allowed: false,
        reason: `Integration ${integration.label} is disabled.`,
      };
    }
  }

  return { allowed: true };
}
