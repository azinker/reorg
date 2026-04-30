import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { buildEbayConfig } from "@/lib/services/auto-responder-ebay";
import { getOrderContextCached } from "@/lib/services/helpdesk-order-context-cache";
import {
  feedbackMirrorToSnapshot,
  fetchEbayFeedbackForOrderContext,
  isEbayAutomatedFeedbackSnapshot,
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
 * HelpdeskFeedback mirror only when it is tied to the exact order. If the
 * mirror is empty/stale, we do one targeted eBay GetFeedback lookup from the
 * order line item. eBay automated feedback is ignored here because the buyer
 * has not actually left feedback yet and can still replace it.
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

  const platform = ticket.integration.platform;
  const isEbay = platform === "TPP_EBAY" || platform === "TT_EBAY";
  if (!isEbay || !ticket.ebayOrderNumber) {
    return NextResponse.json({
      data: { state: "UNKNOWN", items: [], checkedLive: false },
    });
  }

  const mirrorRows = await db.helpdeskFeedback.findMany({
    where: {
      integrationId: ticket.integrationId,
      ebayOrderNumber: ticket.ebayOrderNumber,
    },
    orderBy: { leftAt: "desc" },
    take: 20,
  });
  const mirrorSnapshots = mirrorRows
    .map(feedbackMirrorToSnapshot)
    .filter((entry) => !isEbayAutomatedFeedbackSnapshot(entry));

  if (mirrorSnapshots.length > 0) {
    return NextResponse.json({
      data: {
        state: "LEFT",
        items: mirrorSnapshots,
        checkedLive: false,
      },
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
