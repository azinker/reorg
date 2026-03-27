import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const bodySchema = z.object({
  listingId: z.string().min(1),
  newMasterSku: z.string().min(1).max(200),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ rowId: string }> },
) {
  try {
    const { rowId } = await params;
    const body = await request.json();
    const parsed = bodySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { listingId, newMasterSku } = parsed.data;

    // Verify the listing exists and belongs to this master row
    const listing = await db.marketplaceListing.findUnique({
      where: { id: listingId },
      select: { id: true, masterRowId: true, sku: true, integration: { select: { platform: true } } },
    });

    if (!listing) {
      return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    }

    if (listing.masterRowId !== rowId) {
      return NextResponse.json(
        { error: "Listing does not belong to this row" },
        { status: 400 },
      );
    }

    const trimmedSku = newMasterSku.trim();

    // If the new SKU is the same as current, no-op
    if (trimmedSku === listing.sku) {
      return NextResponse.json({ data: { ok: true, newMasterSku: trimmedSku, unchanged: true } });
    }

    // Find or create the new master row
    let newMaster = await db.masterRow.findUnique({
      where: { sku: trimmedSku },
    });

    const oldMasterRowId = listing.masterRowId;

    if (!newMaster) {
      // Pull the current master row's title as a starting point
      const oldMaster = await db.masterRow.findUnique({
        where: { id: oldMasterRowId },
        select: { title: true },
      });
      newMaster = await db.masterRow.create({
        data: {
          sku: trimmedSku,
          title: oldMaster?.title ?? undefined,
        },
      });
    }

    // Update the listing to point at the new master row
    await db.marketplaceListing.update({
      where: { id: listingId },
      data: {
        masterRowId: newMaster.id,
        sku: newMaster.sku,
      },
    });

    // Migrate staged changes that belong to this specific listing
    await db.stagedChange.updateMany({
      where: {
        masterRowId: oldMasterRowId,
        marketplaceListingId: listingId,
      },
      data: {
        masterRowId: newMaster.id,
      },
    });

    return NextResponse.json({
      data: {
        ok: true,
        newMasterSku: newMaster.sku,
        newMasterRowId: newMaster.id,
      },
    });
  } catch (error) {
    console.error("[grid/rematch] Failed", error);
    return NextResponse.json(
      { error: "Failed to rematch listing" },
      { status: 500 },
    );
  }
}
