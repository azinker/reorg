import { NextResponse, type NextRequest } from "next/server";
import { runHelpdeskReturnsSync } from "@/lib/services/helpdesk-returns-sync";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * Cron: pull-only eBay Returns sync (every 15 min via vercel.json).
 *
 * READ-ONLY against eBay — mirrors return state into our cache. It never fires
 * an eBay write. Authorized by CRON_SECRET (Vercel sends it as a Bearer token);
 * the admin-triggered counterpart at /api/helpdesk/returns/sync uses the
 * session instead. Vercel pings cron URLs via GET, so GET === POST here.
 */
function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const headerSecret = request.headers.get("x-cron-secret");
  const authHeader = request.headers.get("authorization");
  const bearerSecret = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;
  return headerSecret === secret || bearerSecret === secret;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runHelpdeskReturnsSync();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/helpdesk-returns-sync] failed", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export const GET = POST;
