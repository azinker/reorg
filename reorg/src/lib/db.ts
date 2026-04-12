import { PrismaClient } from "@prisma/client";

const POOL_EXHAUSTION_MSG = "Timed out fetching a new connection";
const MAX_POOL_RETRIES = 3;

function poolRetryDelay(attempt: number): number {
  return Math.min(300 * 2 ** attempt + Math.random() * 200, 4000);
}

const DB_IO_FLUSH_INTERVAL_MS = 10_000;
const DB_IO_BYTES_PER_ROW = 256;

type DbIoBucket = {
  queries: number;
  estimatedBytes: number;
  totalDurationMs: number;
};

const dbIoBucket: DbIoBucket = { queries: 0, estimatedBytes: 0, totalDurationMs: 0 };
let dbIoFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushDbIoBucket(): void {
  if (dbIoBucket.queries === 0) return;
  const snapshot = { ...dbIoBucket };
  dbIoBucket.queries = 0;
  dbIoBucket.estimatedBytes = 0;
  dbIoBucket.totalDurationMs = 0;

  void import("@/lib/services/network-transfer-samples").then(({ recordNetworkTransferSample }) =>
    recordNetworkTransferSample({
      channel: "DATABASE_IO",
      label: `Prisma DB round-trips (${snapshot.queries} queries, ${Math.round(snapshot.totalDurationMs)}ms)`,
      bytesEstimate: snapshot.estimatedBytes,
      durationMs: Math.round(snapshot.totalDurationMs),
      metadata: { queries: snapshot.queries, estimatedBytes: snapshot.estimatedBytes },
    }),
  ).catch(() => { /* sampling failures must not break the app */ });
}

function trackDbIo(durationMs: number, resultRowCount: number): void {
  dbIoBucket.queries += 1;
  dbIoBucket.estimatedBytes += Math.max(resultRowCount, 1) * DB_IO_BYTES_PER_ROW;
  dbIoBucket.totalDurationMs += durationMs;

  if (!dbIoFlushTimer) {
    dbIoFlushTimer = setTimeout(() => {
      dbIoFlushTimer = null;
      flushDbIoBucket();
    }, DB_IO_FLUSH_INTERVAL_MS);
    if (typeof dbIoFlushTimer === "object" && "unref" in dbIoFlushTimer) {
      dbIoFlushTimer.unref();
    }
  }
}

function estimateRowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object" && "count" in result) {
    return Number((result as { count: number }).count) || 1;
  }
  return 1;
}

const SKIP_MODELS = new Set(["NetworkTransferSample", "NetworkTransferDailySummary"]);

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof buildClient> | undefined;
};

function buildClient() {
  return new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  }).$extends({
    query: {
      async $allOperations({ model, args, query }) {
        const skipTelemetry = model && SKIP_MODELS.has(model);
        const start = skipTelemetry ? 0 : performance.now();

        for (let attempt = 0; ; attempt++) {
          try {
            const result = await query(args);

            if (!skipTelemetry) {
              const durationMs = performance.now() - start;
              trackDbIo(durationMs, estimateRowCount(result));
            }

            return result;
          } catch (error) {
            const isPoolExhausted =
              error instanceof Error &&
              error.message.includes(POOL_EXHAUSTION_MSG);

            if (isPoolExhausted && attempt < MAX_POOL_RETRIES) {
              const delay = poolRetryDelay(attempt);
              console.warn(
                `[db] connection pool exhausted (attempt ${attempt + 1}/${MAX_POOL_RETRIES}), retrying in ${Math.round(delay)}ms`,
              );
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }
            throw error;
          }
        }
      },
    },
  });
}

export const db = globalForPrisma.prisma ?? buildClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
