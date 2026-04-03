import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { parseInputLines, identifyOrders } from "@/lib/services/ship-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
    if (parsedLines.length > 1000) {
      return NextResponse.json(
        { error: "At most 1000 orders per request." },
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
