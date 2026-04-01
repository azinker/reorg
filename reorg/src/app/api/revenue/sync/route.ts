import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getRequiredSessionUser } from "@/lib/server-auth";
import { dispatchQueuedRevenueSyncExecution } from "@/lib/services/revenue-continuation";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";
import {
  RevenueServiceError,
  executeQueuedRevenueSyncData,
  queueRevenueSyncData,
} from "@/lib/services/revenue";

const syncSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  platforms: z
    .array(z.enum(["TPP_EBAY", "TT_EBAY", "SHOPIFY", "BIGCOMMERCE"]))
    .optional()
    .default([]),
});

function handleRevenueError(error: unknown, scope: string) {
  if (error instanceof RevenueServiceError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  console.error(scope, error);
  return NextResponse.json({ error: "Revenue sync failed" }, { status: 500 });
}

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const user = await getRequiredSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const t0 = performance.now();
    const body = await request.json();
    const parsed = syncSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    if (new Date(parsed.data.from) > new Date(parsed.data.to)) {
      return NextResponse.json({ error: "From date must be before to date." }, { status: 400 });
    }

    const syncRequest = {
      from: parsed.data.from,
      to: parsed.data.to,
      platforms: parsed.data.platforms,
    };
    const queued = await queueRevenueSyncData(user, syncRequest);

    if (queued.queuedJobIds.length > 0) {
      after(async () => {
        const dispatched = await dispatchQueuedRevenueSyncExecution(syncRequest, queued.queuedJobIds);
        if (dispatched) {
          return;
        }

        try {
          await executeQueuedRevenueSyncData(syncRequest, queued.queuedJobIds);
        } catch (executionError) {
          console.error("[revenue/sync] Inline fallback execution failed", executionError);
        }
      });
    }

    const responseBody = {
      data: {
        jobs: queued.jobs,
        completedAt: queued.completedAt,
        warnings: queued.warnings,
      },
    };
    void recordNetworkTransferSample({
      channel: "CLIENT_API_RESPONSE",
      label: "POST /api/revenue/sync",
      bytesEstimate: Buffer.byteLength(JSON.stringify(responseBody), "utf8"),
      durationMs: Math.round(performance.now() - t0),
      metadata: {
        route: "POST /api/revenue/sync",
        platformCount: parsed.data.platforms.length,
        platforms: parsed.data.platforms,
        jobCount: queued.jobs.length,
        warningCount: queued.warnings.length,
        queuedJobCount: queued.queuedJobIds.length,
      },
    });

    return NextResponse.json(responseBody);
  } catch (error) {
    return handleRevenueError(error, "[revenue/sync] POST failed");
  }
}
