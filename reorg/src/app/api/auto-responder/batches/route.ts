import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import type { AutoResponderJobStatus, Platform } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_INTERVAL_MINUTES = 1;
const BATCH_LIMIT = 50;

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Fetch all recent SHIP_ORDERS jobs (last 7 days) for batch grouping
    const recentJobs = await db.autoResponderJob.findMany({
      where: {
        source: "SHIP_ORDERS",
        createdAt: { gte: sevenDaysAgo },
      },
      select: {
        id: true,
        batchId: true,
        channel: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // Group jobs by batchId, or by time proximity for legacy jobs
    const batchMap = new Map<string, typeof recentJobs>();

    const legacyJobs: typeof recentJobs = [];

    for (const job of recentJobs) {
      if (job.batchId) {
        let arr = batchMap.get(job.batchId);
        if (!arr) { arr = []; batchMap.set(job.batchId, arr); }
        arr.push(job);
      } else {
        legacyJobs.push(job);
      }
    }

    // Group legacy jobs by 3-minute time windows
    if (legacyJobs.length > 0) {
      legacyJobs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      let currentWindowKey = "";
      let currentWindowStart = 0;

      for (const job of legacyJobs) {
        const t = job.createdAt.getTime();
        if (!currentWindowKey || t - currentWindowStart > 3 * 60 * 1000) {
          currentWindowStart = t;
          currentWindowKey = `legacy-${job.createdAt.toISOString()}`;
        }
        let arr = batchMap.get(currentWindowKey);
        if (!arr) { arr = []; batchMap.set(currentWindowKey, arr); }
        arr.push(job);
      }
    }

    // Build batch summaries
    const batches: Array<{
      id: string;
      startedAt: string;
      lastUpdatedAt: string;
      total: number;
      completed: number;
      failed: number;
      pending: number;
      processing: number;
      paused: number;
      channels: Record<string, { pending: number; processing: number; completed: number; failed: number }>;
      isDone: boolean;
      statusText: string;
    }> = [];

    for (const [batchKey, jobs] of batchMap) {
      if (jobs.length < 2 && batchKey.startsWith("legacy-")) continue;

      const counts = countStatuses(jobs);
      const channels = countChannels(jobs);
      const startedAt = jobs.reduce((min, j) => j.createdAt < min ? j.createdAt : min, jobs[0].createdAt);
      const lastUpdatedAt = jobs.reduce((max, j) => j.updatedAt > max ? j.updatedAt : max, jobs[0].updatedAt);

      batches.push({
        id: batchKey,
        startedAt: startedAt.toISOString(),
        lastUpdatedAt: lastUpdatedAt.toISOString(),
        ...counts,
        channels,
        isDone: counts.pending === 0 && counts.processing === 0 && counts.paused === 0,
        statusText: getStatusText(counts),
      });
    }

    batches.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    return NextResponse.json({ batches: batches.slice(0, 20) });
  } catch (err) {
    console.error("[auto-responder/batches] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}

function countStatuses(jobs: Array<{ status: AutoResponderJobStatus }>) {
  let pending = 0, processing = 0, completed = 0, failed = 0, paused = 0;
  for (const j of jobs) {
    switch (j.status) {
      case "PENDING": pending++; break;
      case "PROCESSING": processing++; break;
      case "COMPLETED": completed++; break;
      case "FAILED": failed++; break;
      case "PAUSED": paused++; break;
    }
  }
  return { total: jobs.length, pending, processing, completed, failed, paused };
}

function countChannels(jobs: Array<{ channel: Platform; status: AutoResponderJobStatus }>) {
  const channels: Record<string, { pending: number; processing: number; completed: number; failed: number }> = {};
  for (const j of jobs) {
    const ch = j.channel as string;
    if (!channels[ch]) channels[ch] = { pending: 0, processing: 0, completed: 0, failed: 0 };
    switch (j.status) {
      case "PENDING": channels[ch].pending++; break;
      case "PROCESSING": channels[ch].processing++; break;
      case "COMPLETED": channels[ch].completed++; break;
      case "FAILED": channels[ch].failed++; break;
    }
  }
  return channels;
}

function getStatusText(b: {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  processing: number;
  paused: number;
}): string {
  if (b.pending === 0 && b.processing === 0 && b.paused === 0) {
    if (b.failed > 0) {
      return `Done \u2014 ${b.completed} sent, ${b.failed} failed`;
    }
    return `Done \u2014 ${b.completed} sent`;
  }

  if (b.paused > 0) {
    return `Paused \u2014 ${b.paused} paused, ${b.completed}/${b.total} completed`;
  }

  const remaining = b.pending + b.processing;
  if (remaining > BATCH_LIMIT) {
    const ticksNeeded = Math.ceil(remaining / BATCH_LIMIT);
    const minutesLeft = ticksNeeded * CRON_INTERVAL_MINUTES;
    return `Processing \u2014 ${b.completed}/${b.total} done, ~${minutesLeft} min remaining (${ticksNeeded} cron ticks)`;
  }

  if (b.processing > 0) {
    return `Sending \u2014 ${b.processing} in progress, ${b.completed}/${b.total} done`;
  }

  return `Queued \u2014 ${b.pending} waiting, ${b.completed}/${b.total} done, next cron in ~${CRON_INTERVAL_MINUTES} min`;
}
