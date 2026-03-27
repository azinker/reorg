import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const maxDuration = 30;

export async function GET() {
  const parentListings = await db.marketplaceListing.findMany({
    where: {
      integration: { platform: "TPP_EBAY" },
      isVariation: true,
      platformVariantId: null,
    },
    select: {
      platformItemId: true,
      title: true,
      imageUrl: true,
      rawData: true,
      childListings: {
        select: {
          sku: true,
          platformVariantId: true,
          imageUrl: true,
          masterRow: { select: { imageUrl: true } },
        },
        take: 3,
      },
    },
    take: 5,
  });

  const results = parentListings.map((listing) => {
    const raw = listing.rawData as Record<string, unknown> | null;
    const variations = raw?.Variations as Record<string, unknown> | undefined;
    const pictures = variations?.Pictures as Record<string, unknown> | undefined;
    const pictureSets = pictures?.VariationSpecificPictureSet;
    const pictureDimension = pictures?.VariationSpecificName;
    const variationKeys = variations ? Object.keys(variations) : [];

    return {
      itemId: listing.platformItemId,
      title: listing.title?.slice(0, 60),
      parentImageUrl: listing.imageUrl?.slice(0, 80),
      hasVariationsNode: !!variations,
      variationKeys,
      hasPicturesNode: !!pictures,
      picturesKeys: pictures ? Object.keys(pictures) : [],
      pictureDimension: pictureDimension ?? null,
      pictureSetsCount: Array.isArray(pictureSets) ? pictureSets.length : pictureSets ? 1 : 0,
      samplePictureSet: Array.isArray(pictureSets)
        ? pictureSets[0]
        : pictureSets ?? null,
      children: listing.childListings.map((child) => ({
        sku: child.sku,
        variantId: child.platformVariantId,
        listingImageUrl: child.imageUrl?.slice(0, 80) ?? null,
        masterRowImageUrl: child.masterRow.imageUrl?.slice(0, 80) ?? null,
      })),
    };
  });

  return NextResponse.json({
    totalVariationParents: parentListings.length,
    results,
  });
}
