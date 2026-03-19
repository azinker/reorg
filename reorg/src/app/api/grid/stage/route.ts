import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const stageSchema = z.object({
  action: z.enum(["stage", "push", "discard", "clear_all"]),
  sku: z.string().optional(),
  platform: z.string().optional(),
  listingId: z.string().optional(),
  newPrice: z.number().optional(),
  field: z.enum(["salePrice", "adRate"]).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = stageSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { action, sku, platform, listingId, newPrice, field: stageField } = parsed.data;
    const targetField = stageField ?? "salePrice";

    if (action === "clear_all") {
      const cancelled = await db.stagedChange.updateMany({
        where: { status: "STAGED" },
        data: { status: "CANCELLED" },
      });
      return NextResponse.json({ data: { cleared: cancelled.count } });
    }

    if (!sku || !platform || !listingId) {
      return NextResponse.json({ error: "sku, platform, listingId required" }, { status: 400 });
    }

    const master = await db.masterRow.findUnique({ where: { sku } });
    if (!master) {
      return NextResponse.json({ error: `Product not found: ${sku}` }, { status: 404 });
    }

    const listing = await db.marketplaceListing.findFirst({
      where: {
        masterRowId: master.id,
        platformItemId: listingId,
        integration: { platform: platform as never },
      },
    });

    if (!listing) {
      return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    }

    if (action === "stage" && newPrice != null) {
      const liveValue = targetField === "adRate" ? listing.adRate : listing.salePrice;
      const existingStaged = await db.stagedChange.findFirst({
        where: {
          masterRowId: master.id,
          marketplaceListingId: listing.id,
          field: targetField,
          status: "STAGED",
        },
        orderBy: { createdAt: "desc" },
      });
      const effectiveValue = existingStaged?.stagedValue != null
        ? Number(existingStaged.stagedValue)
        : liveValue;
      const matchesLive = liveValue != null && Math.abs(Number(liveValue) - newPrice) < 0.000001;
      const matchesCurrent = effectiveValue != null && Math.abs(Number(effectiveValue) - newPrice) < 0.000001;

      if (matchesCurrent) {
        return NextResponse.json({
          data: { action: "noop", reason: "unchanged", sku, listingId, field: targetField, newPrice },
        });
      }

      await db.stagedChange.updateMany({
        where: {
          masterRowId: master.id,
          marketplaceListingId: listing.id,
          field: targetField,
          status: "STAGED",
        },
        data: { status: "CANCELLED" },
      });

      if (matchesLive) {
        return NextResponse.json({
          data: { action: "noop", reason: "matches-live", sku, listingId, field: targetField, newPrice },
        });
      }

      const systemUser = await getSystemUser();
      await db.stagedChange.create({
        data: {
          masterRowId: master.id,
          marketplaceListingId: listing.id,
          field: targetField,
          stagedValue: String(newPrice),
          liveValue: liveValue != null ? String(liveValue) : null,
          changedById: systemUser.id,
        },
      });

      await db.auditLog.create({
        data: {
          userId: systemUser.id,
          action: "staged_change",
          entityType: "StagedChange",
          entityId: master.id,
          details: {
            sku: master.sku,
            field: targetField,
            oldValue: liveValue != null ? String(liveValue) : null,
            newValue: String(newPrice),
            platform,
            listingId,
          },
        },
      });

      return NextResponse.json({ data: { action: "staged", sku, listingId, field: targetField, newPrice } });
    }

    if (action === "push" && newPrice != null) {
      return NextResponse.json(
        {
          error:
            "Direct push from the staging route is disabled. Run the guarded /api/push dry-run and confirmation flow instead.",
        },
        { status: 409 },
      );
    }

    if (action === "discard") {
      const discarded = await db.stagedChange.updateMany({
        where: {
          masterRowId: master.id,
          marketplaceListingId: listing.id,
          field: targetField,
          status: "STAGED",
        },
        data: { status: "CANCELLED" },
      });

      return NextResponse.json({ data: { action: "discarded", sku, listingId, field: targetField, count: discarded.count } });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("[grid/stage] Failed to process staging action", error);
    return NextResponse.json(
      { error: "Failed to process staging action" },
      { status: 500 }
    );
  }
}

async function getSystemUser() {
  let user = await db.user.findFirst({ where: { role: "ADMIN" } });
  if (!user) {
    user = await db.user.create({
      data: {
        email: "system@reorg.internal",
        name: "System",
        role: "ADMIN",
      },
    });
  }
  return user;
}
