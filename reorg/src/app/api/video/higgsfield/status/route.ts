import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getRequiredSessionUser } from "@/lib/server-auth";
import { getHiggsfieldRequestStatus } from "@/lib/services/video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  requestId: z.string().min(8).max(120).regex(/^[a-zA-Z0-9_-]+$/),
});

export async function GET(request: NextRequest) {
  const user = await getRequiredSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = querySchema.safeParse({
      requestId: request.nextUrl.searchParams.get("requestId") ?? "",
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const status = await getHiggsfieldRequestStatus(parsed.data.requestId);
    return NextResponse.json({ data: status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load Higgsfield status.";
    console.error("[video/higgsfield/status] Failed", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
