/**
 * GET  /api/helpdesk/tags    → list all tags (flat in v1)
 * POST /api/helpdesk/tags    → create a new tag (audit-logged)
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z
    .string()
    .trim()
    .regex(/^#?[0-9a-fA-F]{3,8}$/, "Hex color")
    .nullable()
    .optional(),
  description: z.string().trim().max(280).nullable().optional(),
});

export async function GET(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const tags = await db.helpdeskTag.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { tickets: true } } },
  });
  return NextResponse.json({
    data: tags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      description: t.description,
      ticketCount: t._count.tickets,
      createdAt: t.createdAt,
    })),
  });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const tag = await db.helpdeskTag.upsert({
    where: { name: parsed.data.name },
    create: {
      name: parsed.data.name,
      color: parsed.data.color ?? null,
      description: parsed.data.description ?? null,
      createdById: session.user.id,
    },
    update: {},
  });
  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HELPDESK_TAG_CREATED",
      entityType: "HelpdeskTag",
      entityId: tag.id,
      details: { name: tag.name },
    },
  });
  return NextResponse.json({
    data: { id: tag.id, name: tag.name, color: tag.color },
  });
}
