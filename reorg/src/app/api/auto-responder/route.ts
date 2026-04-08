import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createResponder } from "@/lib/services/auto-responder";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  messageName: z.string().min(1).max(100),
  channel: z.enum(["TPP_EBAY", "TT_EBAY"]),
  subjectTemplate: z.string().min(1),
  bodyTemplate: z.string().min(1),
});

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sp = request.nextUrl.searchParams;
    const channel = sp.get("channel") as "TPP_EBAY" | "TT_EBAY" | null;
    const showArchived = sp.get("showArchived") === "true";

    const where: Record<string, unknown> = {};
    if (channel) where.channel = channel;
    if (!showArchived) where.status = { not: "ARCHIVED" };

    const responders = await db.autoResponder.findMany({
      where,
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      include: {
        integration: { select: { label: true, enabled: true, platform: true } },
      },
    });

    const ids = responders.map((r) => r.id);

    // Count sent and failed separately
    const sentCounts = ids.length > 0
      ? await db.autoResponderSendLog.groupBy({
          by: ["responderId"],
          where: { responderId: { in: ids }, eventType: "SENT" },
          _count: true,
        })
      : [];
    const sentMap = new Map(sentCounts.map((s) => [s.responderId, s._count]));

    const failureCounts = ids.length > 0
      ? await db.autoResponderSendLog.groupBy({
          by: ["responderId"],
          where: { responderId: { in: ids }, eventType: "FAILED" },
          _count: true,
        })
      : [];
    const failureMap = new Map(failureCounts.map((f) => [f.responderId, f._count]));

    const lastSentMap = new Map<string, Date>();
    if (ids.length > 0) {
      const lastSentRows = await db.autoResponderSendLog.findMany({
        where: { responderId: { in: ids }, eventType: "SENT" },
        orderBy: { sentAt: "desc" },
        distinct: ["responderId"],
        select: { responderId: true, sentAt: true },
      });
      for (const row of lastSentRows) {
        if (row.responderId && row.sentAt) lastSentMap.set(row.responderId, row.sentAt);
      }
    }

    const data = responders.map((r) => ({
      id: r.id,
      messageName: r.messageName,
      channel: r.channel,
      status: r.status,
      activatedAt: r.activatedAt,
      updatedAt: r.updatedAt,
      createdAt: r.createdAt,
      integrationLabel: r.integration.label,
      integrationEnabled: r.integration.enabled,
      totalSent: sentMap.get(r.id) ?? 0,
      totalFailures: failureMap.get(r.id) ?? 0,
      lastSent: lastSentMap.get(r.id) ?? null,
    }));

    return NextResponse.json({ data });
  } catch (err) {
    console.error("[auto-responder] GET failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load responders" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  try {
    const responder = await createResponder(parsed.data, session.user.id);
    return NextResponse.json({ data: responder }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}
