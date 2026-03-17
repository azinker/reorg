import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const itemId = url.searchParams.get("itemId");
  const sku = url.searchParams.get("sku");

  try {
    if (itemId) {
      const listings = await db.marketplaceListing.findMany({
        where: { platformItemId: itemId },
        include: {
          integration: { select: { platform: true, label: true } },
          parentListing: { select: { id: true, sku: true, platformItemId: true, isVariation: true } },
          childListings: {
            select: { id: true, sku: true, platformVariantId: true, parentListingId: true },
          },
        },
        orderBy: { createdAt: "asc" },
      });

      const parentSku = `TPP-${itemId}`;
      const masterRow = await db.masterRow.findUnique({
        where: { sku: parentSku },
        include: {
          listings: {
            select: {
              id: true,
              platformItemId: true,
              platformVariantId: true,
              sku: true,
              isVariation: true,
              parentListingId: true,
            },
          },
        },
      });

      return NextResponse.json({
        query: { itemId },
        parentMasterRow: masterRow
          ? {
              id: masterRow.id,
              sku: masterRow.sku,
              title: masterRow.title?.slice(0, 80),
              listingCount: masterRow.listings.length,
              listings: masterRow.listings,
            }
          : null,
        allListingsForItem: listings.map((l) => ({
          id: l.id,
          sku: l.sku,
          platformItemId: l.platformItemId,
          platformVariantId: l.platformVariantId,
          isVariation: l.isVariation,
          parentListingId: l.parentListingId,
          masterRowId: l.masterRowId,
          platform: l.integration.platform,
          childCount: l.childListings.length,
          childIds: l.childListings.map((c) => c.sku),
        })),
      });
    }

    if (sku) {
      const masterRow = await db.masterRow.findUnique({
        where: { sku },
        include: {
          listings: {
            include: {
              integration: { select: { platform: true } },
              childListings: {
                select: { id: true, sku: true, platformVariantId: true, parentListingId: true },
              },
              parentListing: {
                select: { id: true, sku: true, platformItemId: true },
              },
            },
          },
        },
      });

      return NextResponse.json({
        query: { sku },
        masterRow: masterRow
          ? {
              id: masterRow.id,
              sku: masterRow.sku,
              title: masterRow.title?.slice(0, 80),
              listings: masterRow.listings.map((l) => ({
                id: l.id,
                platform: l.integration.platform,
                platformItemId: l.platformItemId,
                platformVariantId: l.platformVariantId,
                isVariation: l.isVariation,
                parentListingId: l.parentListingId,
                parentListing: l.parentListing,
                childCount: l.childListings.length,
                childSkus: l.childListings.map((c) => c.sku),
              })),
            }
          : null,
      });
    }

    const totalListings = await db.marketplaceListing.count();
    const variationListings = await db.marketplaceListing.count({ where: { isVariation: true } });
    const childListingsCount = await db.marketplaceListing.count({
      where: { parentListingId: { not: null } },
    });
    const parentVariationListings = await db.marketplaceListing.count({
      where: { isVariation: true, parentListingId: null },
    });

    const parentListings = await db.marketplaceListing.findMany({
      where: { isVariation: true, parentListingId: null },
      include: {
        childListings: {
          select: { id: true, sku: true, platformVariantId: true },
        },
      },
      take: 20,
    });

    return NextResponse.json({
      counts: {
        totalListings,
        variationListings,
        parentVariationListings,
        childListingsCount,
        nonVariation: totalListings - variationListings,
      },
      sampleParentListings: parentListings.map((p) => ({
        id: p.id,
        sku: p.sku,
        platformItemId: p.platformItemId,
        masterRowId: p.masterRowId,
        isVariation: p.isVariation,
        childCount: p.childListings.length,
        childSkus: p.childListings.map((c) => c.sku),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
