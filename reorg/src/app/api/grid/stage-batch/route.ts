import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const UPC_STAGEABLE_PLATFORMS = new Set(["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"]);

const itemSchema = z.object({
  sku: z.string(),
  platform: z.string(),
  listingId: z.string(),
  newValue: z.string(),
  rejectionReason: z.string().optional(),
});

const batchSchema = z.object({
  action: z.enum(["stage_local_only"]),
  items: z.array(itemSchema).min(1).max(500),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = batchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { items } = parsed.data;
    const uniqueSkus = [...new Set(items.map((i) => i.sku))];

    const masterRows = await db.masterRow.findMany({
      where: { sku: { in: uniqueSkus } },
      include: {
        listings: {
          select: {
            id: true,
            platformItemId: true,
            integration: { select: { platform: true } },
          },
        },
      },
    });
    const masterBySku = new Map(masterRows.map((mr) => [mr.sku, mr]));

    let systemUser = await db.user.findFirst({ where: { role: "ADMIN" } });
    if (!systemUser) {
      systemUser = await db.user.create({
        data: { email: "system@reorg.internal", name: "System", role: "ADMIN" },
      });
    }

    let saved = 0;
    let skipped = 0;
    const errors: Array<{ sku: string; reason: string }> = [];

    for (const item of items) {
      const master = masterBySku.get(item.sku);
      if (!master) {
        errors.push({ sku: item.sku, reason: "Product not found" });
        continue;
      }

      const normalizedUpc = item.newValue.trim();
      if (!normalizedUpc) {
        errors.push({ sku: item.sku, reason: "Empty UPC value" });
        continue;
      }

      const eligibleListings = master.listings.filter((entry) => {
        if (!UPC_STAGEABLE_PLATFORMS.has(entry.integration.platform)) return false;
        if (entry.integration.platform !== item.platform) return false;
        if (entry.platformItemId !== item.listingId) return false;
        return true;
      });

      if (eligibleListings.length === 0) {
        errors.push({ sku: item.sku, reason: "No matching listing found" });
        continue;
      }

      const targetListingIds = eligibleListings.map((l) => l.id);
      const liveValue = master.upc?.trim() || null;
      const reason =
        item.rejectionReason?.trim() ||
        "Saved locally (dashboard only — not applied on the marketplace).";

      try {
        await db.$transaction(async (tx) => {
          await tx.stagedChange.updateMany({
            where: {
              masterRowId: master.id,
              marketplaceListingId: { in: targetListingIds },
              field: "upc",
              status: { in: ["STAGED", "LOCAL_ONLY"] },
            },
            data: { status: "CANCELLED" },
          });

          await tx.stagedChange.createMany({
            data: eligibleListings.map((listing) => ({
              masterRowId: master.id,
              marketplaceListingId: listing.id,
              field: "upc",
              stagedValue: normalizedUpc,
              liveValue,
              status: "LOCAL_ONLY" as const,
              rejectionReason: reason,
              changedById: systemUser.id,
            })),
          });
        });
        saved++;
      } catch (txErr) {
        const msg = txErr instanceof Error ? txErr.message : "Transaction failed";
        errors.push({ sku: item.sku, reason: msg });
      }
    }

    if (saved > 0) {
      await db.auditLog.create({
        data: {
          userId: systemUser.id,
          action: "staged_change_local_only_batch",
          entityType: "StagedChange",
          entityId: "batch",
          details: {
            savedCount: saved,
            skippedCount: skipped,
            errorCount: errors.length,
          },
        },
      });
    }

    return NextResponse.json({
      data: { saved, skipped, errors },
    });
  } catch (error) {
    console.error("[grid/stage-batch] Failed", error);
    return NextResponse.json(
      { error: "Failed to process batch staging action" },
      { status: 500 },
    );
  }
}
