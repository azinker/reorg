import { NextResponse, type NextRequest } from "next/server";
import { Platform } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { startIntegrationSync } from "@/lib/services/sync-control";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 800;
export const dynamic = "force-dynamic";

const PLATFORM_VALUES = new Set<string>(Object.values(Platform));

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

function buildIntegrationLookupWhere(integrationId: string) {
  const normalized = integrationId.toUpperCase();
  if (!PLATFORM_VALUES.has(normalized)) {
    return { id: integrationId };
  }

  return {
    OR: [
      { id: integrationId },
      { platform: normalized as Platform },
    ],
  };
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
      where: buildIntegrationLookupWhere(integrationId),
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

    return NextResponse.json({ data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[sync] execute ${integrationId} failed`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync failed" },
      { status: 500 },
    );
  }
}
