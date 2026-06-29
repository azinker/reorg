import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { createLabelFormatterReship } from "@/lib/label-formatter/reship";
import {
  normalizeLabelFormatterReshipBody,
  summarizeInvalidLabelFormatterRows,
} from "@/lib/label-formatter/request-validation";
import {
  formatLabelFormatterRowValidationSummary,
  rowValidationIssuesToInvalidRows,
  validateLabelFormatterRowsForShip,
} from "@/lib/label-formatter/row-validation";
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

function reshipHeaders(result: Awaited<ReturnType<typeof createLabelFormatterReship>>) {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Label-Formatter-Reship-Batch-Id": result.batchId,
    "X-Label-Formatter-Reship-Success": String(result.successCount),
    "X-Label-Formatter-Reship-Failed": String(result.failedCount),
  };
  if (result.firstError) {
    headers["X-Label-Formatter-Reship-First-Error"] = result.firstError.slice(0, 500);
  }
  return headers;
}

export async function POST(request: NextRequest) {
  const actorUserId = await getActorUserId();
  if (!actorUserId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const normalizedBody = normalizeLabelFormatterReshipBody(body);
    const parsed = labelFormatterReshipSchema.safeParse(normalizedBody);
    if (!parsed.success) {
      return NextResponse.json({
        error: "Invalid ship request",
        invalidRows: summarizeInvalidLabelFormatterRows(normalizedBody, parsed.error.issues),
        details: parsed.error.flatten(),
      }, { status: 400 });
    }

    const rowIssues = validateLabelFormatterRowsForShip(parsed.data.rows);
    if (rowIssues.length > 0) {
      return NextResponse.json({
        error: "Fix selected orders before shipping",
        invalidRows: rowValidationIssuesToInvalidRows(rowIssues),
        details: formatLabelFormatterRowValidationSummary(rowIssues),
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
      status: result.successCount > 0 ? 200 : 422,
      headers: {
        ...reshipHeaders(result),
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${LABEL_FORMATTER_RESHIP_ZIP_FILENAME}"`,
      },
    });
  } catch (error) {
    console.error("[label-formatter/ship] failed", error);
    const message = error instanceof Error ? error.message : "Failed to create labels.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
