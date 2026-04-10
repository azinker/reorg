import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns recent auto-responder batches with per-batch progress.
 * Batches are identified either by explicit batchId or by grouping
 * SHIP_ORDERS jobs created within a tight time window.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch batches that have an explicit batchId (new behavior)
  const explicitBatches = await db.$queryRaw<
    Array<{
      batchId: string;
      total: bigint;
      pending: bigint;
      processing: bigint;
      completed: bigint;
      failed: bigint;
      paused: bigint;
      startedAt: Date;
      lastUpdatedAt: Date;
    }>
  >`
    SELECT
      "batchId",
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE status = 'PENDING')::bigint AS pending,
      COUNT(*) FILTER (WHERE status = 'PROCESSING')::bigint AS processing,
      COUNT(*) FILTER (WHERE status = 'COMPLETED')::bigint AS completed,
      COUNT(*) FILTER (WHERE status = 'FAILED')::bigint AS failed,
      COUNT(*) FILTER (WHERE status = 'PAUSED')::bigint AS paused,
      MIN("createdAt") AS "startedAt",
      MAX("updatedAt") AS "lastUpdatedAt"
    FROM auto_responder_jobs
    WHERE "batchId" IS NOT NULL
    GROUP BY "batchId"
    ORDER BY MIN("createdAt") DESC
    LIMIT 20
  `;

  // Also gather legacy batches (no batchId) by grouping by 3-minute windows
  const legacyBatches = await db.$queryRaw<
    Array<{
      windowStart: Date;
      total: bigint;
      pending: bigint;
      processing: bigint;
      completed: bigint;
      failed: bigint;
      paused: bigint;
      startedAt: Date;
      lastUpdatedAt: Date;
    }>
  >`
    SELECT
      date_trunc('hour', "createdAt") + INTERVAL '3 min' * FLOOR(EXTRACT(MINUTE FROM "createdAt") / 3) AS "windowStart",
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE status = 'PENDING')::bigint AS pending,
      COUNT(*) FILTER (WHERE status = 'PROCESSING')::bigint AS processing,
      COUNT(*) FILTER (WHERE status = 'COMPLETED')::bigint AS completed,
      COUNT(*) FILTER (WHERE status = 'FAILED')::bigint AS failed,
      COUNT(*) FILTER (WHERE status = 'PAUSED')::bigint AS paused,
      MIN("createdAt") AS "startedAt",
      MAX("updatedAt") AS "lastUpdatedAt"
    FROM auto_responder_jobs
    WHERE "batchId" IS NULL
      AND source = 'SHIP_ORDERS'
      AND "createdAt" > NOW() - INTERVAL '7 days'
    GROUP BY "windowStart"
    HAVING COUNT(*) >= 2
    ORDER BY "windowStart" DESC
    LIMIT 20
  `;

  // Also get per-channel breakdown for active batches
  const channelBreakdown = await db.$queryRaw<
    Array<{
      batchId: string | null;
      channel: string;
      pending: bigint;
      processing: bigint;
      completed: bigint;
      failed: bigint;
    }>
  >`
    SELECT
      "batchId",
      channel::text,
      COUNT(*) FILTER (WHERE status = 'PENDING')::bigint AS pending,
      COUNT(*) FILTER (WHERE status = 'PROCESSING')::bigint AS processing,
      COUNT(*) FILTER (WHERE status = 'COMPLETED')::bigint AS completed,
      COUNT(*) FILTER (WHERE status = 'FAILED')::bigint AS failed
    FROM auto_responder_jobs
    WHERE "batchId" IS NOT NULL
      OR (source = 'SHIP_ORDERS' AND "createdAt" > NOW() - INTERVAL '7 days')
    GROUP BY "batchId", channel
  `;

  const cronIntervalMinutes = 1;

  const batches = [
    ...explicitBatches.map((b, idx) => {
      const total = Number(b.total);
      const completed = Number(b.completed);
      const failed = Number(b.failed);
      const pending = Number(b.pending);
      const processing = Number(b.processing);
      const paused = Number(b.paused);
      const channels = channelBreakdown
        .filter((c) => c.batchId === b.batchId)
        .reduce<Record<string, { pending: number; processing: number; completed: number; failed: number }>>((acc, c) => {
          acc[c.channel] = {
            pending: Number(c.pending),
            processing: Number(c.processing),
            completed: Number(c.completed),
            failed: Number(c.failed),
          };
          return acc;
        }, {});

      return {
        id: b.batchId,
        label: `Batch #${explicitBatches.length - idx}`,
        startedAt: b.startedAt.toISOString(),
        lastUpdatedAt: b.lastUpdatedAt.toISOString(),
        total,
        completed,
        failed,
        pending,
        processing,
        paused,
        channels,
        isDone: pending === 0 && processing === 0 && paused === 0,
        statusText: getStatusText({ total, completed, failed, pending, processing, paused, cronIntervalMinutes }),
      };
    }),
    ...legacyBatches.map((b, idx) => {
      const total = Number(b.total);
      const completed = Number(b.completed);
      const failed = Number(b.failed);
      const pending = Number(b.pending);
      const processing = Number(b.processing);
      const paused = Number(b.paused);

      return {
        id: `legacy-${b.windowStart.toISOString()}`,
        label: `Batch #${legacyBatches.length - idx}`,
        startedAt: b.startedAt.toISOString(),
        lastUpdatedAt: b.lastUpdatedAt.toISOString(),
        total,
        completed,
        failed,
        pending,
        processing,
        paused,
        channels: {} as Record<string, { pending: number; processing: number; completed: number; failed: number }>,
        isDone: pending === 0 && processing === 0 && paused === 0,
        statusText: getStatusText({ total, completed, failed, pending, processing, paused, cronIntervalMinutes }),
      };
    }),
  ];

  batches.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  return NextResponse.json({ batches: batches.slice(0, 20) });
}

function getStatusText(b: {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  processing: number;
  paused: number;
  cronIntervalMinutes: number;
}): string {
  if (b.pending === 0 && b.processing === 0 && b.paused === 0) {
    if (b.failed > 0) {
      return `Done — ${b.completed} sent, ${b.failed} failed`;
    }
    return `Done — ${b.completed} sent`;
  }

  if (b.paused > 0) {
    return `Paused — ${b.paused} paused, ${b.completed}/${b.total} completed`;
  }

  const remaining = b.pending + b.processing;
  const batchLimit = 50;
  if (remaining > batchLimit) {
    const ticksNeeded = Math.ceil(remaining / batchLimit);
    const minutesLeft = ticksNeeded * b.cronIntervalMinutes;
    return `Processing — ${b.completed}/${b.total} done, ~${minutesLeft} min remaining (${ticksNeeded} cron ticks)`;
  }

  if (b.processing > 0) {
    return `Sending — ${b.processing} in progress, ${b.completed}/${b.total} done`;
  }

  return `Queued — ${b.pending} waiting, ${b.completed}/${b.total} done, next cron in ~${b.cronIntervalMinutes} min`;
}
