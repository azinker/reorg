/**
 * GET  /api/helpdesk/templates → list shared + my personal templates
 * POST /api/helpdesk/templates → create
 *
 * Templates support placeholders like {{order_number}}, {{buyer_name}},
 * {{tracking_number}}, {{item_title}}, {{first_name}}. Substitution happens
 * client-side (preview) and server-side (none — we keep it pure plain text).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  bodyText: z.string().trim().min(1).max(10_000),
  isShared: z.boolean().default(true),
  shortcut: z.string().trim().max(32).nullable().optional(),
  language: z.enum(["en", "es"]).nullable().optional(),
  description: z.string().trim().max(280).nullable().optional(),
});

export async function GET(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const items = await db.helpdeskTemplate.findMany({
    where: {
      isActive: true,
      OR: [{ isShared: true }, { ownerUserId: session.user.id }],
    },
    orderBy: [{ isShared: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({
    data: items.map((t) => ({
      id: t.id,
      name: t.name,
      bodyText: t.bodyText,
      isShared: t.isShared,
      ownerUserId: t.ownerUserId,
      shortcut: t.shortcut,
      language: t.language,
      description: t.description,
      sortOrder: t.sortOrder,
      isMine: t.ownerUserId === session.user.id,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
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
  const t = await db.helpdeskTemplate.create({
    data: {
      name: parsed.data.name,
      bodyText: parsed.data.bodyText,
      isShared: parsed.data.isShared,
      shortcut: parsed.data.shortcut ?? null,
      language: parsed.data.language ?? null,
      description: parsed.data.description ?? null,
      ownerUserId: parsed.data.isShared ? null : session.user.id,
      createdById: session.user.id,
      updatedById: session.user.id,
    },
  });
  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HELPDESK_TEMPLATE_CREATED",
      entityType: "HelpdeskTemplate",
      entityId: t.id,
      details: { name: t.name, isShared: t.isShared },
    },
  });
  return NextResponse.json({ data: { id: t.id } });
}
