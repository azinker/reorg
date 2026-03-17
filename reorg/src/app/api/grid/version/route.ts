import { NextResponse } from "next/server";
import { db } from "@/lib/db";

function latestIso(values: Array<Date | null | undefined>): string | null {
  const timestamps = values
    .map((value) => value?.getTime())
    .filter((value): value is number => typeof value === "number" && !Number.isNaN(value));

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

export async function GET() {
  try {
    const [latestListing, latestMasterRow, latestStagedChange, latestIntegration] =
      await Promise.all([
        db.marketplaceListing.findFirst({
          orderBy: { updatedAt: "desc" },
          select: { updatedAt: true },
        }),
        db.masterRow.findFirst({
          orderBy: { updatedAt: "desc" },
          select: { updatedAt: true },
        }),
        db.stagedChange.findFirst({
          orderBy: { updatedAt: "desc" },
          select: { updatedAt: true },
        }),
        db.integration.findFirst({
          orderBy: { lastSyncAt: "desc" },
          select: { lastSyncAt: true },
        }),
      ]);

    return NextResponse.json({
      data: {
        version: latestIso([
          latestListing?.updatedAt,
          latestMasterRow?.updatedAt,
          latestStagedChange?.updatedAt,
          latestIntegration?.lastSyncAt,
        ]),
      },
    });
  } catch (error) {
    console.error("[grid/version] Failed to fetch grid version", error);
    return NextResponse.json(
      { error: "Failed to fetch grid version" },
      { status: 500 },
    );
  }
}
