import { endOfDay, startOfDay, subDays } from "date-fns";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getRequiredSessionUser } from "@/lib/server-auth";
import {
  REVENUE_GRANULARITY_VALUES,
  REVENUE_RANGE_PRESETS,
  REVENUE_SIMPLE_WINDOW_VALUES,
  type RevenueQueryFilters,
} from "@/lib/revenue";
import {
  getRevenuePageData,
  RevenueServiceError,
} from "@/lib/services/revenue";

const platformSchema = z.enum(["TPP_EBAY", "TT_EBAY", "SHOPIFY", "BIGCOMMERCE", "AMAZON"]);

const revenueQuerySchema = z.object({
  preset: z.enum(REVENUE_RANGE_PRESETS).default("30d"),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  granularity: z.enum(REVENUE_GRANULARITY_VALUES).optional(),
  buyerWindow: z.enum(REVENUE_SIMPLE_WINDOW_VALUES).default("30d"),
  itemWindow: z.enum(REVENUE_SIMPLE_WINDOW_VALUES).default("30d"),
  platforms: z.string().optional(),
  includeTopTables: z.enum(["0", "1"]).optional(),
});

function handleRevenueError(error: unknown, scope: string) {
  if (error instanceof RevenueServiceError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  console.error(scope, error);
  return NextResponse.json({ error: "Revenue request failed" }, { status: 500 });
}

function resolveRevenueFilters(raw: z.infer<typeof revenueQuerySchema>): RevenueQueryFilters {
  const now = new Date();
  const to =
    raw.preset === "custom" && raw.to ? new Date(raw.to) : endOfDay(now);
  const from =
    raw.preset === "custom" && raw.from
      ? new Date(raw.from)
      : startOfDay(
          subDays(
            now,
            raw.preset === "90d" ? 89 : raw.preset === "365d" ? 364 : 29,
          ),
        );

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new RevenueServiceError("Invalid revenue date range.", 400);
  }

  const platforms = (raw.platforms ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      const parsed = platformSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });

  const rangeDays = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));

  return {
    preset: raw.preset,
    from: from.toISOString(),
    to: to.toISOString(),
    granularity: raw.granularity ?? (rangeDays > 120 ? "week" : "day"),
    platforms,
    buyerWindow: raw.buyerWindow,
    itemWindow: raw.itemWindow,
  };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getRequiredSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = revenueQuerySchema.safeParse({
      preset: request.nextUrl.searchParams.get("preset") ?? undefined,
      from: request.nextUrl.searchParams.get("from") ?? undefined,
      to: request.nextUrl.searchParams.get("to") ?? undefined,
      granularity: request.nextUrl.searchParams.get("granularity") ?? undefined,
      buyerWindow: request.nextUrl.searchParams.get("buyerWindow") ?? undefined,
      itemWindow: request.nextUrl.searchParams.get("itemWindow") ?? undefined,
      platforms: request.nextUrl.searchParams.get("platforms") ?? undefined,
      includeTopTables: request.nextUrl.searchParams.get("includeTopTables") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = await getRevenuePageData(user, resolveRevenueFilters(parsed.data), {
      includeTopTables: parsed.data.includeTopTables !== "0",
    });
    return NextResponse.json({ data });
  } catch (error) {
    return handleRevenueError(error, "[revenue] GET failed");
  }
}
