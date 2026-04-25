/**
 * PATCH/DELETE a single template. Shared templates are team-owned; any
 * signed-in agent can maintain them from the Help Desk Templates page.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    bodyText: z.string().trim().min(1).max(10_000).optional(),
    isShared: z.boolean().optional(),
    shortcut: z.string().trim().max(32).nullable().optional(),
    language: z.enum(["en", "es"]).nullable().optional(),
    description: z.string().trim().max(280).nullable().optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Empty patch");

interface RouteParams {
  params: Promise<{ id: string }>;
}

async function loadAndCheck(id: string, session: { user: { id: string; role: string } }) {
  const tpl = await db.helpdeskTemplate.findUnique({ where: { id } });
  if (!tpl) return { tpl: null, allowed: false };
  const isAdmin = session.user.role === "ADMIN";
  if (tpl.isShared) return { tpl, allowed: true };
  if (!tpl.isShared && tpl.ownerUserId !== session.user.id && !isAdmin)
    return { tpl, allowed: false };
  return { tpl, allowed: true };
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const { tpl, allowed } = await loadAndCheck(id, {
    user: { id: session.user.id, role: session.user.role ?? "OPERATOR" },
  });
  if (!tpl) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const updated = await db.helpdeskTemplate.update({
    where: { id },
    data: {
      ...parsed.data,
      ownerUserId:
        parsed.data.isShared === true
          ? null
          : parsed.data.isShared === false
            ? (tpl.ownerUserId ?? session.user.id)
            : undefined,
      updatedById: session.user.id,
    },
  });
  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HELPDESK_TEMPLATE_UPDATED",
      entityType: "HelpdeskTemplate",
      entityId: id,
      details: { fields: Object.keys(parsed.data) },
    },
  });
  return NextResponse.json({ data: { id: updated.id } });
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const { tpl, allowed } = await loadAndCheck(id, {
    user: { id: session.user.id, role: session.user.role ?? "OPERATOR" },
  });
  if (!tpl) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Soft-delete via isActive=false to keep audit trail intact.
  await db.helpdeskTemplate.update({
    where: { id },
    data: { isActive: false, updatedById: session.user.id },
  });
  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HELPDESK_TEMPLATE_DELETED",
      entityType: "HelpdeskTemplate",
      entityId: id,
      details: { name: tpl.name },
    },
  });
  return NextResponse.json({ data: { deleted: true } });
}
