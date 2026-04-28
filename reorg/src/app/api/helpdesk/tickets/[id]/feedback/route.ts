import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { buildEbayConfig } from "@/lib/services/auto-responder-ebay";
import { getOrderContextCached } from "@/lib/services/helpdesk-order-context-cache";
import {
  feedbackMirrorToSnapshot,
  fetchEbayFeedbackForOrderContext,
} from "@/lib/services/helpdesk-feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/helpdesk/tickets/[id]/feedback
 *
 * Read-only feedback truth for the right rail. We prefer the local
 * HelpdeskFeedback mirror, but if that mirror is empty for an order-linked
 * ticket we do one targeted eBay GetFeedback lookup from the order line item.
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
      integrationId: true,
      ebayOrderNumber: true,
      ebayItemId: true,
      buyerUserId: true,
      integration: {
        select: { id: true, platform: true, config: true },
      },
    },
  });

  if (!ticket) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const mirrorOr: Prisma.HelpdeskFeedbackWhereInput[] = [{ ticketId: ticket.id }];
  if (ticket.ebayOrderNumber) {
    mirrorOr.push({
      integrationId: ticket.integrationId,
      ebayOrderNumber: ticket.ebayOrderNumber,
    });
  }
  if (ticket.buyerUserId && ticket.ebayItemId) {
    mirrorOr.push({
      integrationId: ticket.integrationId,
      ebayItemId: ticket.ebayItemId,
      buyerUserId: {
        equals: ticket.buyerUserId,
        mode: Prisma.QueryMode.insensitive,
      },
    });
  }

  const mirrorRows = await db.helpdeskFeedback.findMany({
    where: {
      integrationId: ticket.integrationId,
      OR: mirrorOr,
    },
    orderBy: { leftAt: "desc" },
    take: 20,
  });

  if (mirrorRows.length > 0) {
    return NextResponse.json({
      data: {
        state: "LEFT",
        items: mirrorRows.map(feedbackMirrorToSnapshot),
        checkedLive: false,
      },
    });
  }

  const platform = ticket.integration.platform;
  const isEbay = platform === "TPP_EBAY" || platform === "TT_EBAY";
  if (!isEbay || !ticket.ebayOrderNumber) {
    return NextResponse.json({
      data: { state: "UNKNOWN", items: [], checkedLive: false },
    });
  }

  try {
    const config = buildEbayConfig({ config: ticket.integration.config });
    const order = await getOrderContextCached(
      ticket.integration.id,
      config,
      ticket.ebayOrderNumber,
      { awaitFresh: true },
    );
    if (!order) {
      return NextResponse.json({
        data: {
          state: "UNKNOWN",
          items: [],
          checkedLive: false,
          reason: "Order context unavailable.",
        },
      });
    }

    const live = await fetchEbayFeedbackForOrderContext({
      integrationId: ticket.integration.id,
      config,
      order,
    });
    return NextResponse.json({
      data: {
        state: live.length > 0 ? "LEFT" : "NOT_LEFT",
        items: live,
        checkedLive: true,
      },
    });
  } catch (err) {
    console.warn(
      "[helpdesk/feedback] live feedback lookup failed",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({
      data: {
        state: "UNKNOWN",
        items: [],
        checkedLive: false,
        reason: "Feedback lookup failed.",
      },
    });
  }
}
