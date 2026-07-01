import { NextResponse } from "next/server";
import { checkPageAccess } from "@/lib/page-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const access = await checkPageAccess("newegg-etsy-orders");
  if (!access.authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!access.allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const configured = Boolean(
    process.env.ETSY_API_KEY?.trim()
    && process.env.ETSY_SHARED_SECRET?.trim(),
  );

  return NextResponse.json({
    configured,
    orders: [],
    message: configured
      ? "Etsy order sync is not enabled in v1 yet."
      : "Etsy API credentials are not configured. Add ETSY_API_KEY and ETSY_SHARED_SECRET when approved.",
  });
}
