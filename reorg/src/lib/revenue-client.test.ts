import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchRevenueJson,
  parseRevenueJson,
  RevenueRequestTimeoutError,
} from "@/lib/revenue-client";

test("parseRevenueJson returns parsed data for successful JSON responses", async () => {
  const response = new Response(JSON.stringify({ data: { ok: true } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const result = await parseRevenueJson<{ ok: boolean }>(response);
  assert.deepEqual(result, { ok: true });
});

test("parseRevenueJson surfaces HTML error pages with a readable message", async () => {
  const response = new Response("<!DOCTYPE html><html><body>boom</body></html>", {
    status: 500,
    statusText: "Internal Server Error",
    headers: { "Content-Type": "text/html" },
  });

  await assert.rejects(
    () => parseRevenueJson(response),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("HTML error page") &&
      error.message.includes("500 Internal Server Error"),
  );
});

test("fetchRevenueJson times out stalled requests", async () => {
  const originalFetch = global.fetch;
  global.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    })) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchRevenueJson("/api/revenue", {}, 20),
      (error: unknown) =>
        error instanceof RevenueRequestTimeoutError &&
        error.message.includes("taking longer than expected"),
    );
  } finally {
    global.fetch = originalFetch;
  }
});
