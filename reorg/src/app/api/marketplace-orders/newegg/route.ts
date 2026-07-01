import { NextResponse, type NextRequest } from "next/server";
import { checkPageAccess } from "@/lib/page-access";
import { mapNeweggOrder } from "@/lib/marketplace-orders/newegg-map";
import { fetchAllNeweggOrders, isNeweggConfigured } from "@/lib/services/newegg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function parseStatusParam(value: string | null): 0 | 1 | 2 | 3 | 4 | 5 | null {
  if (!value?.trim()) return 0;
  if (value === "all") return null;
  const parsed = Number(value);
  if ([0, 1, 2, 3, 4, 5].includes(parsed)) return parsed as 0 | 1 | 2 | 3 | 4 | 5;
  return 0;
}

export async function GET(request: NextRequest) {
  const access = await checkPageAccess("newegg-etsy-orders");
  if (!access.authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!access.allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!isNeweggConfigured()) {
    return NextResponse.json({
      configured: false,
      orders: [],
      message: "Newegg credentials are not configured on this environment.",
    });
  }

  try {
    const status = parseStatusParam(request.nextUrl.searchParams.get("status"));
    const orderDateFrom = request.nextUrl.searchParams.get("orderDateFrom")?.trim() || undefined;
    const orderDateTo = request.nextUrl.searchParams.get("orderDateTo")?.trim() || undefined;

    const rawOrders = await fetchAllNeweggOrders({
      status,
      orderDateFrom,
      orderDateTo,
      maxPages: 30,
    });

    const orders = rawOrders.map(mapNeweggOrder);
    return NextResponse.json({
      configured: true,
      statusFilter: status,
      count: orders.length,
      orders,
    });
  } catch (error) {
    console.error("[marketplace-orders/newegg] list failed", error);
    const message = error instanceof Error ? error.message : "Failed to load Newegg orders.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
