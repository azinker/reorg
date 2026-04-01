import type { RevenueSyncRequest } from "@/lib/revenue";

function getRevenueSyncExecuteBaseUrlAndSecret(): { base: string; secret: string } | null {
  const secret = process.env.CRON_SECRET;
  const base =
    process.env.AUTH_URL?.replace(/\/$/, "") ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

  if (!base || !secret) {
    return null;
  }

  return { base, secret };
}

export async function dispatchQueuedRevenueSyncExecution(
  request: RevenueSyncRequest,
  jobIds: string[],
): Promise<boolean> {
  const creds = getRevenueSyncExecuteBaseUrlAndSecret();
  if (!creds || jobIds.length === 0) {
    return false;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(`${creds.base}/api/revenue/sync/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.secret}`,
      },
      body: JSON.stringify({
        ...request,
        jobIds,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Revenue execute dispatch failed with ${response.status}.`);
    }

    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return true;
    }

    console.error("[revenue-sync] Failed to dispatch queued execution", error);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
