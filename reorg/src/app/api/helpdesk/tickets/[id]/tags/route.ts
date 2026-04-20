/**
 * POST   /api/helpdesk/tickets/:id/tags  body: { tagIds: string[] }
 *   Replaces the ticket's tag set with the provided list (idempotent). Pass an
 *   empty array to clear all tags. Returns the new tag list.
 *
 * The composer/context panel uses this endpoint via a multi-select dropdown.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  tagIds: z.array(z.string().min(1)).max(40),
});

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
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const ticket = await db.helpdeskTicket.findUnique({ where: { id } });
  if (!ticket)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Validate tag ids exist
  const requested = Array.from(new Set(parsed.data.tagIds));
  const validTags =
    requested.length === 0
      ? []
      : await db.helpdeskTag.findMany({
          where: { id: { in: requested } },
          select: { id: true, name: true },
        });
  const validIds = new Set(validTags.map((t) => t.id));

  await db.$transaction(async (tx) => {
    await tx.helpdeskTicketTag.deleteMany({ where: { ticketId: id } });
    if (validIds.size > 0) {
      await tx.helpdeskTicketTag.createMany({
        data: Array.from(validIds).map((tagId) => ({
          ticketId: id,
          tagId,
          addedById: session.user.id,
        })),
      });
    }
  });

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HELPDESK_TICKET_TAGS_SET",
      entityType: "HelpdeskTicket",
      entityId: id,
      details: { tagNames: validTags.map((t) => t.name) },
    },
  });

  const fresh = await db.helpdeskTicketTag.findMany({
    where: { ticketId: id },
    include: { tag: true },
  });
  return NextResponse.json({
    data: {
      tags: fresh.map((tt) => ({
        id: tt.tagId,
        name: tt.tag.name,
        color: tt.tag.color,
      })),
    },
  });
}
