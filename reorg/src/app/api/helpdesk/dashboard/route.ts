/**
 * GET /api/helpdesk/dashboard?days=14
 *
 * Aggregate metrics for the Admin/Team Lead dashboard. Computes:
 *   - openByStatus              : count by HelpdeskTicketStatus
 *   - openByKind                : pre_sales vs post_sales
 *   - slaSnapshot               : count of OPEN tickets in each SLA bucket
 *   - perAgent                  : tickets resolved + first-response-min for last N days
 *   - inboundPerDay             : array of { date, count } for last N days
 *   - outboundPerDay            : array of { date, count } for last N days
 *   - heatmap                   : 24x7 buckets of inbound message timestamps
 *
 * Limited to ADMIN/OPERATOR for now — both can view the operations view.
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { HelpdeskTicketStatus, HelpdeskTicketKind } from "@prisma/client";
import { computeSla, type SlaBucket } from "@/lib/helpdesk/sla";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DayCount {
  date: string; // YYYY-MM-DD
  count: number;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const days = clampInt(request.nextUrl.searchParams.get("days"), 1, 60, 14);
  const since = new Date(Date.now() - days * 86_400_000);

  const [openTickets, ticketsByStatus, ticketsByKind, perAgentResolved, inbound, outbound] =
    await Promise.all([
      db.helpdeskTicket.findMany({
        where: { isArchived: false, isSpam: false },
        select: {
          id: true,
          status: true,
          lastBuyerMessageAt: true,
          firstResponseAt: true,
        },
      }),
      db.helpdeskTicket.groupBy({
        by: ["status"],
        where: { isArchived: false, isSpam: false },
        _count: true,
      }),
      db.helpdeskTicket.groupBy({
        by: ["kind"],
        where: { isArchived: false, isSpam: false },
        _count: true,
      }),
      db.helpdeskTicket.groupBy({
        by: ["resolvedById"],
        where: {
          status: HelpdeskTicketStatus.RESOLVED,
          resolvedAt: { gte: since },
          resolvedById: { not: null },
        },
        _count: true,
      }),
      db.helpdeskMessage.findMany({
        where: { direction: "INBOUND", sentAt: { gte: since } },
        select: { sentAt: true },
      }),
      db.helpdeskMessage.findMany({
        where: { direction: "OUTBOUND", sentAt: { gte: since } },
        select: { sentAt: true },
      }),
    ]);

  // SLA snapshot
  const slaSnapshot: Record<SlaBucket, number> = {
    GREEN: 0,
    AMBER: 0,
    RED: 0,
    MET: 0,
    NA: 0,
  };
  for (const t of openTickets) {
    if (
      t.status === HelpdeskTicketStatus.RESOLVED ||
      t.status === HelpdeskTicketStatus.SPAM ||
      t.status === HelpdeskTicketStatus.ARCHIVED
    )
      continue;
    const r = computeSla({
      lastBuyerMessageAt: t.lastBuyerMessageAt,
      firstResponseAt: t.firstResponseAt,
    });
    slaSnapshot[r.bucket]++;
  }

  // Resolve per-agent counts to user names
  const userIds = perAgentResolved
    .map((r) => r.resolvedById)
    .filter((id): id is string => !!id);
  const users =
    userIds.length === 0
      ? []
      : await db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        });
  const userMap = new Map(users.map((u) => [u.id, u]));

  // Per-day inbound/outbound buckets
  const inboundPerDay = bucketByDay(inbound.map((m) => m.sentAt), days);
  const outboundPerDay = bucketByDay(outbound.map((m) => m.sentAt), days);

  // Heatmap: 7 (rows = day-of-week) x 24 (cols = hour) of inbound counts
  const heatmap: number[][] = Array.from({ length: 7 }, () =>
    new Array(24).fill(0),
  );
  for (const m of inbound) {
    const d = m.sentAt;
    heatmap[d.getDay()][d.getHours()]++;
  }

  return NextResponse.json({
    data: {
      windowDays: days,
      openByStatus: Object.fromEntries(
        ticketsByStatus.map((g) => [g.status, g._count]),
      ) as Record<HelpdeskTicketStatus, number>,
      openByKind: Object.fromEntries(
        ticketsByKind.map((g) => [g.kind, g._count]),
      ) as Record<HelpdeskTicketKind, number>,
      slaSnapshot,
      perAgent: perAgentResolved.map((r) => ({
        userId: r.resolvedById,
        name: r.resolvedById ? userMap.get(r.resolvedById)?.name ?? null : null,
        email: r.resolvedById ? userMap.get(r.resolvedById)?.email ?? null : null,
        resolved: r._count,
      })),
      inboundPerDay,
      outboundPerDay,
      heatmap,
    },
  });
}

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function bucketByDay(dates: Date[], days: number): DayCount[] {
  const map = new Map<string, number>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    map.set(toIsoDate(d), 0);
  }
  for (const d of dates) {
    const k = toIsoDate(d);
    if (map.has(k)) map.set(k, (map.get(k) ?? 0) + 1);
  }
  return Array.from(map.entries()).map(([date, count]) => ({ date, count }));
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
