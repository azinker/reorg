import type { Metadata } from "next";
import ReturnDetailClient from "@/components/helpdesk/returns/ReturnDetailClient";

export const metadata: Metadata = {
  title: "Return · Help Desk",
};

/**
 * /help-desk/returns/[returnId] — single return detail + action flows.
 *
 * Server shell only. The client component re-fetches the latest detail from
 * eBay (read-only) on load so action availability is authoritative, and runs
 * every seller action through preview → typed confirm → commit (safety-gated).
 */
export default async function ReturnDetailPage({
  params,
}: {
  params: Promise<{ returnId: string }>;
}) {
  const { returnId } = await params;
  return <ReturnDetailClient returnId={returnId} />;
}
