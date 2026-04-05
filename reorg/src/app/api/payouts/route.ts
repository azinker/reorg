import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAllPayouts } from "@/lib/services/payouts";

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
    const data = await getAllPayouts();
    return NextResponse.json({ data });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load payouts.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
