import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { deleteBackupsByIds } from "@/lib/services/backup";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  backupIds: z.array(z.string().min(1)).min(1).max(50),
});

export async function POST(request: Request) {
  try {
    const session = await auth();
    const role = (session?.user as { role?: string } | undefined)?.role;
    if (!session?.user?.id || role !== "ADMIN") {
      return NextResponse.json(
        { error: "Only administrators can delete backups." },
        { status: 403 },
      );
    }

    const json = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await deleteBackupsByIds(
      parsed.data.backupIds,
      session.user.id,
    );

    return NextResponse.json({
      data: {
        deletedCount: result.deletedIds.length,
        deletedIds: result.deletedIds,
        failed: result.failed,
      },
    });
  } catch (error) {
    console.error("[backup/delete] POST failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete backups",
      },
      { status: 500 },
    );
  }
}
