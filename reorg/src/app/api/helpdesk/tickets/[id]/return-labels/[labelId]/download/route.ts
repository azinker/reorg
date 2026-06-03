import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { canUseHelpdeskOrderActionsPermission } from "@/lib/helpdesk/order-actions-permission";
import { getActor } from "@/lib/impersonation";
import { downloadLabelCrowLabel } from "@/lib/services/labelcrow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; labelId: string }>;
}

function contentDisposition(filename: string, mode: "inline" | "attachment"): string {
  const safe = filename.replace(/[^\w.\-]+/g, "-") || "return-label.pdf";
  return `${mode}; filename="${safe}"`;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const actor = await getActor();
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canUseHelpdeskOrderActionsPermission(actor)) {
    return NextResponse.json(
      { error: "Return label downloads are not enabled for your user." },
      { status: 403 },
    );
  }

  const { id, labelId } = await params;
  const label = await db.helpdeskReturnLabel.findFirst({
    where: { id: labelId, ticketId: id },
    select: {
      labelCrowId: true,
      labelCrowDownloadUrl: true,
      trackingNumber: true,
      pdfBytes: true,
    },
  });
  if (!label) {
    return NextResponse.json({ error: "Return label not found." }, { status: 404 });
  }

  const mode = request.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
  try {
    if (label.pdfBytes) {
      const filename = `return-label-${label.trackingNumber}.pdf`;
      return new NextResponse(Uint8Array.from(label.pdfBytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": contentDisposition(filename, mode),
        },
      });
    }

    const downloaded = await downloadLabelCrowLabel({
      labelCrowId: label.labelCrowId,
      downloadUrl: label.labelCrowDownloadUrl,
      trackingNumber: label.trackingNumber,
    });
    return new NextResponse(Uint8Array.from(downloaded.bytes), {
      headers: {
        "Content-Type": downloaded.contentType === "application/octet-stream"
          ? "application/pdf"
          : downloaded.contentType,
        "Content-Disposition": contentDisposition(downloaded.filename, mode),
      },
    });
  } catch (err) {
    console.error("[helpdesk/return-labels/download] failed", {
      ticketId: id,
      labelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Could not download this return label." },
      { status: 502 },
    );
  }
}
