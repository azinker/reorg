import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getProfitCenterLoserPage } from "@/lib/services/ops-insights";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export async function GET(request: NextRequest) {
  try {
    const parsed = querySchema.safeParse({
      page: request.nextUrl.searchParams.get("page") ?? "1",
      pageSize: request.nextUrl.searchParams.get("pageSize") ?? "20",
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = await getProfitCenterLoserPage(parsed.data.page, parsed.data.pageSize);
    return NextResponse.json({ data });
  } catch (error) {
    console.error("[profit-center/losers] Failed to load loser page", error);
    return NextResponse.json(
      { error: "Failed to load the requested loser page." },
      { status: 500 },
    );
  }
}
