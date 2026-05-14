import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getRequiredSessionUser } from "@/lib/server-auth";
import { getVideoListingBrief } from "@/lib/services/video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  marketplaceListingId: z.string().min(1),
});

export async function GET(request: NextRequest) {
  const user = await getRequiredSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

    const brief = await getVideoListingBrief(parsed.data.marketplaceListingId);
    if (!brief) {
      return NextResponse.json({ error: "TPP eBay listing not found." }, { status: 404 });
    }

    return NextResponse.json({ data: brief });
  } catch (error) {
    console.error("[video/brief] Failed to load listing brief", error);
    return NextResponse.json(
      { error: "Failed to load video brief for this listing." },
      { status: 500 },
    );
  }
}
