import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { BIN_LABEL_MAX_ROW_IDS, buildBinLabelsPdf } from "@/lib/services/bin-label-pdf";
import { queueCurrentRequestBinaryResponseSample } from "@/lib/services/network-transfer-samples";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  rowIds: z.array(z.string().min(1)).min(1).max(BIN_LABEL_MAX_ROW_IDS),
});

async function getSystemUser() {
  let user = await db.user.findFirst({ where: { role: "ADMIN" } });
  if (!user) {
    user = await db.user.create({
      data: {
        email: "system@reorg.internal",
        name: "System",
        role: "ADMIN",
      },
    });
  }
  return user;
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    const actorUserId =
      session?.user?.id ?? (isAuthBypassEnabled() ? (await getSystemUser()).id : null);

    if (!actorUserId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const json = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { rowIds } = parsed.data;

    let pdfBytes: Uint8Array;
    try {
      pdfBytes = await buildBinLabelsPdf(rowIds);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to build PDF";
      if (msg.includes("No ") || msg.includes("At most")) {
        return NextResponse.json({ error: msg }, { status: 400 });
      }
      console.error("[grid/bin-labels] build failed", err);
      return NextResponse.json({ error: "Failed to build bin labels PDF" }, { status: 500 });
    }

    const filename = `bin-labels-${new Date().toISOString().slice(0, 10)}.pdf`;
    queueCurrentRequestBinaryResponseSample({
      bytesEstimate: pdfBytes.byteLength,
      metadata: {
        rowCount: rowIds.length,
        contentType: "application/pdf",
      },
    });
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[grid/bin-labels] Failed", error);
    return NextResponse.json({ error: "Failed to generate bin labels" }, { status: 500 });
  }
}
