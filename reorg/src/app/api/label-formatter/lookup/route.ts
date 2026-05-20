import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { lookupLabelFormatterOrder } from "@/lib/label-formatter/ebay-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

const bodySchema = z.object({
  orderNumber: z.string().trim().min(1).max(80),
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

async function getActorUserId() {
  const session = await auth();
  if (session?.user?.id && ["ADMIN", "OPERATOR"].includes(session.user.role)) {
    return session.user.id;
  }
  if (isAuthBypassEnabled()) return (await getSystemUser()).id;
  return null;
}

export async function POST(request: NextRequest) {
  const actorUserId = await getActorUserId();
  if (!actorUserId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid lookup", details: parsed.error.flatten() }, { status: 400 });
    }

    const result = await lookupLabelFormatterOrder(parsed.data.orderNumber);
    return NextResponse.json({ data: result });
  } catch (error) {
    console.error("[label-formatter/lookup] failed", error);
    return NextResponse.json(
      { error: "Failed to look up this order. You can add it manually instead." },
      { status: 500 },
    );
  }
}
