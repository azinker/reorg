import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { getMissingR2EnvVars } from "@/lib/r2";
import { createBackup } from "@/lib/services/backup";

const postSchema = z
  .object({
    mode: z.enum(["standard", "full_ebay"]).default("standard"),
  })
  .optional();

export async function GET() {
  try {
    const backups = await db.backup.findMany({
      orderBy: { createdAt: "desc" },
    });

    const data = backups.map((b) => ({
      id: b.id,
      type: b.type,
      fileName: b.fileName,
      size: b.size,
      stores: (b.stores as string[]) ?? [],
      status: b.status,
      expiresAt: b.expiresAt.toISOString(),
      createdAt: b.createdAt.toISOString(),
      notes: b.notes,
    }));

    return NextResponse.json({ data: { backups: data } });
  } catch (error) {
    console.error("[backup] GET failed", error);
    return NextResponse.json(
      { error: "Failed to fetch backups" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const missingEnvVars = getMissingR2EnvVars();
    if (missingEnvVars.length > 0) {
      return NextResponse.json(
        {
          error: "Cloudflare R2 is not configured for backups yet.",
          details: { missingEnvVars },
        },
        { status: 400 }
      );
    }

    const body =
      request.headers.get("content-length") &&
      request.headers.get("content-length") !== "0"
        ? await request.json()
        : undefined;
    const parsed = postSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const mode = parsed.data?.mode ?? "standard";
    const session = await auth();
    const backup = await createBackup({
      type: "MANUAL",
      triggeredById: session?.user?.id ?? null,
      includeFullEbayDetails: mode === "full_ebay",
    });

    return NextResponse.json({
      data: {
        backupId: backup.id,
        status: backup.status.toLowerCase(),
        message:
          mode === "full_ebay"
            ? "Full eBay detail backup completed and uploaded to Cloudflare R2."
            : "Backup completed and uploaded to Cloudflare R2.",
      },
    });
  } catch (error) {
    console.error("[backup] POST failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to run backup",
      },
      { status: 500 }
    );
  }
}
