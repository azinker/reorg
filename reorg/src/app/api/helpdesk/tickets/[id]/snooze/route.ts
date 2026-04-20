/**
 * POST /api/helpdesk/tickets/:id/snooze
 *   Body: { until: ISO string | null, presetHours?: number }
 *   - Sends ticket to the Snoozed folder until `until`. Pass null to unsnooze.
 *   - presetHours is a convenience: e.g. 4 = +4h from now. If both provided,
 *     `until` wins.
 *   - Auto-unsnooze happens lazily — folder filters use `snoozedUntil > now`.
 *     The hourly cron also clears stale snoozes for sanity.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    until: z.string().datetime().nullable().optional(),
    presetHours: z.number().int().min(1).max(720).optional(),
  })
  .refine(
    (v) => v.until !== undefined || v.presetHours !== undefined,
    "Provide until or presetHours",
  );

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }
  let until: Date | null = null;
  if (parsed.data.until === null) {
    until = null;
  } else if (parsed.data.until) {
    until = new Date(parsed.data.until);
  } else if (parsed.data.presetHours) {
    until = new Date(Date.now() + parsed.data.presetHours * 3_600_000);
  }
  const updated = await db.helpdeskTicket
    .update({
      where: { id },
      data: until
        ? { snoozedUntil: until, snoozedBy: { connect: { id: session.user.id } } }
        : { snoozedUntil: null, snoozedBy: { disconnect: true } },
    })
    .catch(() => null);
  if (!updated)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: until ? "HELPDESK_TICKET_SNOOZED" : "HELPDESK_TICKET_UNSNOOZED",
      entityType: "HelpdeskTicket",
      entityId: id,
      details: { until: until?.toISOString() ?? null },
    },
  });
  return NextResponse.json({
    data: { id, snoozedUntil: updated.snoozedUntil },
  });
}
