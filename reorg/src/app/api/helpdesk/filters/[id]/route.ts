/**
 * PATCH  /api/helpdesk/filters/:id  → update a filter (name, conditions, action, enabled, sortOrder)
 * DELETE /api/helpdesk/filters/:id  → delete a user-created filter (system filters cannot be deleted)
 *
 * Per the project's no-deletion safety rule, this only deletes the *rule*,
 * never any tickets or messages it has acted on. System filters refuse
 * deletion outright but may be disabled via PATCH { enabled: false }.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { parseAction, parseConditions } from "@/lib/helpdesk/filters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(280).nullable().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  conditions: z.unknown().optional(),
  action: z.unknown().optional(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const existing = await db.helpdeskFilter.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Filter not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.description !== undefined) data.description = parsed.data.description;
  if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
  if (parsed.data.sortOrder !== undefined) data.sortOrder = parsed.data.sortOrder;
  try {
    if (parsed.data.conditions !== undefined) {
      data.conditions = parseConditions(parsed.data.conditions);
    }
    if (parsed.data.action !== undefined) {
      data.action = parseAction(parsed.data.action);
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  const updated = await db.helpdeskFilter.update({
    where: { id },
    data,
  });

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HELPDESK_FILTER_UPDATED",
      entityType: "HelpdeskFilter",
      entityId: updated.id,
      details: { name: updated.name, fields: Object.keys(data) },
    },
  });

  return NextResponse.json({ data: { id: updated.id } });
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const existing = await db.helpdeskFilter.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Filter not found" }, { status: 404 });
  }
  if (existing.isSystem) {
    return NextResponse.json(
      { error: "System filters cannot be deleted. Disable instead." },
      { status: 400 },
    );
  }

  await db.helpdeskFilter.delete({ where: { id } });

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HELPDESK_FILTER_DELETED",
      entityType: "HelpdeskFilter",
      entityId: id,
      details: { name: existing.name },
    },
  });

  return NextResponse.json({ data: { ok: true } });
}
