/**
 * Presence endpoints for the "green eye" feature in the inbox Status
 * column. Two halves of the same conversation:
 *
 *   GET  /api/helpdesk/tickets/:id/presence
 *        Returns the list of agents currently viewing this ticket.
 *        Used by both the ticket detail header (to show "Cory is also
 *        looking at this") AND by the inbox row's Status column (to flip
 *        the mailbox icon to a green eye).
 *
 *   POST /api/helpdesk/tickets/:id/presence
 *        Heartbeat. The viewer's tab calls this every ~8s while the tab
 *        is in the foreground. Each heartbeat extends the row's
 *        `expiresAt` so the GET above only returns *currently active*
 *        viewers — when an agent closes the tab or backgrounds it,
 *        the row goes stale and disappears from the next poll.
 *
 *   DELETE /api/helpdesk/tickets/:id/presence
 *        Best-effort signal-out used on tab unload. Not required —
 *        the expiresAt window will clean up either way.
 *
 * The 8-second cadence was chosen over Server-Sent Events for v1 to keep
 * the deploy surface small. Trade-off: presence updates lag by ~8s, which
 * is fine for "is anyone else in here right now?" UX.
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Window after a heartbeat during which a viewer is considered "still
 * here". Slightly longer than the client cadence (8s) so a single skipped
 * heartbeat doesn't blink the green eye off and on.
 */
const PRESENCE_TTL_MS = 25_000;

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: ticketId } = await params;
  const now = new Date();
  const rows = await db.helpdeskPresence.findMany({
    where: { ticketId, expiresAt: { gt: now } },
    select: {
      userId: true,
      lastSeenAt: true,
      presenceState: true,
      user: {
        select: { id: true, name: true, email: true, avatarUrl: true, handle: true },
      },
    },
    orderBy: { lastSeenAt: "desc" },
  });
  return NextResponse.json({
    data: rows.map((r) => ({
      userId: r.userId,
      lastSeenAt: r.lastSeenAt,
      presenceState: r.presenceState,
      isSelf: r.userId === session.user!.id,
      user: r.user,
    })),
  });
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: ticketId } = await params;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PRESENCE_TTL_MS);

  // Upsert keyed on (ticketId, userId) so repeated heartbeats from the
  // same agent simply slide the window forward — no row churn, no audit
  // noise. We don't write an audit row for heartbeats; the inbox merely
  // displays presence, it doesn't track history.
  await db.helpdeskPresence.upsert({
    where: { ticketId_userId: { ticketId, userId: session.user.id } },
    create: {
      ticketId,
      userId: session.user.id,
      lastSeenAt: now,
      expiresAt,
      presenceState: "viewer",
    },
    update: {
      lastSeenAt: now,
      expiresAt,
      presenceState: "viewer",
    },
  });
  return NextResponse.json({ data: { ok: true, expiresAt } });
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: ticketId } = await params;
  await db.helpdeskPresence
    .delete({
      where: { ticketId_userId: { ticketId, userId: session.user.id } },
    })
    .catch(() => null); // already gone is fine
  return NextResponse.json({ data: { ok: true } });
}
