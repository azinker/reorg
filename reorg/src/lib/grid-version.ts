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

export async function getGridVersion(): Promise<string | null> {
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

  return latestIso([
    latestListing?.updatedAt,
    latestMasterRow?.updatedAt,
    latestStagedChange?.updatedAt,
    latestIntegration?.lastSyncAt,
  ]);
}
