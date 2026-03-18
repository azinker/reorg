import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createManagedUser } from "@/lib/services/user-admin";

const createUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  password: z.string().min(8).max(200),
  role: z.enum(["ADMIN", "OPERATOR"]),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = session.user.role === "ADMIN";
  const userFilter = isAdmin ? {} : { userId: session.user.id };

  const [users, auditLogs] = await Promise.all([
    db.user.findMany({
      where: isAdmin ? {} : { id: session.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    db.auditLog.findMany({
      where: userFilter,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 250,
    }),
  ]);

  return NextResponse.json({
    data: {
      currentUser: {
        id: session.user.id,
        name: session.user.name ?? session.user.email ?? "User",
        email: session.user.email ?? "",
        role: session.user.role,
      },
      canManageUsers: isAdmin,
      users,
      auditLogs: auditLogs.map((log) => ({
        id: log.id,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        details: log.details,
        createdAt: log.createdAt.toISOString(),
        user: log.user
          ? {
              id: log.user.id,
              name: log.user.name ?? log.user.email,
              email: log.user.email,
              role: log.user.role,
            }
          : null,
      })),
    },
  });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only admins can create users." },
      { status: 403 },
    );
  }

  try {
    const body = await request.json();
    const parsed = createUserSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const email = parsed.data.email.trim().toLowerCase();
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json(
        { error: "A user with that email already exists." },
        { status: 409 },
      );
    }

    const created = await createManagedUser({
      ...parsed.data,
      email,
      createdById: session.user.id,
    });

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    console.error("[users] Failed to create user", error);
    return NextResponse.json(
      { error: "Failed to create user" },
      { status: 500 },
    );
  }
}
