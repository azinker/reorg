export class RevenueRequestTimeoutError extends Error {
  timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Revenue data is taking longer than expected to load (${Math.round(timeoutMs / 1000)}s timeout).`);
    this.name = "RevenueRequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export async function parseRevenueJson<T>(response: Response) {
  const text = await response.text();
  let json: { error?: string; data?: T } | null = null;

  if (text.trim()) {
    try {
      json = JSON.parse(text) as { error?: string; data?: T };
    } catch {
      const returnedHtml =
        text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html");
      const fallbackMessage = returnedHtml
        ? `The server returned an HTML error page (${response.status} ${response.statusText}) instead of JSON.`
        : `The server returned an unreadable response (${response.status} ${response.statusText}).`;
      throw new Error(fallbackMessage);
    }
  }

  if (!response.ok) {
    throw new Error(json?.error ?? `Request failed (${response.status} ${response.statusText})`);
  }

  return json?.data as T;
}

export async function fetchRevenueJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
) {
  const outerSignal = init.signal;
  const controller = new AbortController();
  let timedOut = false;

  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    return parseRevenueJson<T>(response);
  } catch (error) {
    if (timedOut) {
      throw new RevenueRequestTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}
