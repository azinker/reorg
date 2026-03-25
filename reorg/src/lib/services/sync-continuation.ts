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

async function postSyncExecute(
  integrationId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const creds = getSyncExecuteBaseUrlAndSecret();
  if (!creds) {
    console.error(
      "[sync-continuation] Missing AUTH_URL (or VERCEL_URL) or CRON_SECRET; cannot POST /execute.",
    );
    return;
  }

  const url = `${creds.base}/api/sync/${integrationId}/execute`;
  const MAX_ATTEMPTS = 3;
  const DISPATCH_TIMEOUT_MS = 30_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${creds.secret}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // 30s timeout → for inline syncs this usually means the server
        // accepted the request and is running. On the FIRST attempt the
        // cold-start might not have fully started yet; retry once more to
        // double-confirm delivery. On attempt 2+ we accept it.
        if (attempt >= 2) return;
        console.log(
          `[sync-continuation] Attempt ${attempt}/${MAX_ATTEMPTS}: timeout — ` +
          `retrying once to confirm delivery.`,
        );
        await new Promise((r) => setTimeout(r, 3_000));
        continue;
      }
      console.error(
        `[sync-continuation] Attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
        err,
      );
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 3_000));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  console.error(
    `[sync-continuation] All ${MAX_ATTEMPTS} attempts failed for ${integrationId}. ` +
    `Continuation may be lost — scheduler will re-dispatch within ~2 minutes.`,
  );
}

/**
 * Starts a sync in a **separate** serverless invocation (same as the scheduler).
 * Use this for manual sync from `/api/sync/[id]` so work is not tied to the POST
 * handler's `after()` lifetime (unreliable for long pulls on some hosts).
 */
export async function dispatchManualSyncExecution(
  integrationId: string,
  mode?: "full" | "incremental",
): Promise<boolean> {
  if (!getSyncExecuteBaseUrlAndSecret()) {
    return false;
  }
  const body: Record<string, unknown> = {};
  if (mode) body.mode = mode;
  await postSyncExecute(integrationId, body);
  return true;
}

/**
 * Chains another serverless invocation so long catalog pulls can finish under
 * per-request time limits (e.g. Vercel maxDuration).
 */
export async function dispatchCatalogSyncContinuation(integrationId: string): Promise<void> {
  await postSyncExecute(integrationId, { resumeContinuation: true });
}
