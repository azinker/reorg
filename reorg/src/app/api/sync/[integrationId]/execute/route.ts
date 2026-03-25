import { NextResponse, type NextRequest } from "next/server";
import { Platform } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { startIntegrationSync } from "@/lib/services/sync-control";
import { dispatchCatalogSyncContinuation } from "@/lib/services/sync-continuation";
import { auth } from "@/lib/auth";

const CHUNKED_PLATFORMS = new Set(["SHOPIFY", "BIGCOMMERCE"]);

export const runtime = "nodejs";
export const maxDuration = 800;
export const dynamic = "force-dynamic";

const postSchema = z
  .object({
    mode: z.enum(["full", "incremental"]).optional(),
    resumeContinuation: z.boolean().optional(),
  })
  .optional();

async function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const headerSecret = request.headers.get("x-cron-secret");
    const authHeader = request.headers.get("authorization");
    const bearerSecret = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;

    if (headerSecret === secret || bearerSecret === secret) {
      return true;
    }
  }

  const session = await auth();
  return Boolean(session?.user?.id);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) {
  const { integrationId } = await context.params;

  try {
    if (!(await isAuthorized(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const integration = await db.integration.findFirst({
      where: {
        OR: [
          { id: integrationId },
          { platform: integrationId.toUpperCase() as Platform },
        ],
      },
    });

    if (!integration) {
      return NextResponse.json(
        { error: `Integration "${integrationId}" not found` },
        { status: 404 },
      );
    }

    if (!integration.enabled) {
      return NextResponse.json(
        { error: `Integration "${integration.label}" is not connected` },
        { status: 400 },
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
        { status: 400 },
      );
    }

    const resumeContinuation = parsed.data?.resumeContinuation === true;

    const result = await startIntegrationSync(
      integration,
      {
        requestedMode: parsed.data?.mode,
        resumeContinuation,
        triggerSource: resumeContinuation ? "scheduler" : "manual",
        triggeredBy: resumeContinuation ? "catalog-continuation" : undefined,
      },
      "inline",
    );

    // Belt-and-suspenders: if a chunked sync scheduled a continuation, fire a
    // backup dispatch after a short delay. If the primary (in-process) dispatch
    // already landed, the backup will see ALREADY_RUNNING and exit harmlessly.
    if (
      CHUNKED_PLATFORMS.has(integration.platform) &&
      result.catalogContinuationScheduled
    ) {
      await new Promise((r) => setTimeout(r, 5_000));
      await dispatchCatalogSyncContinuation(integration.id).catch((err) =>
        console.warn("[sync-execute] Backup continuation dispatch failed", err),
      );
    }

    return NextResponse.json({ data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[sync] execute ${integrationId} failed`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync failed" },
      { status: 500 },
    );
  }
}
