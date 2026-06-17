import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { checkPageAccess } from "@/lib/page-access";
import { commitReturnAction } from "@/lib/services/helpdesk-returns";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ returnId: string }>;
}

const bodySchema = z.object({
  idempotencyKey: z.string().uuid(),
  typedConfirmation: z.string().max(40).optional(),
});

/**
 * POST /api/helpdesk/returns/[returnId]/commit
 *
 * Executes a previously-previewed action. The service re-fetches the return,
 * runs the safety gate against fresh availability, fires a SINGLE live eBay
 * write, audits the outcome, and refreshes. Idempotent on the preview token.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await checkPageAccess("help-desk-returns")).allowed) {
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

  try {
    const result = await commitReturnAction({
      returnId,
      userId: session.user.id,
      isAdmin: true,
      idempotencyKey: parsed.data.idempotencyKey,
      typedConfirmation: parsed.data.typedConfirmation ?? null,
    });
    if (!result.ok) {
      // BLOCKED → 423 (locked), other failures → 400.
      const status = result.status === "BLOCKED" ? 423 : 400;
      return NextResponse.json({ error: result.error, status: result.status }, { status });
    }
    return NextResponse.json({ data: result });
  } catch (err) {
    console.error("[helpdesk/returns/commit] failed", err);
    return NextResponse.json({ error: "Failed to commit action." }, { status: 500 });
  }
}
