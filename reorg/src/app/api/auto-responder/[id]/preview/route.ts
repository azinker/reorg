import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { previewResponder } from "@/lib/services/auto-responder";

export const dynamic = "force-dynamic";

const previewSchema = z.object({
  orderNumber: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await request.json();
  const parsed = previewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Order number is required" }, { status: 400 });
  }

  try {
    const result = await previewResponder(id, parsed.data.orderNumber);
    return NextResponse.json({ data: result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Preview failed" }, { status: 400 });
  }
}
