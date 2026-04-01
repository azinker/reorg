import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import type { Platform } from "@/lib/grid-types";
import { RevenueServiceError, executeQueuedRevenueSyncData } from "@/lib/services/revenue";

const platformSchema = z.enum(["TPP_EBAY", "TT_EBAY", "SHOPIFY", "BIGCOMMERCE"]);

const executeSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  platforms: z.array(platformSchema).optional().default([]),
  jobIds: z.array(z.string().min(1)).min(1),
});

function handleRevenueError(error: unknown, scope: string) {
  if (error instanceof RevenueServiceError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  console.error(scope, error);
  return NextResponse.json({ error: "Revenue sync execution failed" }, { status: 500 });
}

async function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = request.headers.get("authorization");
    const bearerSecret = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;

    if (bearerSecret === secret) {
      return true;
    }
  }

  const session = await auth();
  return Boolean(session?.user?.id);
}

export const runtime = "nodejs";
export const maxDuration = 800;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = executeSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    if (new Date(parsed.data.from) > new Date(parsed.data.to)) {
      return NextResponse.json({ error: "From date must be before to date." }, { status: 400 });
    }

    const data = await executeQueuedRevenueSyncData(
      {
        from: parsed.data.from,
        to: parsed.data.to,
        platforms: parsed.data.platforms as Platform[],
      },
      parsed.data.jobIds,
    );

    return NextResponse.json(
      { data },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0, must-revalidate",
        },
      },
    );
  } catch (error) {
    return handleRevenueError(error, "[revenue/sync/execute] POST failed");
  }
}
