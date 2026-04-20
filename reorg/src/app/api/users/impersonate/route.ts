/**
 * `DELETE /api/users/impersonate` — clear the impersonation cookie.
 *
 * Idempotent: if no cookie is set or it's already expired, we still return
 * 200 with `{ ok: true }`. The Banner uses this to "Return to my account".
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  IMPERSONATION_COOKIE_NAME,
  readImpersonationCookie,
} from "@/lib/impersonation";

export async function DELETE() {
  const parsed = await readImpersonationCookie();
  if (parsed) {
    await db.auditLog
      .create({
        data: {
          userId: parsed.adminId,
          action: "user_impersonate_stop",
          entityType: "user",
          entityId: parsed.targetId,
          details: {},
        },
      })
      .catch(() => {});
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(IMPERSONATION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
