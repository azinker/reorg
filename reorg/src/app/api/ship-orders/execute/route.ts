import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { executeShipments, type IdentifiedOrder } from "@/lib/services/ship-orders";
import type { Platform } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const VALID_PLATFORMS = new Set<string>([
  "TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY", "AMAZON",
]);

const bcProductSchema = z.object({
  order_product_id: z.number(),
  quantity: z.number(),
});

const amazonOrderItemSchema = z.object({
  orderItemId: z.string(),
  quantity: z.number(),
});

const orderSchema = z.object({
  orderNumber: z.string().min(1),
  trackingNumber: z.string().min(1),
  platform: z.string().refine((p) => VALID_PLATFORMS.has(p), {
    message: "Invalid platform",
  }),
  integrationId: z.string().min(1),
  platformOrderId: z.string().min(1),
  bcProducts: z.array(bcProductSchema).optional(),
  bcAddressId: z.number().optional(),
  amazonOrderItems: z.array(amazonOrderItemSchema).optional(),
  amazonMarketplaceId: z.string().optional(),
});

const bodySchema = z.object({
  orders: z.array(orderSchema).min(1).max(1000),
});

async function getSystemUser() {
  let user = await db.user.findFirst({ where: { role: "ADMIN" } });
  if (!user) {
    user = await db.user.create({
      data: { email: "system@reorg.internal", name: "System", role: "ADMIN" },
    });
  }
  return user;
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    const actorUserId =
      session?.user?.id ?? (isAuthBypassEnabled() ? (await getSystemUser()).id : null);

    if (!actorUserId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const json = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const orders: IdentifiedOrder[] = parsed.data.orders.map((o) => ({
      ...o,
      platform: o.platform as Platform,
      status: "found" as const,
    }));

    const { results, autoResponderStatus } = await executeShipments(orders, actorUserId);

    // Jobs are in the DB. The scheduler tick (every minute) will process them.
    return NextResponse.json({ data: { results, autoResponderStatus } });
  } catch (error) {
    console.error("[ship-orders/execute] Failed", error);
    return NextResponse.json({ error: "Failed to execute shipments" }, { status: 500 });
  }
}
