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

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.enum(VALID_COLORS).default("violet"),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const folders = await db.helpdeskAgentFolder.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      _count: { select: { tickets: true } },
      createdBy: { select: { id: true, name: true, email: true } },
    },
  });

  return NextResponse.json({
    data: folders.map((f) => ({
      id: f.id,
      name: f.name,
      color: f.color,
      createdBy: f.createdBy,
      ticketCount: f._count.tickets,
      createdAt: f.createdAt.toISOString(),
    })),
  });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await db.helpdeskAgentFolder.count();
  if (existing >= 50) {
    return NextResponse.json(
      { error: { message: "Maximum 50 agent folders allowed" } },
      { status: 400 },
    );
  }

  const folder = await db.helpdeskAgentFolder.create({
    data: {
      name: parsed.data.name,
      color: parsed.data.color,
      createdById: session.user.id,
    },
  });

  return NextResponse.json({ data: folder }, { status: 201 });
}
