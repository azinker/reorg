import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { previewReturnAction } from "@/lib/services/helpdesk-returns";
import type { ReturnActionKey } from "@/lib/helpdesk/returns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ returnId: string }>;
}

const bodySchema = z.object({
  action: z.enum([
    "APPROVE_RETURN",
    "OFFER_PARTIAL_REFUND",
    "UPLOAD_LABEL",
    "PROVIDE_EBAY_LABEL",
    "CONFIRM_LABEL_SENT",
    "MARK_AS_RECEIVED",
    "ISSUE_REFUND",
  ]),
  amount: z.number().positive().optional(),
  deductionType: z.enum(["none", "percent", "amount"]).optional(),
  deductionValue: z.number().min(0).optional(),
  deductionReason: z.string().max(500).optional(),
  deductionComment: z.string().max(1000).optional(),
  carrierEnum: z.string().max(40).optional(),
  trackingNumber: z.string().max(60).optional(),
  comments: z.string().max(1000).optional(),
  // UPLOAD_LABEL: base64 (no data: prefix) of the PDF/image label, ~10MB cap.
  labelFileData: z.string().max(14_000_000).optional(),
  labelFileName: z.string().max(200).optional(),
});

/**
 * POST /api/helpdesk/returns/[returnId]/preview
 *
 * Validates the action server-side and returns a normalized confirmation
 * summary + an idempotency token. NO eBay write happens here. The token must
 * be echoed back to the commit endpoint.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { returnId } = await params;
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { action, ...rest } = parsed.data;

  try {
    const result = await previewReturnAction({
      returnId,
      userId: session.user.id,
      action: action as ReturnActionKey,
      params: rest,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ data: result });
  } catch (err) {
    console.error("[helpdesk/returns/preview] failed", err);
    return NextResponse.json({ error: "Failed to build preview." }, { status: 500 });
  }
}
