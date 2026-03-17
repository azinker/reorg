import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isSchedulerEnabled } from "@/lib/automation-settings";
import {
  executeScheduledSyncs,
  planScheduledSyncs,
} from "@/lib/services/sync-scheduler";

const bodySchema = z
  .object({
    dryRun: z.boolean().default(false),
  })
  .optional();

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const headerSecret = request.headers.get("x-cron-secret");
  const authHeader = request.headers.get("authorization");
  const bearerSecret = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  return headerSecret === secret || bearerSecret === secret;
}

export async function POST(request: NextRequest) {
  try {
    if (!process.env.CRON_SECRET) {
      return NextResponse.json(
        { error: "CRON_SECRET is not configured." },
        { status: 500 },
      );
    }

    if (!isAuthorized(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body =
      request.headers.get("content-length") &&
      request.headers.get("content-length") !== "0"
        ? await request.json()
        : undefined;
    const parsed = bodySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const dryRun = parsed.data?.dryRun ?? false;

    if (dryRun) {
      const plan = await planScheduledSyncs();
      return NextResponse.json({
        data: {
          dryRun: true,
          dueCount: plan.filter((item) => item.due).length,
          plan,
        },
      });
    }

    const schedulerEnabled = await isSchedulerEnabled();
    if (!schedulerEnabled) {
      return NextResponse.json(
        {
          error:
            "Auto sync scheduler is still disabled. Enable scheduler_enabled before wiring cron live.",
        },
        { status: 403 },
      );
    }

    const result = await executeScheduledSyncs();
    return NextResponse.json({
      data: {
        dryRun: false,
        dueCount: result.plan.filter((item) => item.due).length,
        dispatchedCount: result.dispatched.length,
        dispatched: result.dispatched,
        plan: result.plan,
      },
    });
  } catch (error) {
    console.error("[scheduler/tick] POST failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to execute scheduler tick",
      },
      { status: 500 },
    );
  }
}
