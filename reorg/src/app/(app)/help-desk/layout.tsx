/**
 * Server-side gate for /help-desk. Anyone whose pagePermissions allowlist
 * doesn't include "help-desk" gets redirected to /dashboard?denied=help-desk.
 *
 * The sidebar already hides the link, but a user can still type or bookmark
 * the URL — this layout closes that hole.
 *
 * If we ever add more permission-gated pages, copy this pattern (a 5-line
 * server-component layout that calls `requirePageAccess`) into each one.
 */

import { requirePageAccess } from "@/lib/page-access";

export default async function HelpDeskLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePageAccess("help-desk");
  return children;
}
