import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getMissingR2EnvVars, getR2ObjectBytes } from "@/lib/r2";
import {
  createBackupJsonBuffer,
  createBackupWorkbookBuffer,
  parseBackupSnapshot,
} from "@/lib/services/backup";
import { queueCurrentRequestBinaryResponseSample } from "@/lib/services/network-transfer-samples";

interface RouteContext {
  params: Promise<{
    backupId: string;
  }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { backupId } = await context.params;
    const backup = await db.backup.findUnique({
      where: { id: backupId },
    });

    if (!backup) {
      return NextResponse.json({ error: "Backup not found" }, { status: 404 });
    }

    if (backup.status !== "COMPLETED") {
      return NextResponse.json(
        { error: "Backup is not ready for download" },
        { status: 409 }
      );
    }

    const missingEnvVars = getMissingR2EnvVars();
    if (missingEnvVars.length > 0) {
      return NextResponse.json(
        {
          error: "Cloudflare R2 is not configured for downloads yet.",
          details: { missingEnvVars },
        },
        { status: 400 }
      );
    }

    const format = _request.nextUrl.searchParams.get("format") === "xlsx"
      ? "xlsx"
      : "json";
    const compressed = await getR2ObjectBytes(backup.storageKey);
    const snapshot = parseBackupSnapshot(compressed);

    const body =
      format === "xlsx"
        ? createBackupWorkbookBuffer(snapshot)
        : createBackupJsonBuffer(snapshot);
    const fileName =
      format === "xlsx"
        ? backup.fileName.replace(/\.json\.gz$/i, ".xlsx")
        : backup.fileName.replace(/\.gz$/i, "");
    const contentType =
      format === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/json; charset=utf-8";

    queueCurrentRequestBinaryResponseSample({
      bytesEstimate: body.length,
      label: "GET /api/backup/:id/download",
      metadata: {
        backupId,
        format,
        contentType,
      },
    });

    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  } catch (error) {
    console.error("[backup/download] GET failed", error);
    return NextResponse.json(
      { error: "Failed to prepare backup download" },
      { status: 500 }
    );
  }
}
