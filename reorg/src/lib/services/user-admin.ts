import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import type { Role } from "@prisma/client";

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
}) {
  const data: {
    name?: string;
    passwordHash?: string;
  } = {};

  if (typeof input.name === "string" && input.name.trim()) {
    data.name = input.name.trim();
  }

  if (typeof input.password === "string" && input.password.trim()) {
    data.passwordHash = await bcrypt.hash(input.password, 10);
  }

  const updated = await db.user.update({
    where: { id: input.userId },
    data,
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
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
        updatedName: !!data.name,
        updatedPassword: !!data.passwordHash,
      },
    },
  });

  return updated;
}
