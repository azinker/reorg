import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Platform } from "@prisma/client";
import { auth } from "@/lib/auth";
import {
  listReturnCases,
  getReturnsAttentionSummary,
} from "@/lib/services/helpdesk-returns";
import {
  RETURN_STATUS_FILTERS,
  type ReturnStatusFilterKey,
} from "@/lib/helpdesk/returns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  store: z.enum(["TPP_EBAY", "TT_EBAY"]).optional(),
  status: z
    .enum([
      "needs_attention",
      "open_all",
      "open_replacements",
      "open_returns",
      "in_progress",
      "shipped",
      "delivered",
      "closed",
    ])
    .optional(),
  q: z.string().max(200).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  sort: z.enum(["opened_desc", "opened_asc", "deadline_asc"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

function parseDate(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * GET /api/helpdesk/returns — combined TPP+TT returns from the local cache.
 * Admin-only in v1. Also returns the needs-attention badge count + filter defs.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { store, status, q, from, to, sort, page, pageSize } = parsed.data;

  try {
    const [list, attention] = await Promise.all([
      listReturnCases({
        platform: store ? (store as Platform) : null,
        status: (status as ReturnStatusFilterKey | undefined) ?? null,
        search: q ?? null,
        fromDate: parseDate(from),
        toDate: parseDate(to),
        sort,
        page,
        pageSize,
      }),
      getReturnsAttentionSummary(),
    ]);
    return NextResponse.json({
      data: {
        ...list,
        needsAttention: attention.total,
        needsAttentionByStore: attention.byPlatform,
        filters: RETURN_STATUS_FILTERS,
      },
    });
  } catch (err) {
    console.error("[helpdesk/returns] list failed", err);
    return NextResponse.json({ error: "Failed to load returns." }, { status: 500 });
  }
}
