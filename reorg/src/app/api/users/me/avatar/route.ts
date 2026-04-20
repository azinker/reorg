/**
 * POST   /api/users/me/avatar  (multipart: file=<image>)  → uploads, resizes
 *                                                           to a 256x256 webp,
 *                                                           and persists as a
 *                                                           data URL on the user.
 * DELETE /api/users/me/avatar                              → clears the avatar.
 *
 * We deliberately store the image inline (data URL) rather than uploading to
 * R2. With ≤ a dozen agents and a 256x256 webp avatar at ~6–15 KB each, the
 * complexity of object storage + signed URLs isn't worth it. If the user roster
 * grows past ~50, swap this for an R2 upload using the existing `r2.ts` helper.
 */

import { NextResponse, type NextRequest } from "next/server";
import sharp from "sharp";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_INPUT_BYTES = 8 * 1024 * 1024; // 8 MB raw upload cap before resizing
const ACCEPTED_MIME = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let file: File;
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (!(f instanceof File)) {
      return NextResponse.json(
        { error: "Missing 'file' field in multipart form-data." },
        { status: 400 },
      );
    }
    file = f;
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to parse multipart body. Send as multipart/form-data with a 'file' field." },
      { status: 400 },
    );
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "Empty file." }, { status: 400 });
  }
  if (file.size > MAX_INPUT_BYTES) {
    return NextResponse.json(
      { error: `File too large. Max ${MAX_INPUT_BYTES / (1024 * 1024)} MB.` },
      { status: 413 },
    );
  }
  if (file.type && !ACCEPTED_MIME.includes(file.type.toLowerCase())) {
    return NextResponse.json(
      { error: `Unsupported file type "${file.type}". Use PNG, JPEG, WEBP, or GIF.` },
      { status: 415 },
    );
  }

  const inputBytes = Buffer.from(await file.arrayBuffer());

  let webpBytes: Buffer;
  try {
    webpBytes = await sharp(inputBytes, { animated: false })
      .rotate() // honour EXIF orientation
      .resize(256, 256, { fit: "cover", position: "centre" })
      .webp({ quality: 80, effort: 4 })
      .toBuffer();
  } catch (err) {
    console.error("[users/me/avatar] sharp failed", err);
    return NextResponse.json(
      { error: "Could not process this image. Try a different file." },
      { status: 422 },
    );
  }

  const dataUrl = `data:image/webp;base64,${webpBytes.toString("base64")}`;

  // Sanity guard: data URL ≤ ~350 KB (resized webp should be ~10-30 KB).
  if (dataUrl.length > 400_000) {
    return NextResponse.json(
      { error: "Resized avatar still too large." },
      { status: 413 },
    );
  }

  await db.user.update({
    where: { id: session.user.id },
    data: { avatarUrl: dataUrl },
  });

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "user_avatar_updated",
      entityType: "user",
      entityId: session.user.id,
      details: { sizeBytes: webpBytes.length },
    },
  });

  return NextResponse.json({
    data: { avatarUrl: dataUrl, sizeBytes: webpBytes.length },
  });
}

export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await db.user.update({
    where: { id: session.user.id },
    data: { avatarUrl: null },
  });

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "user_avatar_cleared",
      entityType: "user",
      entityId: session.user.id,
      details: {},
    },
  });

  return NextResponse.json({ data: { avatarUrl: null } });
}
