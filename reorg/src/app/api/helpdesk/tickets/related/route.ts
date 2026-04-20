import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/helpdesk/tickets/related?buyer=<userId>&exclude=<ticketId>&limit=10
 *
 * Returns the other tickets we have on file for the same buyer so the right-hand
 * Context Panel can render a "previous conversations" list. Used by the customer
 * card to compute things like "(N orders)".
 *
 * Read-only. Buyer ID match is exact — we don't fuzzy-match across handles
 * because eBay user IDs are stable and unique enough for this purpose.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const buyer = url.searchParams.get("buyer")?.trim();
  const exclude = url.searchParams.get("exclude")?.trim() || undefined;
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;

  if (!buyer) {
    return NextResponse.json({ data: [], total: 0 });
  }

  const where = {
    buyerUserId: buyer,
    ...(exclude ? { id: { not: exclude } } : {}),
  };

  const [rawRows, total] = await Promise.all([
    db.helpdeskTicket.findMany({
      where,
      // Sort by the most recent activity. updatedAt is bumped on every message
      // insert / status change, so it's a safer "freshness" signal than the
      // dedicated lastBuyerMessageAt (which is null for tickets the agent
      // initiated themselves).
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: {
        id: true,
        subject: true,
        status: true,
        ebayOrderNumber: true,
        lastBuyerMessageAt: true,
        lastAgentMessageAt: true,
        updatedAt: true,
        unreadCount: true,
        ebayItemTitle: true,
      },
    }),
    db.helpdeskTicket.count({ where }),
  ]);

  // Expose a single "lastMessageAt" so the client doesn't have to know the
  // distinction between buyer / agent messages.
  const rows = rawRows.map((r) => ({
    id: r.id,
    subject: r.subject,
    status: r.status,
    ebayOrderNumber: r.ebayOrderNumber,
    lastMessageAt:
      pickLatest(r.lastAgentMessageAt, r.lastBuyerMessageAt, r.updatedAt) ??
      r.updatedAt,
    unreadCount: r.unreadCount,
    ebayItemTitle: r.ebayItemTitle,
  }));

  // Distinct order count gives the customer card its "(N orders)" hint.
  // We deliberately scope this to the same buyer (NOT excluding the current
  // ticket) so the count reflects every order they've placed with us.
  const orderRows = await db.helpdeskTicket.findMany({
    where: {
      buyerUserId: buyer,
      ebayOrderNumber: { not: null },
    },
    select: { ebayOrderNumber: true },
  });
  const orderCount = new Set(
    orderRows.map((r) => r.ebayOrderNumber).filter(Boolean) as string[],
  ).size;

  // "Customer Since" — the date of the buyer's first ticket on file. We use
  // this as a proxy for first-purchase date until we wire the eBay order
  // history into the right rail. Including the excluded ticket here is
  // intentional: the agent expects "Customer Since" to be the earliest
  // contact, even when they're currently looking at the most recent ticket.
  const earliestTicket = await db.helpdeskTicket.findFirst({
    where: { buyerUserId: buyer },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const earliestTicketAt = earliestTicket?.createdAt
    ? earliestTicket.createdAt.toISOString()
    : null;

  return NextResponse.json({
    data: rows,
    total,
    orderCount,
    earliestTicketAt,
  });
}

function pickLatest(...dates: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (!best || d.getTime() > best.getTime()) best = d;
  }
  return best;
}
