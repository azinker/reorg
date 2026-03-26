import { PrismaClient } from "@prisma/client";

const POOL_EXHAUSTION_MSG = "Timed out fetching a new connection";
const MAX_POOL_RETRIES = 3;

function poolRetryDelay(attempt: number): number {
  return Math.min(300 * 2 ** attempt + Math.random() * 200, 4000);
}

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
      async $allOperations({ args, query }) {
        for (let attempt = 0; ; attempt++) {
          try {
            return await query(args);
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
