/**
 * PATCH/DELETE a single tag.
 * - DELETE removes the tag and all (ticket, tag) joins via cascade.
 * - PATCH updates name/color/description.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    color: z
      .string()
      .trim()
      .regex(/^#?[0-9a-fA-F]{3,8}$/, "Hex color")
      .nullable()
      .optional(),
    description: z.string().trim().max(280).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Empty patch");

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const updated = await db.helpdeskTag
    .update({ where: { id }, data: parsed.data })
    .catch(() => null);
  if (!updated)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HELPDESK_TAG_UPDATED",
      entityType: "HelpdeskTag",
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
  const tag = await db.helpdeskTag.findUnique({ where: { id } });
  if (!tag) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await db.helpdeskTag.delete({ where: { id } });
  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HELPDESK_TAG_DELETED",
      entityType: "HelpdeskTag",
      entityId: id,
      details: { name: tag.name },
    },
  });
  return NextResponse.json({ data: { deleted: true } });
}
