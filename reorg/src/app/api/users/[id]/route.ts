/**
 * `PATCH /api/users/:id` — admin-only edit of another user.
 *
 * Lets an admin update name, role, password, and pagePermissions on a target
 * user. Includes one critical safety check: if the only remaining admin tries
 * to demote themselves to OPERATOR, we refuse — the system would otherwise
 * lock everyone out of admin features (write locks, integrations, etc).
 *
 * Impersonation handling: this route uses `auth()` directly (not `getActor()`)
 * because we always want the *real* admin to be the one making the change,
 * even if they happen to be impersonating someone at the moment. Impersonation
 * is read-only for everything except this very route — but we still refuse
 * the write while impersonating to keep the audit trail clean (otherwise
 * the impersonated user could be confused for the actor).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  normalizePagePermissions,
  updateManagedUserAsAdmin,
} from "@/lib/services/user-admin";
import { readImpersonationCookie } from "@/lib/impersonation";
import { normalizeCatalogPermissions } from "@/lib/catalog-permissions";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(["ADMIN", "OPERATOR"]).optional(),
  password: z.string().min(8).max(200).optional(),
  // pagePermissions is intentionally `unknown` — we let
  // normalizePagePermissions() sanitize it (filter unknown keys, dedupe,
  // accept null for "reset to operator default").
  pagePermissions: z.unknown().optional(),
  catalogPermissions: z.unknown().optional(),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only admins can edit other users." },
      { status: 403 },
    );
  }

  // Refuse mutations while impersonating — the audit log would attribute
  // the action ambiguously, and anyway the "Login as" flow is supposed to
  // be look-only.
  const impersonating = await readImpersonationCookie();
  if (impersonating) {
    return NextResponse.json(
      {
        error:
          "Stop impersonating before editing user accounts (use the banner at the top).",
      },
      { status: 403 },
    );
  }

  const { id: targetUserId } = await context.params;
  if (!targetUserId) {
    return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Make sure the target exists before doing the more expensive checks.
  const target = await db.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, role: true, email: true },
  });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Self-demotion guard: if the acting admin is editing themselves and trying
  // to drop from ADMIN → OPERATOR, make sure there's at least one other admin
  // left. Otherwise we'd brick admin features.
  if (
    session.user.id === targetUserId &&
    target.role === "ADMIN" &&
    parsed.data.role === "OPERATOR"
  ) {
    const otherAdminCount = await db.user.count({
      where: { role: "ADMIN", id: { not: targetUserId } },
    });
    if (otherAdminCount === 0) {
      return NextResponse.json(
        {
          error:
            "You are the last remaining admin — promote another user before demoting yourself.",
        },
        { status: 400 },
      );
    }
  }

  let pagePermissions: ReturnType<typeof normalizePagePermissions>;
  let catalogPermissions: ReturnType<typeof normalizeCatalogPermissions>;
  try {
    pagePermissions = normalizePagePermissions(parsed.data.pagePermissions);
    catalogPermissions = normalizeCatalogPermissions(parsed.data.catalogPermissions);
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Invalid permissions payload",
      },
      { status: 400 },
    );
  }

  try {
    const updated = await updateManagedUserAsAdmin({
      actingAdminId: session.user.id,
      targetUserId,
      name: parsed.data.name,
      role: parsed.data.role,
      pagePermissions,
      catalogPermissions,
      password: parsed.data.password,
    });

    return NextResponse.json({ data: updated });
  } catch (err) {
    if (err instanceof Error && err.message === "Nothing to update.") {
      return NextResponse.json(
        { error: "No changes were provided." },
        { status: 400 },
      );
    }
    console.error("[users/:id] PATCH failed", err);
    return NextResponse.json(
      { error: "Failed to update user" },
      { status: 500 },
    );
  }
}
