import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { normalizeLabelFormatterReshipBody } from "@/lib/label-formatter/request-validation";
import {
  formatLabelFormatterRowValidationSummary,
  rowValidationIssuesToInvalidRows,
  validateLabelFormatterRowsForShip,
} from "@/lib/label-formatter/row-validation";
import { LABEL_FORMATTER_RESHIP_ZIP_FILENAME } from "@/lib/label-formatter/types";
import { shipNeweggOrdersWithLabels } from "@/lib/marketplace-orders/ship-newegg";
import { marketplaceShipSchema } from "@/lib/marketplace-orders/types";
import { checkPageAccess } from "@/lib/page-access";
import { isNeweggConfigured } from "@/lib/services/newegg";
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
  const access = await checkPageAccess("newegg-etsy-orders");
  if (!access.authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!access.allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const actorUserId = await getActorUserId();
  if (!actorUserId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isNeweggConfigured()) {
    return NextResponse.json({ error: "Newegg is not configured." }, { status: 503 });
  }

  try {
    const body = await request.json();
    const normalizedBody = normalizeLabelFormatterReshipBody(body);
    const normalizedRecord = typeof normalizedBody === "object" && normalizedBody !== null
      ? normalizedBody as Record<string, unknown>
      : {};
    const parsed = marketplaceShipSchema.safeParse({
      ...normalizedRecord,
      confirmMarketplaceTracking: body.confirmMarketplaceTracking === true,
    });
    if (!parsed.success) {
      return NextResponse.json({
        error: "Invalid ship request",
        details: parsed.error.flatten(),
      }, { status: 400 });
    }

    if (parsed.data.confirmMarketplaceTracking !== true) {
      return NextResponse.json({
        error: "Marketplace tracking push requires explicit confirmation.",
        hint: "Set confirmMarketplaceTracking to true after reviewing selected orders.",
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

    const result = await shipNeweggOrdersWithLabels(parsed.data, actorUserId);

    queueCurrentRequestBinaryResponseSample({
      bytesEstimate: result.zipBuffer.length,
      metadata: {
        batchId: result.batchId,
        rowCount: parsed.data.rows.length,
        successCount: result.successCount,
        failedCount: result.failedCount,
        trackingPushedCount: result.trackingPushedCount,
        contentType: "application/zip",
      },
    });

    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${LABEL_FORMATTER_RESHIP_ZIP_FILENAME}"`,
      "X-Label-Formatter-Reship-Batch-Id": result.batchId,
      "X-Label-Formatter-Reship-Success": String(result.successCount),
      "X-Label-Formatter-Reship-Failed": String(result.failedCount),
      "X-Marketplace-Tracking-Pushed": String(result.trackingPushedCount),
      "X-Marketplace-Tracking-Failed": String(result.trackingFailedCount),
    };
    if (result.firstError) {
      headers["X-Label-Formatter-Reship-First-Error"] = result.firstError.slice(0, 500);
    }

    return new NextResponse(new Uint8Array(result.zipBuffer), {
      status: result.successCount > 0 ? 200 : 422,
      headers,
    });
  } catch (error) {
    console.error("[marketplace-orders/newegg/ship] failed", error);
    const message = error instanceof Error ? error.message : "Failed to ship Newegg orders.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
