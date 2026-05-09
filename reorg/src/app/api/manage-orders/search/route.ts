import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { searchManageOrders } from "@/lib/manage-orders/ebay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({
  store: z.enum(["ALL", "TPP_EBAY", "TT_EBAY"]).default("ALL"),
  status: z.enum(["all_orders", "awaiting_shipment", "shipped", "ship_within_24h", "awaiting_expedited"]).default("all_orders"),
  period: z.enum(["last_90_days", "last_week", "last_month"]).default("last_90_days"),
  searchBy: z.enum(["order_number", "buyer_username", "buyer_name", "item_id", "item_title", "sku", "tracking_number"]).default("order_number"),
  searchTerm: z.string().default(""),
  page: z.number().int().min(1).default(1),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "OPERATOR"].includes(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid search", details: parsed.error.flatten() }, { status: 400 });
    }
    const data = await searchManageOrders(parsed.data);
    return NextResponse.json({ data });
  } catch (error) {
    console.error("[manage-orders/search] failed", error);
    return NextResponse.json(
      { error: "Failed to search eBay orders. Try again or narrow the filters." },
      { status: 500 },
    );
  }
}
