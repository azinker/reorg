import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { isAutoResponderPaused, setAutoResponderPaused } from "@/lib/services/auto-responder";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const paused = await isAutoResponderPaused();
  return NextResponse.json({ data: { paused } });
}

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json() as { paused?: boolean };
  if (typeof body.paused !== "boolean") {
    return NextResponse.json({ error: "paused (boolean) is required" }, { status: 400 });
  }

  await setAutoResponderPaused(body.paused, session.user.id);
  return NextResponse.json({ data: { paused: body.paused } });
}
