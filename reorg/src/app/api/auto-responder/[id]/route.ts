import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { updateResponder, archiveResponder } from "@/lib/services/auto-responder";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  messageName: z.string().min(1).max(100).optional(),
  channel: z.enum(["TPP_EBAY", "TT_EBAY"]).optional(),
  subjectTemplate: z.string().min(1).optional(),
  bodyTemplate: z.string().min(1).optional(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const responder = await db.autoResponder.findUnique({
    where: { id },
    include: {
      integration: { select: { label: true, enabled: true, platform: true } },
      versions: { orderBy: { versionNumber: "desc" }, take: 10 },
    },
  });
  if (!responder) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ data: responder });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await request.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  try {
    const responder = await updateResponder(id, parsed.data, session.user.id);
    return NextResponse.json({ data: responder });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    await archiveResponder(id, session.user.id);
    return NextResponse.json({ data: { archived: true } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}
