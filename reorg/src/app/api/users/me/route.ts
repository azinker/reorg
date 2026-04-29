/**
 * GET   /api/users/me  → return the signed-in user's full profile (incl. avatar/title/bio).
 * PATCH /api/users/me  → update name, password, handle, title, bio, or avatar.
 *
 * Avatars come in as data URLs from `POST /api/users/me/avatar` and are stored
 * inline on the user row. Three users + tiny images = no need for object storage.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { updateManagedUserProfile } from "@/lib/services/user-admin";
import { getActor } from "@/lib/impersonation";
import { resolveAllowedPageKeys } from "@/lib/nav-pages";
import { resolveCatalogPermissions } from "@/lib/catalog-permissions";

const updateMeSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(8).max(200).optional(),
  handle: z.string().trim().min(1).max(40).nullable().optional(),
  title: z.string().trim().max(80).nullable().optional(),
  bio: z.string().trim().max(500).nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
});

export async function GET() {
  // Honor impersonation: while an admin is impersonating an operator, /me
  // returns the operator's profile so the entire UI (sidebar gating, helpdesk
  // admin links, etc.) reflects what the operator would actually see.
  const actor = await getActor();
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await db.user.findUnique({
    where: { id: actor.userId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      handle: true,
      title: true,
      bio: true,
      avatarUrl: true,
      pagePermissions: true,
      catalogPermissions: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const allowed = Array.from(
    resolveAllowedPageKeys({
      role: user.role,
      pagePermissions: user.pagePermissions as string[] | null,
    }),
  );

  return NextResponse.json({
    data: {
      ...user,
      pagePermissions: (user.pagePermissions as string[] | null) ?? null,
      catalogPermissions: resolveCatalogPermissions({
        role: user.role,
        catalogPermissions: user.catalogPermissions,
      }),
      allowedPageKeys: allowed,
      impersonation: actor.isImpersonating
        ? {
            realUserId: actor.realUserId,
            realName: actor.realName,
            realEmail: actor.realEmail,
          }
        : null,
    },
  });
}

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // While impersonating, refuse profile mutations: an admin must NOT be able
  // to change an operator's password, name, or avatar through "Login as".
  // To edit another user, use PATCH /api/users/:id (admin-only).
  const actor = await getActor();
  if (actor?.isImpersonating) {
    return NextResponse.json(
      {
        error:
          "Profile edits are blocked while impersonating. Return to your account first.",
      },
      { status: 403 },
    );
  }

  try {
    const body = await request.json();
    const parsed = updateMeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const hasUpdate = Object.values(parsed.data).some((v) => v !== undefined);
    if (!hasUpdate) {
      return NextResponse.json(
        { error: "Nothing to update." },
        { status: 400 },
      );
    }

    // Avatars must be either null/empty (clear) or data:image/* (≤ 256 KB).
    if (parsed.data.avatarUrl) {
      const av = parsed.data.avatarUrl;
      const isDataImage = /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(av);
      const isHttp = /^https?:\/\//i.test(av);
      if (!isDataImage && !isHttp) {
        return NextResponse.json(
          { error: "avatarUrl must be a data:image/* URL or an https:// URL." },
          { status: 400 },
        );
      }
      if (isDataImage && av.length > 350_000) {
        return NextResponse.json(
          { error: "Avatar too large. Max 256 KB." },
          { status: 413 },
        );
      }
    }

    // Handles must be unique. Catch the race / collision before Prisma throws.
    if (parsed.data.handle) {
      const cleaned = parsed.data.handle.toLowerCase().replace(/[^a-z0-9_-]/g, "");
      if (cleaned.length === 0) {
        return NextResponse.json(
          { error: "Handle must contain at least one letter or number." },
          { status: 400 },
        );
      }
      const taken = await db.user.findFirst({
        where: { handle: cleaned, NOT: { id: session.user.id } },
        select: { id: true },
      });
      if (taken) {
        return NextResponse.json(
          { error: `Handle "${cleaned}" is already taken.` },
          { status: 409 },
        );
      }
    }

    const updated = await updateManagedUserProfile({
      userId: session.user.id,
      name: parsed.data.name,
      password: parsed.data.password,
      handle: parsed.data.handle,
      title: parsed.data.title,
      bio: parsed.data.bio,
      avatarUrl: parsed.data.avatarUrl,
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    console.error("[users/me] Failed to update current user", error);
    return NextResponse.json(
      { error: "Failed to update user profile" },
      { status: 500 },
    );
  }
}
