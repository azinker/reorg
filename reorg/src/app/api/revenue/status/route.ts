import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getRequiredSessionUser } from "@/lib/server-auth";
import { getRevenueStatusData, RevenueServiceError } from "@/lib/services/revenue";

const platformSchema = z.enum(["TPP_EBAY", "TT_EBAY", "SHOPIFY", "BIGCOMMERCE"]);

function handleRevenueError(error: unknown, scope: string) {
  if (error instanceof RevenueServiceError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  console.error(scope, error);
  return NextResponse.json({ error: "Revenue status request failed" }, { status: 500 });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getRequiredSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const requestedPlatforms = (request.nextUrl.searchParams.get("platforms") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .flatMap((value) => {
        const parsed = platformSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      });

    const data = await getRevenueStatusData(user, requestedPlatforms);
    return NextResponse.json(
      { data },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0, must-revalidate",
        },
      },
    );
  } catch (error) {
    return handleRevenueError(error, "[revenue/status] GET failed");
  }
}
