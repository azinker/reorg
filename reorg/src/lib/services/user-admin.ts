import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { Prisma, type Role } from "@prisma/client";
import { isPageKey, type PageKey } from "@/lib/nav-pages";

export async function createManagedUser(input: {
  name: string;
  email: string;
  password: string;
  role: Role;
  createdById: string;
}) {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(input.password, 10);

  const created = await db.user.create({
    data: {
      name: input.name.trim(),
      email,
      passwordHash,
      role: input.role,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
  });

  await db.auditLog.create({
    data: {
      userId: input.createdById,
      action: "user_created",
      entityType: "user",
      entityId: created.id,
      details: {
        email: created.email,
        role: created.role,
      },
    },
  });

  return created;
}

export async function updateManagedUserProfile(input: {
  userId: string;
  name?: string;
  password?: string;
  handle?: string | null;
  title?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
}) {
  const data: {
    name?: string;
    passwordHash?: string;
    handle?: string | null;
    title?: string | null;
    bio?: string | null;
    avatarUrl?: string | null;
  } = {};

  if (typeof input.name === "string" && input.name.trim()) {
    data.name = input.name.trim();
  }

  if (typeof input.password === "string" && input.password.trim()) {
    data.passwordHash = await bcrypt.hash(input.password, 10);
  }

  if (input.handle !== undefined) {
    data.handle = input.handle?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || null;
  }
  if (input.title !== undefined) {
    data.title = input.title?.trim() || null;
  }
  if (input.bio !== undefined) {
    data.bio = input.bio?.trim() || null;
  }
  if (input.avatarUrl !== undefined) {
    data.avatarUrl = input.avatarUrl;
  }

  const updated = await db.user.update({
    where: { id: input.userId },
    data,
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      handle: true,
      title: true,
      bio: true,
      avatarUrl: true,
      updatedAt: true,
    },
  });

  await db.auditLog.create({
    data: {
      userId: input.userId,
      action: "user_updated_self",
      entityType: "user",
      entityId: input.userId,
      details: {
        updatedFields: Object.keys(data),
      },
    },
  });

  return updated;
}

/**
 * Normalize an arbitrary value into a clean `PageKey[]` (or `null` to mean
 * "use the legacy default — operators see everything except admin-only").
 *
 *   - `undefined`      → returned as `undefined` (caller should treat as "no
 *                        change")
 *   - `null`           → returned as `null` (explicit "reset to legacy")
 *   - `string[]`       → filtered to known PageKeys, deduped
 *   - anything else    → throws (caller should turn into a 400)
 */
export function normalizePagePermissions(
  value: unknown,
): PageKey[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error("pagePermissions must be an array of page keys or null");
  }
  const out = new Set<PageKey>();
  for (const raw of value) {
    if (isPageKey(raw)) out.add(raw);
  }
  return Array.from(out);
}

/**
 * Admin-only mutation. Updates a target user's role, name, and/or
 * page-permission allowlist. Audit-logged with the acting admin.
 */
export async function updateManagedUserAsAdmin(input: {
  actingAdminId: string;
  targetUserId: string;
  name?: string;
  role?: Role;
  pagePermissions?: PageKey[] | null;
  password?: string;
}) {
  const data: Prisma.UserUpdateInput = {};

  if (typeof input.name === "string" && input.name.trim()) {
    data.name = input.name.trim();
  }
  if (input.role) {
    data.role = input.role;
  }
  if (input.pagePermissions !== undefined) {
    // Prisma expects a JSON value here; null clears the allowlist (admin /
    // role default takes effect). An array of page keys persists as JSON.
    data.pagePermissions =
      input.pagePermissions === null
        ? Prisma.JsonNull
        : (input.pagePermissions as unknown as Prisma.InputJsonValue);
  }
  if (typeof input.password === "string" && input.password.trim()) {
    data.passwordHash = await bcrypt.hash(input.password, 10);
  }

  if (Object.keys(data).length === 0) {
    throw new Error("Nothing to update.");
  }

  const updated = await db.user.update({
    where: { id: input.targetUserId },
    data,
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      pagePermissions: true,
      updatedAt: true,
    },
  });

  await db.auditLog.create({
    data: {
      userId: input.actingAdminId,
      action: "user_updated_by_admin",
      entityType: "user",
      entityId: input.targetUserId,
      details: {
        updatedFields: Object.keys(data),
        ...(input.role ? { role: input.role } : {}),
        ...(input.pagePermissions !== undefined
          ? { pagePermissions: input.pagePermissions }
          : {}),
      },
    },
  });

  return updated;
}
