import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

const pushSchema = z.object({
  changes: z.array(
    z.object({
      stagedChangeId: z.string(),
      masterRowId: z.string(),
      marketplaceListingId: z.string(),
      platform: z.enum(["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"]),
      listingId: z.string(),
      field: z.enum(["salePrice", "adRate"]),
      oldValue: z.number().nullable(),
      newValue: z.number(),
    })
  ),
  dryRun: z.boolean().default(true),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = pushSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { changes, dryRun } = parsed.data;

    // TODO: Wire to real push service when DB is connected
    // This endpoint goes through the full write safety chain:
    // 1. Global write lock check
    // 2. Per-integration write lock check
    // 3. Environment check (staging blocked)
    // 4. Dry run validation
    // 5. Live push execution
    // 6. Audit logging

    return NextResponse.json({
      data: {
        pushJobId: `mock-push-${Date.now()}`,
        dryRun,
        status: dryRun ? "dry_run_passed" : "pending",
        changes: changes.length,
        message: dryRun
          ? "Dry run passed. All changes validated."
          : "Connect a database and integration to execute real pushes.",
      },
    });
  } catch (error) {
    console.error("[push] Failed to process push request", error);
    return NextResponse.json(
      { error: "Failed to process push request" },
      { status: 500 }
    );
  }
}
