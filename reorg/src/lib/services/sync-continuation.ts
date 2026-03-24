function getSyncExecuteBaseUrlAndSecret(): { base: string; secret: string } | null {
  const secret = process.env.CRON_SECRET;
  const base =
    process.env.AUTH_URL?.replace(/\/$/, "") ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

  if (!base || !secret) {
    return null;
  }

  return { base, secret };
}

function postSyncExecute(
  integrationId: string,
  body: Record<string, unknown>,
): void {
  const creds = getSyncExecuteBaseUrlAndSecret();
  if (!creds) {
    console.error(
      "[sync-continuation] Missing AUTH_URL (or VERCEL_URL) or CRON_SECRET; cannot POST /execute.",
    );
    return;
  }

  const url = `${creds.base}/api/sync/${integrationId}/execute`;

  void fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.secret}`,
    },
    body: JSON.stringify(body),
  }).catch((err) => {
    console.error("[sync-continuation] Execute request failed:", err);
  });
}

/**
 * Starts a sync in a **separate** serverless invocation (same as the scheduler).
 * Use this for manual sync from `/api/sync/[id]` so work is not tied to the POST
 * handler's `after()` lifetime (unreliable for long pulls on some hosts).
 */
export function dispatchManualSyncExecution(
  integrationId: string,
  mode?: "full" | "incremental",
): boolean {
  if (!getSyncExecuteBaseUrlAndSecret()) {
    return false;
  }
  const body: Record<string, unknown> = {};
  if (mode) body.mode = mode;
  postSyncExecute(integrationId, body);
  return true;
}

/**
 * Chains another serverless invocation so long catalog pulls can finish under
 * per-request time limits (e.g. Vercel maxDuration).
 */
export function dispatchCatalogSyncContinuation(integrationId: string): void {
  postSyncExecute(integrationId, { resumeContinuation: true });
}
