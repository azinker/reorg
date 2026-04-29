import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  createManagedUser,
  normalizePagePermissions,
} from "@/lib/services/user-admin";
import { getActor } from "@/lib/impersonation";
import { NAV_PAGES } from "@/lib/nav-pages";

const createUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  password: z.string().min(8).max(200),
  role: z.enum(["ADMIN", "OPERATOR"]),
  pagePermissions: z.unknown().optional(),
});

export async function GET() {
  const actor = await getActor();
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Admin = effective role of the actor. While impersonating an operator,
  // an admin sees the operator's view of /users (just their own row).
  const isAdmin = actor.role === "ADMIN";
  const userFilter = isAdmin ? {} : { userId: actor.userId };

  const [users, auditLogs] = await Promise.all([
    db.user.findMany({
      where: isAdmin ? {} : { id: actor.userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        pagePermissions: true,
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
        id: actor.userId,
        name: actor.name,
        email: actor.email,
        role: actor.role,
      },
      impersonation: actor.isImpersonating
        ? {
            realUserId: actor.realUserId,
            realName: actor.realName,
            realEmail: actor.realEmail,
          }
        : null,
      canManageUsers: isAdmin,
      pageRegistry: NAV_PAGES.map((p) => ({
        key: p.key,
        href: p.href,
        label: p.label,
        adminOnly: p.adminOnly ?? false,
        alwaysAllow: p.alwaysAllow ?? false,
        description: p.description,
      })),
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        pagePermissions: (u.pagePermissions as string[] | null) ?? null,
        createdAt: u.createdAt.toISOString(),
        updatedAt: u.updatedAt.toISOString(),
      })),
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

    let pagePermissions: ReturnType<typeof normalizePagePermissions>;
    try {
      pagePermissions =
        parsed.data.role === "OPERATOR"
          ? normalizePagePermissions(parsed.data.pagePermissions)
          : undefined;
    } catch (err) {
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "Invalid pagePermissions payload",
        },
        { status: 400 },
      );
    }

    const created = await createManagedUser({
      ...parsed.data,
      email,
      pagePermissions,
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
