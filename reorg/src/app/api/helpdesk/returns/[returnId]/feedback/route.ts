import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { checkPageAccess } from "@/lib/page-access";
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
  params: Promise<{ returnId: string }>;
}

function validDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function earliestDate(dates: Array<Date | null>): Date | null {
  const valid = dates.filter((d): d is Date => Boolean(d));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (b.getTime() < a.getTime() ? b : a));
}

/**
 * Buyer feedback leave-by deadline, mirroring the right-rail logic: 60 days
 * after delivery/expected delivery, else 90 days after purchase.
 */
function feedbackLeaveByIso(order: EbayOrderContext | null): string | null {
  const delivered = earliestDate([
    validDate(order?.actualDeliveryTime),
    validDate(order?.estimatedDeliveryMax ?? order?.estimatedDeliveryMin),
  ]);
  if (delivered) return new Date(delivered.getTime() + 60 * 86_400_000).toISOString();
  const purchased = validDate(order?.createdTime ?? order?.paidTime);
  return purchased ? new Date(purchased.getTime() + 90 * 86_400_000).toISOString() : null;
}

/**
 * GET /api/helpdesk/returns/[returnId]/feedback
 *
 * Same read-only buyer-feedback truth the Help Desk ticket right rail uses,
 * keyed off the return case's order instead of a ticket. Reuses the shared
 * `helpdesk-feedback` helpers verbatim so the two stay in lock-step.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await checkPageAccess("help-desk-returns")).allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { returnId } = await params;
  const caseRow = await db.helpdeskReturnCase.findFirst({
    where: { returnId },
    select: {
      id: true,
      integrationId: true,
      ebayOrderNumber: true,
      ebayItemId: true,
      buyerUserId: true,
      ticketId: true,
    },
  });

  if (!caseRow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const integration = await db.integration.findUnique({
    where: { id: caseRow.integrationId },
    select: { id: true, platform: true, config: true },
  });
  if (!integration) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const platform = integration.platform;
  const isEbay = platform === "TPP_EBAY" || platform === "TT_EBAY";
  if (!isEbay || !caseRow.ebayOrderNumber) {
    return NextResponse.json({
      data: { state: "UNKNOWN", items: [], checkedLive: false, leaveBy: null },
    });
  }

  // Match the mirror by order number / linked ticket / (item + buyer) — same
  // precedence as the ticket route, since GetFeedback rows don't carry the
  // "26-xxxxx-xxxxx" order number.
  const mirrorOr: Prisma.HelpdeskFeedbackWhereInput[] = [
    { ebayOrderNumber: caseRow.ebayOrderNumber },
  ];
  if (caseRow.ticketId) mirrorOr.push({ ticketId: caseRow.ticketId });
  if (caseRow.ebayItemId && caseRow.buyerUserId) {
    mirrorOr.push({
      ebayItemId: caseRow.ebayItemId,
      buyerUserId: {
        equals: caseRow.buyerUserId,
        mode: Prisma.QueryMode.insensitive,
      },
    });
  }
  const mirrorRows = await db.helpdeskFeedback.findMany({
    where: { integrationId: caseRow.integrationId, OR: mirrorOr },
    orderBy: { leftAt: "desc" },
    take: 20,
  });

  let order: EbayOrderContext | null = null;
  let config: ReturnType<typeof buildEbayConfig> | null = null;
  try {
    config = buildEbayConfig({ config: integration.config });
    order =
      (await getOrderContextCached(
        integration.id,
        config,
        caseRow.ebayOrderNumber,
        { awaitFresh: true },
      )) ?? null;
  } catch (err) {
    console.warn(
      "[helpdesk/returns/feedback] order context lookup failed",
      err instanceof Error ? err.message : err,
    );
  }
  const leaveBy = feedbackLeaveByIso(order);

  const mirrorSnapshots = filterFeedbackSnapshotsToOrder(
    mirrorRows.map(feedbackMirrorToSnapshot),
    {
      ebayOrderNumber: caseRow.ebayOrderNumber,
      lineItems: order?.lineItems ?? null,
    },
  );

  let removalNotices: Awaited<ReturnType<typeof findFeedbackRemovalNotices>> = [];
  try {
    removalNotices = await findFeedbackRemovalNotices({
      integrationId: caseRow.integrationId,
      ebayOrderNumber: caseRow.ebayOrderNumber,
    });
  } catch (err) {
    console.warn("[helpdesk/returns/feedback] removal notice lookup failed", err);
  }
  const removals = removalNotices.map((n) => ({ at: n.at }));

  if (mirrorSnapshots.length > 0) {
    return NextResponse.json({
      data: {
        state: "LEFT",
        items: applyFeedbackRemovals(
          suppressReplacedAutomatedFeedback(mirrorSnapshots),
          removalNotices,
        ),
        checkedLive: false,
        removals,
        leaveBy,
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
          leaveBy,
          reason: "Order context unavailable.",
        },
      });
    }
    const live = await fetchEbayFeedbackForOrderContext({
      integrationId: integration.id,
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
        leaveBy,
      },
    });
  } catch (err) {
    console.warn(
      "[helpdesk/returns/feedback] live feedback lookup failed",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({
      data: {
        state: "UNKNOWN",
        items: [],
        checkedLive: false,
        removals,
        leaveBy,
        reason: "Feedback lookup failed.",
      },
    });
  }
}
