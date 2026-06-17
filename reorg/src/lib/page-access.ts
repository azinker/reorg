/**
 * Server-side helper that any /app page can call to enforce the same page
 * permissions the sidebar enforces visually.
 *
 * Usage in a page.tsx (server component):
 *
 *     import { requirePageAccess } from "@/lib/page-access";
 *     export default async function Page() {
 *       await requirePageAccess("help-desk");
 *       ...
 *     }
 *
 * What it does:
 *   1. Resolves the current actor (honoring impersonation).
 *   2. Computes their allowed page keys via `resolveAllowedPageKeys`.
 *   3. If the requested page key is not in the allowed set, redirects to
 *      `/dashboard?denied=<pageKey>` so the dashboard can show a friendly
 *      "you don't have access to that page" toast.
 *
 * Sidebar gating already hides links the user can't follow — this is the
 * defense-in-depth layer for direct URL navigation, bookmarks, and
 * agent-driven access.
 */

import { redirect } from "next/navigation";
import { getActor } from "@/lib/impersonation";
import { resolveAllowedPageKeys, type PageKey } from "@/lib/nav-pages";

export async function requirePageAccess(pageKey: PageKey): Promise<void> {
  const actor = await getActor();
  if (!actor) {
    redirect("/login");
  }

  const allowed = resolveAllowedPageKeys({
    role: actor.role,
    pagePermissions: actor.pagePermissions,
  });

  if (!allowed.has(pageKey)) {
    redirect(`/dashboard?denied=${encodeURIComponent(pageKey)}`);
  }
}

/**
 * Non-redirecting permission check for API route handlers. Returns whether the
 * current actor (honoring impersonation) can access the given page key, plus a
 * flag for whether anyone is even signed in (so callers can return 401 vs 403).
 *
 *     const { authenticated, allowed } = await checkPageAccess("help-desk-returns");
 *     if (!authenticated) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 *     if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
 */
export async function checkPageAccess(
  pageKey: PageKey,
): Promise<{ authenticated: boolean; allowed: boolean }> {
  const actor = await getActor();
  if (!actor) return { authenticated: false, allowed: false };
  const allowed = resolveAllowedPageKeys({
    role: actor.role,
    pagePermissions: actor.pagePermissions,
  });
  return { authenticated: true, allowed: allowed.has(pageKey) };
}
