/**
 * POST /api/helpdesk/notifications/read?id=xxx (or no id = mark all as read).
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const id = request.nextUrl.searchParams.get("id");
  const now = new Date();
  if (id) {
    const updated = await db.helpdeskNotification.updateMany({
      where: { id, recipientId: session.user.id, readAt: null },
      data: { readAt: now },
    });
    return NextResponse.json({ data: { updated: updated.count } });
  }
  const updated = await db.helpdeskNotification.updateMany({
    where: { recipientId: session.user.id, readAt: null },
    data: { readAt: now },
  });
  return NextResponse.json({ data: { updated: updated.count } });
}
