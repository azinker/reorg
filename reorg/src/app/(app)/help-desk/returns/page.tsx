import type { Metadata } from "next";
import ReturnsListClient from "@/components/helpdesk/returns/ReturnsListClient";

export const metadata: Metadata = {
  title: "Return Cases · Help Desk",
};

/**
 * /help-desk/returns — combined TPP + TT eBay return requests.
 *
 * Server shell only. Admin gating + data loading happen client-side against the
 * admin-gated /api/helpdesk/returns endpoints (the API is the source of truth;
 * the client check is a UX nicety, identical to /help-desk/global-settings).
 */
export default function ReturnsPage() {
  return <ReturnsListClient />;
}
