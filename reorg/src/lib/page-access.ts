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
