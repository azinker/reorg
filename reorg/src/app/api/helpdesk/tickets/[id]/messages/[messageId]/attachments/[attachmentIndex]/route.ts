/**
 * Authenticated download for outbound external-email attachments stored in R2.
 * Does not expose storage keys on the client — resolves by ticket + message + index.
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getR2ObjectBytes, isR2Configured } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface RouteParams {
  params: Promise<{ id: string; messageId: string; attachmentIndex: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: ticketId, messageId, attachmentIndex } = await params;
  const idx = Number.parseInt(attachmentIndex, 10);
  if (!Number.isFinite(idx) || idx < 0 || idx > 32) {
    return NextResponse.json({ error: "Invalid attachment index" }, { status: 400 });
  }

  if (!isR2Configured()) {
    return NextResponse.json({ error: "Attachment storage unavailable" }, { status: 503 });
  }

  const message = await db.helpdeskMessage.findFirst({
    where: {
      id: messageId,
      ticketId,
      deletedAt: null,
      direction: "OUTBOUND",
      source: "EXTERNAL_EMAIL",
    },
    select: { rawData: true },
  });

  if (!message) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const raw = asRecord(message.rawData);
  const arr = raw?.outboundAttachments;
  if (!Array.isArray(arr) || idx >= arr.length) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  const row = arr[idx];
  const obj = row && typeof row === "object" && !Array.isArray(row) ? row : null;
  const meta = obj as Record<string, unknown> | null;
  const storageKey =
    typeof meta?.storageKey === "string" ? meta.storageKey.trim() : "";
  const fileName =
    typeof meta?.fileName === "string" && meta.fileName.trim()
      ? meta.fileName.trim().slice(0, 180)
      : `attachment-${idx + 1}`;
  const mimeType =
    typeof meta?.mimeType === "string" && meta.mimeType.trim()
      ? meta.mimeType.trim().slice(0, 120)
      : "application/octet-stream";

  if (!storageKey.startsWith("helpdesk/outbound/")) {
    return NextResponse.json({ error: "Invalid attachment" }, { status: 400 });
  }

  try {
    const bytes = await getR2ObjectBytes(storageKey);
    const asciiName = /^[\x20-\x7e]+$/.test(fileName)
      ? fileName
      : `attachment-${idx + 1}`;
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${asciiName.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to read attachment" }, { status: 500 });
  }
}
