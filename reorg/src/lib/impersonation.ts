/**
 * Admin "Login as" / impersonation helpers.
 *
 * How it works
 * ------------
 * When an admin clicks "Login as" on the /users page, we POST to
 * `/api/users/:id/impersonate`. That endpoint verifies the caller is an admin,
 * then sets an HTTP-only signed cookie:
 *
 *     reorg_impersonate=<adminId>:<targetId>:<expiresAtUnixMs>:<hmacHex>
 *
 * The signature is `HMAC_SHA256(secret, "<adminId>:<targetId>:<expiresAt>")`.
 * Secret comes from `IMPERSONATION_SECRET`, falling back to `AUTH_SECRET` so
 * we don't need a brand-new env var to ship this.
 *
 * `getActor()` reads the NextAuth session, then optionally swaps in the
 * impersonated identity if the cookie is present and valid. The real admin's
 * id is preserved in `actor.realUserId` so audit logs always know who's
 * actually driving.
 *
 * `clearImpersonationCookie()` is used by the "Return to my account" action
 * and is also called automatically by the API route handler if the cookie
 * fails verification.
 *
 * Security notes
 * --------------
 *   - The cookie is HTTP-only + Secure (in production) + SameSite=Lax.
 *   - Max age is 4 hours; absolute expiry is also encoded in the value.
 *   - Admins cannot impersonate other admins (one less footgun).
 *   - All impersonation start/stop events are written to AuditLog.
 *   - Outbound writes (helpdesk replies, push jobs, etc.) check
 *     `actor.isImpersonating` and refuse to run unless explicitly allowed —
 *     impersonation is a "look, don't touch" tool by default.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const IMPERSONATION_COOKIE_NAME = "reorg_impersonate";
export const IMPERSONATION_MAX_AGE_SECONDS = 4 * 60 * 60; // 4 hours

function getSecret(): string {
  const secret = process.env.IMPERSONATION_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "IMPERSONATION_SECRET or AUTH_SECRET must be set to use login-as.",
    );
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

function verify(payload: string, sigHex: string): boolean {
  const expected = sign(payload);
  if (expected.length !== sigHex.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(sigHex, "hex"),
    );
  } catch {
    return false;
  }
}

/** Build the cookie value `<adminId>:<targetId>:<expiresAt>:<sig>`. */
export function buildImpersonationCookieValue(
  adminId: string,
  targetId: string,
  ttlSeconds = IMPERSONATION_MAX_AGE_SECONDS,
): { value: string; expiresAt: number } {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const payload = `${adminId}:${targetId}:${expiresAt}`;
  const sig = sign(payload);
  return { value: `${payload}:${sig}`, expiresAt };
}

interface ParsedCookie {
  adminId: string;
  targetId: string;
  expiresAt: number;
}

function parseAndVerify(cookieValue: string | undefined): ParsedCookie | null {
  if (!cookieValue) return null;
  const parts = cookieValue.split(":");
  if (parts.length !== 4) return null;
  const [adminId, targetId, expiresAtStr, sig] = parts;
  if (!adminId || !targetId || !expiresAtStr || !sig) return null;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt)) return null;
  if (expiresAt < Date.now()) return null;
  if (!verify(`${adminId}:${targetId}:${expiresAt}`, sig)) return null;
  return { adminId, targetId, expiresAt };
}

export interface Actor {
  /** The id used for everything in the request — may be impersonated. */
  userId: string;
  email: string;
  name: string;
  role: "ADMIN" | "OPERATOR";
  pagePermissions: string[] | null;
  /** True iff an admin is currently impersonating someone else. */
  isImpersonating: boolean;
  /**
   * The admin actually driving the request (for audit logs). Always equal to
   * userId when not impersonating. NEVER trust the impersonated user id for
   * "who initiated this action" — use realUserId.
   */
  realUserId: string;
  realEmail: string;
  realName: string;
}

/**
 * Resolve the request's actor: signed-in user, optionally swapped to the
 * impersonated identity. Returns null when no valid session exists.
 *
 * Server components and route handlers should prefer this over `auth()`
 * directly so impersonation is always honored.
 */
export async function getActor(): Promise<Actor | null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  const realUserId = session.user.id;
  const realEmail = session.user.email ?? "";
  const realName = session.user.name ?? realEmail ?? "User";
  const realRole = (session.user.role as "ADMIN" | "OPERATOR") ?? "OPERATOR";

  const cookieStore = await cookies();
  const parsed = parseAndVerify(
    cookieStore.get(IMPERSONATION_COOKIE_NAME)?.value,
  );

  if (!parsed) {
    // No impersonation cookie — return the real user as the actor.
    const me = await db.user.findUnique({
      where: { id: realUserId },
      select: { pagePermissions: true },
    });
    return {
      userId: realUserId,
      email: realEmail,
      name: realName,
      role: realRole,
      pagePermissions: (me?.pagePermissions as string[] | null) ?? null,
      isImpersonating: false,
      realUserId,
      realEmail,
      realName,
    };
  }

  // The cookie says someone is being impersonated — but only honor it if the
  // real user is the admin who started the impersonation AND still has the
  // ADMIN role. This prevents an old cookie from a deposed admin still
  // working after a role change.
  if (parsed.adminId !== realUserId || realRole !== "ADMIN") {
    return {
      userId: realUserId,
      email: realEmail,
      name: realName,
      role: realRole,
      pagePermissions: null,
      isImpersonating: false,
      realUserId,
      realEmail,
      realName,
    };
  }

  const target = await db.user.findUnique({
    where: { id: parsed.targetId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      pagePermissions: true,
    },
  });

  if (!target) {
    return {
      userId: realUserId,
      email: realEmail,
      name: realName,
      role: realRole,
      pagePermissions: null,
      isImpersonating: false,
      realUserId,
      realEmail,
      realName,
    };
  }

  return {
    userId: target.id,
    email: target.email,
    name: target.name ?? target.email,
    role: target.role as "ADMIN" | "OPERATOR",
    pagePermissions: (target.pagePermissions as string[] | null) ?? null,
    isImpersonating: true,
    realUserId,
    realEmail,
    realName,
  };
}

/**
 * Read the impersonation cookie payload directly without consulting the DB.
 * Used by the "stop impersonating" route to know who to log the event for.
 */
export async function readImpersonationCookie(): Promise<ParsedCookie | null> {
  const cookieStore = await cookies();
  return parseAndVerify(cookieStore.get(IMPERSONATION_COOKIE_NAME)?.value);
}
