/**
 * Server-side gate for /help-desk/returns/**. Returns is a sub-feature of Help
 * Desk with its own grantable permission ("help-desk-returns"). The parent
 * /help-desk layout already requires the "help-desk" page key, so a user needs
 * BOTH Help Desk access AND the Return Cases permission to reach these routes.
 *
 * The Help Desk sidebar only shows the "Return Cases" link when the permission
 * is granted; this layout closes the direct-URL / bookmark hole.
 */

import { requirePageAccess } from "@/lib/page-access";

export default async function ReturnsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePageAccess("help-desk-returns");
  return children;
}
