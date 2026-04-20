/**
 * GET /api/helpdesk/agents
 *
 * Returns the list of users who can be assigned to a Help Desk ticket. Used to
 * populate the assignee picker, the "@ mention" suggestions, and to render
 * avatars on assigned tickets.
 *
 * We return both ADMIN and OPERATOR roles. Order: ADMINs first, then by name.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const users = await db.user.findMany({
    where: { role: { in: ["ADMIN", "OPERATOR"] } },
    select: {
      id: true,
      name: true,
      email: true,
      handle: true,
      avatarUrl: true,
      title: true,
      role: true,
    },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });

  return NextResponse.json({ data: users });
}
