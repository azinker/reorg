import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getRequiredSessionUser } from "@/lib/server-auth";
import {
  getHiggsfieldConnectionStatus,
  getTopTppVideoItems,
  type VideoWindow,
} from "@/lib/services/video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  window: z.enum(["7d", "30d", "90d"]).default("30d"),
  limit: z.coerce.number().int().min(5).max(100).default(30),
});

export async function GET(request: NextRequest) {
  const user = await getRequiredSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = querySchema.safeParse({
      window: request.nextUrl.searchParams.get("window") ?? undefined,
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await getTopTppVideoItems(parsed.data.window as VideoWindow, parsed.data.limit);
    return NextResponse.json({
      data: {
        items: result.items,
        coverage: result.coverage,
        connection: getHiggsfieldConnectionStatus(),
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[video/items] Failed to load TPP video items", error);
    return NextResponse.json(
      { error: "Failed to load top TPP items for video." },
      { status: 500 },
    );
  }
}
