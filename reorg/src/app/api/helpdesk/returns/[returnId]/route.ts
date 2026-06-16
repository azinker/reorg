import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import {
  getReturnCaseDetail,
  refreshReturnDetail,
} from "@/lib/services/helpdesk-returns";
import {
  getSellerActionAvailability,
  getReturnLifecycle,
  isReturnClosed,
  normalizeTotalRefund,
  type EbayAvailableOption,
  type EbayReturnSummary,
} from "@/lib/helpdesk/returns";
import { getReturnsLiveWritesEnabled } from "@/lib/helpdesk/returns-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ returnId: string }>;
}

/**
 * GET /api/helpdesk/returns/[returnId] — full return detail.
 *
 * Hybrid freshness: by default we re-fetch the latest detail from eBay
 * (read-only) so action availability is authoritative, then return the merged
 * DB row + tracking + files + action history + computed availability.
 * Pass ?refresh=0 to skip the live fetch and read from cache only.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { returnId } = await params;
  const refresh = request.nextUrl.searchParams.get("refresh") !== "0";

  let refreshError: string | null = null;
  if (refresh) {
    try {
      const r = await refreshReturnDetail(returnId);
      refreshError = r.error;
    } catch (err) {
      refreshError = err instanceof Error ? err.message : String(err);
    }
  }

  const { caseRow } = await getReturnCaseDetail(returnId);
  if (!caseRow) {
    return NextResponse.json({ error: "Return not found." }, { status: 404 });
  }

  const sellerOptions = (caseRow.sellerAvailableOptions ?? []) as unknown as EbayAvailableOption[];
  const availability = getSellerActionAvailability(sellerOptions);
  const returnsLiveWritesEnabled = await getReturnsLiveWritesEnabled();
  const sellerRefund = normalizeTotalRefund({
    actualRefundAmount: caseRow.refundIsActual
      ? { value: caseRow.sellerRefundValue ?? undefined, currency: caseRow.sellerRefundCurrency ?? undefined }
      : undefined,
    estimatedRefundAmount: !caseRow.refundIsActual
      ? { value: caseRow.sellerRefundValue ?? undefined, currency: caseRow.sellerRefundCurrency ?? undefined }
      : undefined,
  });

  return NextResponse.json({
    data: {
      id: caseRow.id,
      returnId: caseRow.returnId,
      platform: caseRow.platform,
      ebayOrderNumber: caseRow.ebayOrderNumber,
      ebayItemId: caseRow.ebayItemId,
      transactionId: caseRow.transactionId,
      returnQuantity: caseRow.returnQuantity,
      itemTitle: caseRow.itemTitle,
      imageUrl: caseRow.imageUrl,
      sku: caseRow.sku,
      buyerUserId: caseRow.buyerUserId,
      returnState: caseRow.returnState,
      returnStatus: caseRow.returnStatus,
      currentType: caseRow.currentType,
      lifecycle: getReturnLifecycle(caseRow.returnState),
      isClosed: isReturnClosed(caseRow.returnState),
      sellerActionDue: caseRow.sellerActionDue,
      escalated: caseRow.escalated,
      caseId: caseRow.caseId,
      reason: caseRow.reason,
      reasonType: caseRow.reasonType,
      buyerComments: caseRow.buyerComments,
      sellerRefund,
      sellerResponseDueAt: caseRow.sellerResponseDueAt?.toISOString() ?? null,
      buyerResponseDueAt: caseRow.buyerResponseDueAt?.toISOString() ?? null,
      timeoutDate: caseRow.timeoutDate?.toISOString() ?? null,
      openedAt: caseRow.openedAt.toISOString(),
      closedAt: caseRow.closedAt?.toISOString() ?? null,
      ticketId: caseRow.ticketId,
      detailFetchedAt: caseRow.detailFetchedAt?.toISOString() ?? null,
      lastSyncedAt: caseRow.lastSyncedAt.toISOString(),
      availability,
      returnsLiveWritesEnabled,
      trackingEvents: caseRow.trackingEvents.map((t) => ({
        id: t.id,
        carrier: t.carrier,
        trackingNumber: t.trackingNumber,
        eventDate: t.eventDate?.toISOString() ?? null,
        status: t.status,
        location: t.location,
        description: t.description,
      })),
      files: caseRow.files.map((f) => ({
        id: f.id,
        fileName: f.fileName,
        filePurpose: f.filePurpose,
        url: f.url,
        source: f.source,
        createdAt: f.createdAt.toISOString(),
      })),
      actionAttempts: caseRow.actionAttempts.map((a) => ({
        id: a.id,
        actionType: a.actionType,
        status: a.status,
        ebayRequestId: a.ebayRequestId,
        blockReason: a.blockReason,
        errorMessage: a.errorMessage,
        createdAt: a.createdAt.toISOString(),
        committedAt: a.committedAt?.toISOString() ?? null,
      })),
      // Admin-only debug payloads (route is already admin-gated).
      debug: {
        rawSummary: caseRow.rawSummary,
        rawDetail: caseRow.rawDetail as EbayReturnSummary | null,
        refreshError,
      },
    },
  });
}
