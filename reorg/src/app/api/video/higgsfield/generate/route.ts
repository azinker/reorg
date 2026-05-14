import { NextResponse } from "next/server";
import { z } from "zod";
import { getRequiredSessionUser } from "@/lib/server-auth";
import { submitHiggsfieldVideoGeneration } from "@/lib/services/video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  marketplaceListingId: z.string().min(1),
  durationSeconds: z.number().int().min(6).max(20).optional(),
});

export async function POST(request: Request) {
  const user = await getRequiredSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rawBody = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await submitHiggsfieldVideoGeneration({
      ...parsed.data,
      userId: user.id,
    });

    return NextResponse.json({ data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to submit Higgsfield generation.";
    console.error("[video/higgsfield/generate] Failed", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
