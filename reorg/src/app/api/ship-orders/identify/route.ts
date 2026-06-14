import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { parseInputLines, identifyOrders } from "@/lib/services/ship-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Upper bound for a SINGLE identify call. The UI chunks well below this
 * (IDENTIFY_CHUNK_SIZE in ShipOrdersPanel), so this only caps oversized
 * direct/manual requests to keep one serverless invocation inside its time
 * budget. Raised past the old 1000 because eBay lookups are batched and the
 * numeric paths are the real constraint, not the total count.
 */
const MAX_ORDERS_PER_IDENTIFY_REQUEST = 2000;

const bodySchema = z.object({
  /** Raw pasted text — one order+tracking pair per line, tab or double-space separated. */
  lines: z.string().min(1).max(200_000),
});

async function getSystemUser() {
  let user = await db.user.findFirst({ where: { role: "ADMIN" } });
  if (!user) {
    user = await db.user.create({
      data: { email: "system@reorg.internal", name: "System", role: "ADMIN" },
    });
  }
  return user;
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    const actorUserId =
      session?.user?.id ?? (isAuthBypassEnabled() ? (await getSystemUser()).id : null);

    if (!actorUserId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const json = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const parsedLines = parseInputLines(parsed.data.lines);
    if (parsedLines.length === 0) {
      return NextResponse.json(
        { error: "No valid order+tracking pairs found. Each line must have an order number and tracking number separated by a tab or two spaces." },
        { status: 400 },
      );
    }
    // Per-request safety bound only. The Ship Orders UI chunks large pastes
    // client-side (IDENTIFY_CHUNK_SIZE) so there is no limit on how many
    // orders a user can identify in one batch — each call just stays small
    // enough to finish inside the serverless time budget. This guard protects
    // a single invocation (e.g. a direct API call) from timing out on the
    // low-concurrency BigCommerce/Shopify/Amazon lookups.
    if (parsedLines.length > MAX_ORDERS_PER_IDENTIFY_REQUEST) {
      return NextResponse.json(
        {
          error: `At most ${MAX_ORDERS_PER_IDENTIFY_REQUEST} orders per request. Split larger batches into multiple requests (the Ship Orders page does this automatically).`,
        },
        { status: 400 },
      );
    }

    const results = await identifyOrders(parsedLines);

    return NextResponse.json({ data: { results } });
  } catch (error) {
    console.error("[ship-orders/identify] Failed", error);
    return NextResponse.json({ error: "Failed to identify orders" }, { status: 500 });
  }
}
