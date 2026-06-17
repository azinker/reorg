import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { getReturnFileDownload } from "@/lib/services/helpdesk-returns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ returnId: string; fileId: string }>;
}

/**
 * GET /api/helpdesk/returns/[returnId]/files/[fileId]/download
 *
 * Streams a return file (e.g. the return shipping label) to the browser.
 * We resolve the bytes server-side rather than linking to eBay's hosted URL,
 * which is a short-lived pre-signed link that expires (~15 min) and often
 * won't resolve from a browser. Read-only against eBay.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { returnId, fileId } = await params;
  const file = await getReturnFileDownload(returnId, fileId);
  if (!file) {
    return NextResponse.json(
      { error: "Label file is no longer available to download." },
      { status: 404 },
    );
  }

  const safeName = file.fileName.replace(/[^\w.\-]+/g, "_") || "return-label";
  return new NextResponse(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Content-Length": String(file.bytes.length),
      "Cache-Control": "private, no-store",
    },
  });
}
