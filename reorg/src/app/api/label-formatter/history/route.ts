import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { listLabelFormatterExportHistory } from "@/lib/label-formatter/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getSystemUser() {
  let user = await db.user.findFirst({ where: { role: "ADMIN" } });
  if (!user) {
    user = await db.user.create({
      data: { email: "system@reorg.internal", name: "System", role: "ADMIN" },
    });
  }
  return user;
}

async function isAllowed() {
  const session = await auth();
  if (session?.user?.id && ["ADMIN", "OPERATOR"].includes(session.user.role)) return true;
  return isAuthBypassEnabled() ? Boolean(await getSystemUser()) : false;
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? 25);
    const rows = await listLabelFormatterExportHistory(limit);
    return NextResponse.json({
      data: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        createdBy: row.createdBy ? { name: row.createdBy.name, email: row.createdBy.email } : null,
        rowCount: row.rowCount,
        orderNumbers: row.orderNumbers,
        sourceStores: row.sourceStores,
        excelFileName: row.excelFileName,
        pdfFileName: row.pdfFileName,
        zipFileName: row.zipFileName,
      })),
    });
  } catch (error) {
    console.error("[label-formatter/history] failed", error);
    return NextResponse.json({ error: "Failed to load Label Formatter history." }, { status: 500 });
  }
}
