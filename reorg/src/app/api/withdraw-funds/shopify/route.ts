import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getWithdrawFundsShopifySnapshot } from "@/lib/services/withdraw-funds-shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const data = await getWithdrawFundsShopifySnapshot();
    return NextResponse.json({ data });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load Shopify data.";
    if (message.includes("No enabled Shopify") || message.includes("missing")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
