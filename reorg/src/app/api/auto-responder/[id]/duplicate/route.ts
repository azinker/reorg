import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { duplicateResponder } from "@/lib/services/auto-responder";

export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    const responder = await duplicateResponder(id, session.user.id);
    return NextResponse.json({ data: responder }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}
