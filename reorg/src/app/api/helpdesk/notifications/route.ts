/**
 * GET /api/helpdesk/notifications — list unread/recent notifications for the
 * current user. Used by the Mentioned folder badge and a future bell icon.
 *
 * POST /api/helpdesk/notifications/read — mark all current user's
 * notifications as read.
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const onlyUnread = request.nextUrl.searchParams.get("unread") === "1";
  const items = await db.helpdeskNotification.findMany({
    where: {
      recipientId: session.user.id,
      ...(onlyUnread ? { readAt: null } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const unreadCount = await db.helpdeskNotification.count({
    where: { recipientId: session.user.id, readAt: null },
  });
  return NextResponse.json({
    data: items.map((n) => ({
      id: n.id,
      ticketId: n.ticketId,
      kind: n.kind,
      bodyText: n.bodyText,
      url: n.url,
      readAt: n.readAt,
      createdAt: n.createdAt,
    })),
    unreadCount,
  });
}
