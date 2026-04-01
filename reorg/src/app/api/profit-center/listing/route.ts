import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getProfitCenterListingDetail } from "@/lib/services/ops-insights";

const querySchema = z.object({
  marketplaceListingId: z.string().min(1),
});

export async function GET(request: NextRequest) {
  try {
    const parsed = querySchema.safeParse({
      marketplaceListingId: request.nextUrl.searchParams.get("marketplaceListingId") ?? "",
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = await getProfitCenterListingDetail(parsed.data.marketplaceListingId);
    if (!data) {
      return NextResponse.json({ error: "Profit Center listing not found." }, { status: 404 });
    }

    return NextResponse.json({ data });
  } catch (error) {
    console.error("[profit-center/listing] Failed to load listing detail", error);
    return NextResponse.json(
      { error: "Failed to load the requested listing detail." },
      { status: 500 },
    );
  }
}
