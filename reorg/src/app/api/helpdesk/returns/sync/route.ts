import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { checkPageAccess } from "@/lib/page-access";
import { runHelpdeskReturnsSync } from "@/lib/services/helpdesk-returns-sync";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * POST /api/helpdesk/returns/sync — admin-triggered pull-only returns sync.
 * READ-ONLY against eBay (mirrors return state into our cache). No eBay writes.
 */
export async function POST(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await checkPageAccess("help-desk-returns")).allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const result = await runHelpdeskReturnsSync();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[helpdesk/returns/sync] failed", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
