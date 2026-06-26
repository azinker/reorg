import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { createLabelFormatterReship } from "@/lib/label-formatter/reship";
import {
  LABEL_FORMATTER_RESHIP_ZIP_FILENAME,
  labelFormatterReshipSchema,
} from "@/lib/label-formatter/types";
import { queueCurrentRequestBinaryResponseSample } from "@/lib/services/network-transfer-samples";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
    const body = await request.json();
    const parsed = labelFormatterReshipSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({
        error: "Invalid ship request",
        details: parsed.error.flatten(),
      }, { status: 400 });
    }

    const result = await createLabelFormatterReship(parsed.data, actorUserId);
    queueCurrentRequestBinaryResponseSample({
      bytesEstimate: result.zipBuffer.length,
      metadata: {
        batchId: result.batchId,
        rowCount: parsed.data.rows.length,
        successCount: result.successCount,
        failedCount: result.failedCount,
        contentType: "application/zip",
      },
    });

    return new NextResponse(new Uint8Array(result.zipBuffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${LABEL_FORMATTER_RESHIP_ZIP_FILENAME}"`,
        "Cache-Control": "no-store",
        "X-Label-Formatter-Reship-Batch-Id": result.batchId,
        "X-Label-Formatter-Reship-Success": String(result.successCount),
        "X-Label-Formatter-Reship-Failed": String(result.failedCount),
      },
    });
  } catch (error) {
    console.error("[label-formatter/ship] failed", error);
    const message = error instanceof Error ? error.message : "Failed to create labels.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
