import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_COLORS = [
  "violet",
  "blue",
  "emerald",
  "amber",
  "rose",
  "sky",
  "orange",
  "teal",
  "pink",
  "indigo",
] as const;

const updateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  color: z.enum(VALID_COLORS).optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const folder = await db.helpdeskAgentFolder.findUnique({ where: { id } });
  if (!folder) {
    return NextResponse.json(
      { error: { message: "Folder not found" } },
      { status: 404 },
    );
  }

  const updated = await db.helpdeskAgentFolder.update({
    where: { id },
    data: parsed.data,
  });

  return NextResponse.json({ data: updated });
}

export async function DELETE(_request: NextRequest, ctx: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const folder = await db.helpdeskAgentFolder.findUnique({ where: { id } });
  if (!folder) {
    return NextResponse.json(
      { error: { message: "Folder not found" } },
      { status: 404 },
    );
  }

  // Unlink all tickets from this folder before deleting
  await db.helpdeskTicket.updateMany({
    where: { agentFolderId: id },
    data: { agentFolderId: null },
  });

  await db.helpdeskAgentFolder.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
