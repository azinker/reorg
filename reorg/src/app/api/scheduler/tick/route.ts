import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isSchedulerEnabled } from "@/lib/automation-settings";
import { db } from "@/lib/db";
import {
  executeScheduledSyncs,
  planScheduledSyncs,
} from "@/lib/services/sync-scheduler";
import { captureDailyInventorySnapshots } from "@/lib/inventory-forecast/snapshots";

const bodySchema = z
  .object({
    dryRun: z.boolean().default(false),
  })
  .optional();

const querySchema = z.object({
  dryRun: z
    .union([z.literal("true"), z.literal("1"), z.literal("false"), z.literal("0")])
    .optional(),
});

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

async function saveSchedulerStatus(status: {
  tickedAt: string;
  outcome: "dry_run" | "completed" | "failed";
  dueCount: number;
  dispatchedCount: number;
  error: string | null;
}) {
  await Promise.all([
    db.appSetting.upsert({
      where: { key: "scheduler_last_tick_at" },
      create: { key: "scheduler_last_tick_at", value: status.tickedAt as never },
      update: { value: status.tickedAt as never },
    }),
    db.appSetting.upsert({
      where: { key: "scheduler_last_outcome" },
      create: { key: "scheduler_last_outcome", value: status.outcome as never },
      update: { value: status.outcome as never },
    }),
    db.appSetting.upsert({
      where: { key: "scheduler_last_due_count" },
      create: { key: "scheduler_last_due_count", value: status.dueCount as never },
      update: { value: status.dueCount as never },
    }),
    db.appSetting.upsert({
      where: { key: "scheduler_last_dispatched_count" },
      create: {
        key: "scheduler_last_dispatched_count",
        value: status.dispatchedCount as never,
      },
      update: { value: status.dispatchedCount as never },
    }),
    db.appSetting.upsert({
      where: { key: "scheduler_last_error" },
      create: { key: "scheduler_last_error", value: status.error as never },
      update: { value: status.error as never },
    }),
  ]);
}

async function logSchedulerTick(status: {
  tickedAt: string;
  outcome: "dry_run" | "completed" | "failed";
  dueCount: number;
  dispatchedCount: number;
  error: string | null;
  dryRun: boolean;
}) {
  await db.auditLog.create({
    data: {
      action: "scheduler_tick",
      entityType: "scheduler",
      entityId: "main",
      details: status,
    },
  });
}

async function handleSchedulerTick(request: NextRequest, dryRun: boolean) {
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

    if (dryRun) {
      const plan = await planScheduledSyncs();
      const status: Parameters<typeof saveSchedulerStatus>[0] = {
        tickedAt: new Date().toISOString(),
        outcome: "dry_run",
        dueCount: plan.filter((item) => item.due).length,
        dispatchedCount: 0,
        error: null,
      };
      await saveSchedulerStatus(status);
      await logSchedulerTick({ ...status, dryRun: true });
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
    const snapshotResult = await captureDailyInventorySnapshots();
    const status: Parameters<typeof saveSchedulerStatus>[0] = {
      tickedAt: new Date().toISOString(),
      outcome: "completed",
      dueCount: result.plan.filter((item) => item.due).length,
      dispatchedCount: result.dispatched.length,
      error: null,
    };
    await saveSchedulerStatus(status);
    await logSchedulerTick({ ...status, dryRun: false });
    return NextResponse.json({
      data: {
        dryRun: false,
        dueCount: result.plan.filter((item) => item.due).length,
        dispatchedCount: result.dispatched.length,
        dispatched: result.dispatched,
        inventorySnapshots: snapshotResult,
        plan: result.plan,
      },
    });
  } catch (error) {
    const status: Parameters<typeof saveSchedulerStatus>[0] = {
      tickedAt: new Date().toISOString(),
      outcome: "failed",
      dueCount: 0,
      dispatchedCount: 0,
      error:
        error instanceof Error ? error.message : "Failed to execute scheduler tick",
    };
    await saveSchedulerStatus(status).catch(() => {});
    await logSchedulerTick({ ...status, dryRun: false }).catch(() => {});
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

export async function GET(request: NextRequest) {
  const parsed = querySchema.safeParse({
    dryRun: request.nextUrl.searchParams.get("dryRun") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const dryRun =
    parsed.data.dryRun === "true" || parsed.data.dryRun === "1";

  return handleSchedulerTick(request, dryRun);
}

export async function POST(request: NextRequest) {
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

  return handleSchedulerTick(request, parsed.data?.dryRun ?? false);
}
