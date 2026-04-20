/**
 * `POST /api/users/:id/impersonate` — admin starts a "Login as" session.
 *
 * Sets a signed HTTP-only cookie that the rest of the app reads via
 * `getActor()`. From this point on every server component / route handler
 * that uses `getActor()` will see the impersonated user as the actor, while
 * `actor.realUserId` still points at the admin (so audit logs stay accurate).
 *
 * Refusals:
 *   - Caller is not signed in            → 401
 *   - Caller is not an admin             → 403
 *   - Caller already impersonating       → 409 (must stop the existing one)
 *   - Target = caller                    → 400 (no-op)
 *   - Target is also an admin            → 403 (admin-on-admin is pointless
 *                                            and a footgun)
 *   - Target doesn't exist               → 404
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  IMPERSONATION_COOKIE_NAME,
  IMPERSONATION_MAX_AGE_SECONDS,
  buildImpersonationCookieValue,
  readImpersonationCookie,
} from "@/lib/impersonation";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only admins can impersonate other users." },
      { status: 403 },
    );
  }

  // Don't allow nesting impersonation sessions — too easy to get confused
  // about who you're "really" acting as.
  const existing = await readImpersonationCookie();
  if (existing) {
    return NextResponse.json(
      {
        error:
          "You are already impersonating another user. Return to your account first.",
      },
      { status: 409 },
    );
  }

  const { id: targetId } = await context.params;
  if (!targetId) {
    return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  }
  if (targetId === session.user.id) {
    return NextResponse.json(
      { error: "You cannot impersonate yourself." },
      { status: 400 },
    );
  }

  const target = await db.user.findUnique({
    where: { id: targetId },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (target.role === "ADMIN") {
    return NextResponse.json(
      {
        error:
          "Admin-to-admin impersonation is not allowed. Demote the user first if you really need this.",
      },
      { status: 403 },
    );
  }

  const { value, expiresAt } = buildImpersonationCookieValue(
    session.user.id,
    target.id,
  );

  await db.auditLog
    .create({
      data: {
        userId: session.user.id,
        action: "user_impersonate_start",
        entityType: "user",
        entityId: target.id,
        details: {
          targetEmail: target.email,
          targetRole: target.role,
          expiresAt: new Date(expiresAt).toISOString(),
        },
      },
    })
    .catch((err) => {
      console.error("[impersonate] failed to write audit log", err);
    });

  const response = NextResponse.json({
    data: {
      target: {
        id: target.id,
        name: target.name ?? target.email,
        email: target.email,
      },
      expiresAt: new Date(expiresAt).toISOString(),
    },
  });
  response.cookies.set(IMPERSONATION_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: IMPERSONATION_MAX_AGE_SECONDS,
  });
  return response;
}
