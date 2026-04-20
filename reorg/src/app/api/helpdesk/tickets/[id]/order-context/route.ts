import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { buildEbayConfig } from "@/lib/services/auto-responder-ebay";
import { getOrderContextCached } from "@/lib/services/helpdesk-order-context-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/helpdesk/tickets/[id]/order-context
 *
 * Returns the eBay order details for a post-order ticket so the right-hand
 * Context Panel can show tracking, shipping address, line items, and totals.
 *
 * - Read-only: never writes back to eBay (per safety rules).
 * - Cache: 5-min TTL via the shared `helpdesk-order-context-cache` module so
 *   the events route can reuse the same response without a second eBay round-trip.
 * - Returns `{ data: null, reason: "..." }` for tickets without an order
 *   number or for non-eBay channels — UI degrades gracefully.
 * - 404 for unknown ticket IDs.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const ticket = await db.helpdeskTicket.findUnique({
    where: { id },
    select: {
      id: true,
      ebayOrderNumber: true,
      integration: {
        select: { id: true, platform: true, config: true },
      },
    },
  });

  if (!ticket) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const platform = ticket.integration?.platform;
  if (platform !== "TPP_EBAY" && platform !== "TT_EBAY") {
    return NextResponse.json({
      data: null,
      reason: "Order context lookup is only supported for eBay tickets.",
    });
  }

  if (!ticket.ebayOrderNumber) {
    return NextResponse.json({
      data: null,
      reason: "This ticket isn't linked to an order.",
    });
  }

  try {
    const config = buildEbayConfig({ config: ticket.integration.config });
    const ctx = await getOrderContextCached(
      ticket.integration.id,
      config,
      ticket.ebayOrderNumber,
      { awaitFresh: true },
    );
    return NextResponse.json({ data: ctx ?? null });
  } catch (err) {
    console.error("[helpdesk/order-context] fetch failed:", err);
    return NextResponse.json(
      {
        data: null,
        reason: "Couldn't read this order from eBay right now. Try again in a moment.",
      },
      { status: 200 },
    );
  }
}
