import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { buildReshipDataSheetForBatch } from "@/lib/label-formatter/reship";
import { LABEL_FORMATTER_RESHIP_DATA_FILENAME } from "@/lib/label-formatter/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ batchId: string }>;
}

async function isAllowed() {
  const session = await auth();
  if (session?.user?.id && ["ADMIN", "OPERATOR"].includes(session.user.role)) return true;
  return isAuthBypassEnabled() ? Boolean(await db.user.findFirst({ where: { role: "ADMIN" } })) : false;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  if (!(await isAllowed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { batchId } = await params;
  const buffer = await buildReshipDataSheetForBatch(batchId);
  if (!buffer) {
    return NextResponse.json({ error: "Reship batch not found." }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${LABEL_FORMATTER_RESHIP_DATA_FILENAME}"`,
      "Cache-Control": "no-store",
    },
  });
}
