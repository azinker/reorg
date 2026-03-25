import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isAuthBypassEnabled } from "@/lib/app-env";

const cancelSchema = z.object({
  pushJobId: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    const userId =
      session?.user?.id ??
      (isAuthBypassEnabled()
        ? (await db.user.findFirst({ where: { role: "ADMIN" } }))?.id
        : null);

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = cancelSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const job = await db.pushJob.findUnique({
      where: { id: parsed.data.pushJobId },
    });

    if (!job) {
      return NextResponse.json({ error: "Push job not found" }, { status: 404 });
    }

    if (job.status === "COMPLETED" || job.status === "FAILED") {
      return NextResponse.json({
        data: { cancelled: false, message: "This push job has already finished." },
      });
    }

    await db.pushJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        result: {
          ...((job.result && typeof job.result === "object" ? job.result : {}) as Record<string, unknown>),
          status: "cancelled",
          cancelledBy: userId,
          cancelledAt: new Date().toISOString(),
          message: "Push job was manually cancelled by the user.",
        },
      },
    });

    await db.auditLog.create({
      data: {
        userId,
        action: "push_cancelled",
        entityType: "push_job",
        entityId: job.id,
        details: { reason: "User manually cancelled the push job from Engine Room." },
      },
    });

    return NextResponse.json({
      data: { cancelled: true, message: "Push job has been cancelled." },
    });
  } catch (error) {
    console.error("[push/cancel] Failed to cancel push job", error);
    return NextResponse.json(
      { error: "Failed to cancel push job" },
      { status: 500 },
    );
  }
}
