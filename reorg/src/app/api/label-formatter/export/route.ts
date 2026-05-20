import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { createLabelFormatterExport } from "@/lib/label-formatter/export";
import { labelFormatterExportSchema, LABEL_FORMATTER_ZIP_FILENAME } from "@/lib/label-formatter/types";
import { queueCurrentRequestBinaryResponseSample } from "@/lib/services/network-transfer-samples";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function getSystemUser() {
  let user = await db.user.findFirst({ where: { role: "ADMIN" } });
  if (!user) {
    user = await db.user.create({
      data: { email: "system@reorg.internal", name: "System", role: "ADMIN" },
    });
  }
  return user;
}

async function getActorUserId() {
  const session = await auth();
  if (session?.user?.id && ["ADMIN", "OPERATOR"].includes(session.user.role)) {
    return session.user.id;
  }
  if (isAuthBypassEnabled()) return (await getSystemUser()).id;
  return null;
}

export async function POST(request: NextRequest) {
  const actorUserId = await getActorUserId();
  if (!actorUserId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = labelFormatterExportSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid export", details: parsed.error.flatten() }, { status: 400 });
    }

    const result = await createLabelFormatterExport(parsed.data, actorUserId);
    queueCurrentRequestBinaryResponseSample({
      bytesEstimate: result.zipBuffer.length,
      metadata: {
        batchId: result.batchId,
        rowCount: parsed.data.rows.length,
        mode: parsed.data.mode,
        contentType: "application/zip",
      },
    });

    return new NextResponse(new Uint8Array(result.zipBuffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${LABEL_FORMATTER_ZIP_FILENAME}"`,
        "Cache-Control": "no-store",
        "X-Label-Formatter-Batch-Id": result.batchId,
      },
    });
  } catch (error) {
    console.error("[label-formatter/export] failed", error);
    return NextResponse.json({ error: "Failed to build Label Formatter export." }, { status: 500 });
  }
}
