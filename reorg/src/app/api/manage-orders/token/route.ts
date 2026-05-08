import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { createHumanActionToken } from "@/lib/manage-orders/safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  orderId: z.string().min(1),
  store: z.enum(["TPP_EBAY", "TT_EBAY"]),
  actionType: z.enum(["add_tracking", "mark_shipped", "cancel_order", "message_buyer"]),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "OPERATOR"].includes(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid token request", details: parsed.error.flatten() }, { status: 400 });
  }
  return NextResponse.json({
    data: {
      humanActionToken: createHumanActionToken({
        userId: session.user.id,
        ...parsed.data,
      }),
      expiresInSeconds: 300,
    },
  });
}
