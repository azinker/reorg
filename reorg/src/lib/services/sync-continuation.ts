/**
 * Chains another serverless invocation so long catalog pulls can finish under
 * per-request time limits (e.g. Vercel maxDuration).
 */
export function dispatchCatalogSyncContinuation(integrationId: string): void {
  const secret = process.env.CRON_SECRET;
  const base =
    process.env.AUTH_URL?.replace(/\/$/, "") ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

  if (!base || !secret) {
    console.error(
      "[sync-continuation] Missing AUTH_URL (or VERCEL_URL) or CRON_SECRET; cannot chain catalog pull.",
    );
    return;
  }

  const url = `${base}/api/sync/${integrationId}/execute`;

  void fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ resumeContinuation: true }),
  }).catch((err) => {
    console.error("[sync-continuation] Continuation request failed:", err);
  });
}
