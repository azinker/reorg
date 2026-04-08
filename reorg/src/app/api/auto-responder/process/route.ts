import { NextResponse, type NextRequest } from "next/server";
import { processAutoResponderJobs } from "@/lib/services/auto-responder";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const authHeader = request.headers.get("authorization");
  const bearerSecret = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const cronSecret = request.headers.get("x-cron-secret");
  return bearerSecret === secret || cronSecret === secret;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await processAutoResponderJobs();
  return NextResponse.json({ data: result });
}
