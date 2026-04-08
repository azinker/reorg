import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [pendingJobs, processingJobs, failedJobs, completedJobs, recentLogs, killSwitch] =
    await Promise.all([
      db.autoResponderJob.findMany({
        where: { status: "PENDING" },
        orderBy: { createdAt: "asc" },
        select: {
          id: true, orderNumber: true, channel: true, status: true,
          retryCount: true, lastError: true, processAfter: true,
          createdAt: true, updatedAt: true, source: true,
        },
      }),
      db.autoResponderJob.findMany({
        where: { status: "PROCESSING" },
        select: {
          id: true, orderNumber: true, channel: true, status: true,
          createdAt: true, updatedAt: true,
        },
      }),
      db.autoResponderJob.findMany({
        where: { status: "FAILED" },
        select: {
          id: true, orderNumber: true, channel: true, status: true,
          retryCount: true, lastError: true, createdAt: true, updatedAt: true,
        },
      }),
      db.autoResponderJob.count({ where: { status: "COMPLETED" } }),
      db.autoResponderSendLog.findMany({
        orderBy: { sentAt: "desc" },
        take: 10,
        select: {
          orderNumber: true, channel: true, eventType: true,
          sentAt: true, failedAt: true, reason: true,
        },
      }),
      db.appSetting.findUnique({ where: { key: "auto_responder_kill_switch" } }),
    ]);

  return NextResponse.json({
    killSwitch: killSwitch?.value ?? false,
    jobs: {
      pending: pendingJobs,
      processing: processingJobs,
      failed: failedJobs,
      completedCount: completedJobs,
    },
    recentLogs,
    now: new Date().toISOString(),
  });
}
