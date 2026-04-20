/**
 * GET  /api/helpdesk/filters       → list all filters (system first, then by sortOrder)
 * POST /api/helpdesk/filters       → create a new user-defined filter
 *
 * Filters are inbox rules à la Gmail. The persistence shape and engine live in
 * `@/lib/helpdesk/filters`. Endpoints here are thin: validate, write, audit-log.
 *
 * Anyone signed in can read filters; only ADMIN can mutate.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { parseAction, parseConditions } from "@/lib/helpdesk/filters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(280).nullable().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  conditions: z.unknown(),
  action: z.unknown(),
});

export async function GET(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const filters = await db.helpdeskFilter.findMany({
    orderBy: [{ isSystem: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      createdBy: { select: { id: true, name: true, email: true, avatarUrl: true } },
    },
  });

  return NextResponse.json({
    data: filters.map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      enabled: f.enabled,
      isSystem: f.isSystem,
      sortOrder: f.sortOrder,
      conditions: f.conditions,
      action: f.action,
      lastRunAt: f.lastRunAt,
      lastRunHits: f.lastRunHits,
      totalHits: f.totalHits,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      createdBy: f.createdBy,
    })),
  });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  let conditions, action;
  try {
    conditions = parseConditions(parsed.data.conditions);
    action = parseAction(parsed.data.action);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  const created = await db.helpdeskFilter.create({
    data: {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      enabled: parsed.data.enabled ?? true,
      sortOrder: parsed.data.sortOrder ?? 100,
      conditions,
      action,
      createdById: session.user.id,
    },
  });

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HELPDESK_FILTER_CREATED",
      entityType: "HelpdeskFilter",
      entityId: created.id,
      details: { name: created.name },
    },
  });

  return NextResponse.json({ data: { id: created.id, name: created.name } });
}
