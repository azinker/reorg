import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getManageOrderDetail } from "@/lib/manage-orders/ebay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ store: string; orderId: string }> },
) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "OPERATOR"].includes(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { store, orderId } = await params;
  if (store !== "TPP_EBAY" && store !== "TT_EBAY") {
    return NextResponse.json({ error: "Invalid store" }, { status: 400 });
  }
  try {
    const order = await getManageOrderDetail(store, decodeURIComponent(orderId));
    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
    return NextResponse.json({ data: order });
  } catch (error) {
    console.error("[manage-orders/detail] failed", error);
    return NextResponse.json({ error: "Failed to load order details." }, { status: 500 });
  }
}
