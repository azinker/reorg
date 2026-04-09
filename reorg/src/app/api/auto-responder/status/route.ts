import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import type { Platform } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [pendingByChannel, processingByChannel, completedCount, failedCount] =
    await Promise.all([
      db.autoResponderJob.groupBy({
        by: ["channel"],
        where: { status: "PENDING" },
        _count: true,
      }),
      db.autoResponderJob.groupBy({
        by: ["channel"],
        where: { status: "PROCESSING" },
        _count: true,
      }),
      db.autoResponderJob.count({ where: { status: "COMPLETED" } }),
      db.autoResponderJob.count({ where: { status: "FAILED" } }),
    ]);

  const channels: Record<string, { pending: number; processing: number }> = {};
  let totalPending = 0;
  let totalProcessing = 0;

  for (const row of pendingByChannel) {
    const ch = row.channel as Platform;
    channels[ch] = channels[ch] ?? { pending: 0, processing: 0 };
    channels[ch].pending = row._count;
    totalPending += row._count;
  }
  for (const row of processingByChannel) {
    const ch = row.channel as Platform;
    channels[ch] = channels[ch] ?? { pending: 0, processing: 0 };
    channels[ch].processing = row._count;
    totalProcessing += row._count;
  }

  return NextResponse.json({
    pending: totalPending,
    processing: totalProcessing,
    completed: completedCount,
    failed: failedCount,
    channels,
  });
}
