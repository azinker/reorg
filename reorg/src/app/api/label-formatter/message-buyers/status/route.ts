import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { getOutboundJobStatuses } from "@/lib/label-formatter/message-buyers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function isAllowed() {
  const session = await auth();
  if (session?.user?.id && ["ADMIN", "OPERATOR"].includes(session.user.role)) {
    return true;
  }
  if (isAuthBypassEnabled()) {
    return Boolean(await db.user.findFirst({ where: { role: "ADMIN" } }));
  }
  return false;
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get("jobIds") ?? "";
  const jobIds = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 200);

  const data = await getOutboundJobStatuses(jobIds);
  return NextResponse.json({ data });
}
