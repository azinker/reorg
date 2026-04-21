/**
 * GET  /api/helpdesk/column-prefs?layout=table
 * PUT  /api/helpdesk/column-prefs   { layout?: string, columns: string[] }
 *
 * Per-user column preferences for the inbox table. Stored in a tiny
 * dedicated table (HelpdeskColumnPref) keyed on (userId, layout) so we
 * can later add a separate "compact" or "split" layout without colliding
 * with the agent's main "table" preference.
 *
 * GET behaviour:
 *   - No row yet → return DEFAULT_COLUMNS so the inbox can render
 *     immediately on first visit. Client should treat the missing row
 *     as "user hasn't customized".
 *   - Row exists → return the persisted column key list verbatim.
 *
 * PUT behaviour:
 *   - Replaces the column list wholesale (simpler than a delta API and
 *     this is exactly how the Edit Columns dialog will save).
 *   - Validates against the known KNOWN_COLUMN_KEYS list so a stale
 *     client can't poison the row with garbage keys (the inbox would
 *     then try to render an undefined column).
 *   - Idempotent — the same payload twice is a no-op (updates updatedAt
 *     only, which is cheap).
 *
 * Notes:
 *   - "table" is the only layout for v1. We reserve the column on the
 *     primary key so future layouts don't require a migration.
 *   - We deliberately do NOT enforce "all defaults must be present" — an
 *     agent who hides Channel and eBay Username and is happy with their
 *     7-column inbox should be able to keep it that way.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  DEFAULT_COLUMNS,
  KNOWN_COLUMN_KEYS,
  type HelpdeskColumnKey,
} from "@/lib/helpdesk/column-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// NOTE: Next 15's route-module type checker forbids exporting anything
// from a route.ts beyond the recognised handler names + `runtime` /
// `dynamic`. The column-key constants live in @/lib/helpdesk/column-keys
// so both this route and any client component can import them safely.

const knownKeySchema = z.enum(KNOWN_COLUMN_KEYS);

const putSchema = z.object({
  layout: z.string().min(1).max(32).default("table"),
  columns: z
    .array(knownKeySchema)
    .min(1, "At least one column is required")
    .max(KNOWN_COLUMN_KEYS.length)
    .refine(
      (arr) => new Set(arr).size === arr.length,
      "Duplicate column keys are not allowed",
    ),
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const layout = url.searchParams.get("layout") ?? "table";

  const row = await db.helpdeskColumnPref.findUnique({
    where: { userId_layout: { userId: session.user.id, layout } },
    select: { columns: true, updatedAt: true },
  });

  if (!row) {
    return NextResponse.json({
      data: {
        layout,
        columns: DEFAULT_COLUMNS,
        isDefault: true,
      },
    });
  }

  // The JSON column may legitimately be `null`/non-array if a future
  // migration hiccups; fall back to defaults rather than crashing the
  // inbox.
  const cols = Array.isArray(row.columns)
    ? (row.columns as unknown[]).filter(
        (k): k is HelpdeskColumnKey =>
          typeof k === "string" && (KNOWN_COLUMN_KEYS as readonly string[]).includes(k),
      )
    : DEFAULT_COLUMNS;
  return NextResponse.json({
    data: {
      layout,
      columns: cols.length > 0 ? cols : DEFAULT_COLUMNS,
      isDefault: cols.length === 0,
      updatedAt: row.updatedAt,
    },
  });
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const json = await request.json().catch(() => null);
  const parsed = putSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  await db.helpdeskColumnPref.upsert({
    where: {
      userId_layout: {
        userId: session.user.id,
        layout: parsed.data.layout,
      },
    },
    create: {
      userId: session.user.id,
      layout: parsed.data.layout,
      columns: parsed.data.columns,
    },
    update: { columns: parsed.data.columns },
  });
  return NextResponse.json({
    data: {
      layout: parsed.data.layout,
      columns: parsed.data.columns,
    },
  });
}
