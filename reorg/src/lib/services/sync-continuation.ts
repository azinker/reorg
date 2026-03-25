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
  // Two attempts for hard network errors; 20 s timeout per attempt.
  // AbortError (timeout) means the server already received the request and
  // is running the inline sync — always return immediately, never retry on
  // AbortError. Retrying on AbortError wastes ~33 s inside the chunk
  // function and can push us past Vercel's 800 s maxDuration before the
  // DB cursor write + this dispatch even complete.
  const MAX_ATTEMPTS = 2;
  const DISPATCH_TIMEOUT_MS = 20_000;

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
        // Server received the request and started the inline sync — the
        // response will never arrive in time. This is expected and correct.
        return;
      }
      console.error(
        `[sync-continuation] Attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
        err,
      );
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 2_000));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  console.error(
    `[sync-continuation] All ${MAX_ATTEMPTS} attempts failed for ${integrationId}. ` +
    `Continuation may be lost — scheduler safety-net re-dispatches within ~2 min.`,
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
