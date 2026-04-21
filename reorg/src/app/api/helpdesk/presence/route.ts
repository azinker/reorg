/**
 * GET /api/helpdesk/presence?ticketIds=a,b,c
 *
 * Bulk presence lookup for the inbox table's Status column. The detail
 * route at /api/helpdesk/tickets/:id/presence is great for the open
 * ticket header but rendering N=50 visible inbox rows can't fan out into
 * 50 individual requests every 8 seconds — that would hammer the DB.
 *
 * Returns a map keyed by ticketId of the *currently active* viewers
 * (excluding stale rows past `expiresAt`). Empty arrays for ticketIds
 * with no presence are omitted to keep the response compact.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  ticketIds: z
    .string()
    .min(1)
    .transform((v) =>
      Array.from(new Set(v.split(",").map((s) => s.trim()).filter(Boolean))),
    )
    .refine((arr) => arr.length > 0 && arr.length <= 200, {
      message: "Provide 1-200 ticketIds",
    }),
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    ticketIds: url.searchParams.get("ticketIds") ?? "",
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const ticketIds = parsed.data.ticketIds;
  const now = new Date();
  const rows = await db.helpdeskPresence.findMany({
    where: { ticketId: { in: ticketIds }, expiresAt: { gt: now } },
    select: {
      ticketId: true,
      userId: true,
      lastSeenAt: true,
      presenceState: true,
      user: {
        select: { id: true, name: true, avatarUrl: true, handle: true },
      },
    },
  });
  const byTicket: Record<
    string,
    Array<{
      userId: string;
      isSelf: boolean;
      lastSeenAt: Date;
      presenceState: string;
      user: { id: string; name: string | null; avatarUrl: string | null; handle: string | null };
    }>
  > = {};
  for (const r of rows) {
    const list = byTicket[r.ticketId] ?? [];
    list.push({
      userId: r.userId,
      isSelf: r.userId === session.user!.id,
      lastSeenAt: r.lastSeenAt,
      presenceState: r.presenceState,
      user: r.user,
    });
    byTicket[r.ticketId] = list;
  }
  return NextResponse.json({ data: byTicket });
}
