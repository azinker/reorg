import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { checkPageAccess } from "@/lib/page-access";
import { getReturnCorrespondence } from "@/lib/services/helpdesk-returns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ returnId: string }>;
}

/**
 * GET /api/helpdesk/returns/[returnId]/correspondence
 *
 * Read-only: returns the Help Desk message threads tied to this return's buyer
 * so the detail page can show the conversation inline. Never writes.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await checkPageAccess("help-desk-returns")).allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { returnId } = await params;
  try {
    const data = await getReturnCorrespondence(returnId);
    if (!data) {
      return NextResponse.json({ error: "Return not found." }, { status: 404 });
    }
    return NextResponse.json({ data });
  } catch (err) {
    console.error("[helpdesk/returns/correspondence] failed", err);
    return NextResponse.json({ error: "Failed to load correspondence." }, { status: 500 });
  }
}
