import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  buildEbayConfig,
  type EbayOrderContext,
} from "@/lib/services/auto-responder-ebay";
import { getOrderContextCached } from "@/lib/services/helpdesk-order-context-cache";
import {
  applyFeedbackRemovals,
  feedbackMirrorToSnapshot,
  fetchEbayFeedbackForOrderContext,
  filterFeedbackSnapshotsToOrder,
  findFeedbackRemovalNotices,
  suppressReplacedAutomatedFeedback,
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
 * order line item. eBay automated feedback is returned with an explicit
 * isAutomated flag so the UI can distinguish it from buyer-authored feedback.
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

  // Mirror rows from GetFeedback never carry the "26-xxxxx-xxxxx" order
  // number directly (eBay doesn't return it), so match by order number OR
  // direct ticket linkage OR (item + buyer) — the latter covers every
  // historical mirror row synced before order-number backfill existed.
  const mirrorOr: Prisma.HelpdeskFeedbackWhereInput[] = [
    { ebayOrderNumber: ticket.ebayOrderNumber },
    { ticketId: ticket.id },
  ];
  if (ticket.ebayItemId && ticket.buyerUserId) {
    mirrorOr.push({
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

  // Feedback on eBay is per order line (transaction). When the buyer bought
  // the SAME listing on two different orders, the (item + buyer) fallback
  // above matches both orders' feedback — so we scope the mirror rows to
  // this order's transactions using the cached order context. The context is
  // shared with the right rail (in-flight deduped), so this is one eBay call
  // at most across the whole ticket open.
  let order: EbayOrderContext | null = null;
  let config: ReturnType<typeof buildEbayConfig> | null = null;
  try {
    config = buildEbayConfig({ config: ticket.integration.config });
    order =
      (await getOrderContextCached(
        ticket.integration.id,
        config,
        ticket.ebayOrderNumber,
        { awaitFresh: true },
      )) ?? null;
  } catch (err) {
    console.warn(
      "[helpdesk/feedback] order context lookup failed",
      err instanceof Error ? err.message : err,
    );
  }

  const mirrorSnapshots = filterFeedbackSnapshotsToOrder(
    mirrorRows.map(feedbackMirrorToSnapshot),
    {
      ebayOrderNumber: ticket.ebayOrderNumber,
      lineItems: order?.lineItems ?? null,
    },
  );

  // Removal history is derived from the order's "Feedback Removal Approved"
  // system tickets — read-only, no eBay call. Non-fatal on failure.
  let removalNotices: Awaited<ReturnType<typeof findFeedbackRemovalNotices>> = [];
  try {
    removalNotices = await findFeedbackRemovalNotices({
      integrationId: ticket.integrationId,
      ebayOrderNumber: ticket.ebayOrderNumber,
    });
  } catch (err) {
    console.warn("[helpdesk/feedback] removal notice lookup failed", err);
  }
  const removals = removalNotices.map((n) => ({ at: n.at }));

  if (mirrorSnapshots.length > 0) {
    return NextResponse.json({
      data: {
        state: "LEFT",
        // Buyer-authored feedback REPLACES the automated entry on eBay, so a
        // superseded automated snapshot must not render alongside it.
        items: applyFeedbackRemovals(
          suppressReplacedAutomatedFeedback(mirrorSnapshots),
          removalNotices,
        ),
        checkedLive: false,
        removals,
      },
    });
  }

  try {
    if (!order || !config) {
      return NextResponse.json({
        data: {
          state: "UNKNOWN",
          items: [],
          checkedLive: false,
          removals,
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
        items: applyFeedbackRemovals(
          suppressReplacedAutomatedFeedback(live),
          removalNotices,
        ),
        checkedLive: true,
        removals,
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
        removals,
        reason: "Feedback lookup failed.",
      },
    });
  }
}
