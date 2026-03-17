import { db } from "@/lib/db";

async function getBooleanAppSetting(
  key: string,
  fallback = false,
): Promise<boolean> {
  const setting = await db.appSetting.findUnique({ where: { key } });
  return typeof setting?.value === "boolean" ? setting.value : fallback;
}

export async function isSchedulerEnabled(): Promise<boolean> {
  return getBooleanAppSetting("scheduler_enabled", false);
}

export async function isLivePushEnabled(): Promise<boolean> {
  return getBooleanAppSetting("live_push_enabled", false);
}
