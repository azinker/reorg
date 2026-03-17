import { NextResponse } from "next/server";
import { db } from "@/lib/db";

const PLATFORM_TO_STORE: Record<string, string> = {
  TPP_EBAY: "tpp",
  TT_EBAY: "tt",
  BIGCOMMERCE: "bc",
  SHOPIFY: "shpfy",
};

export async function GET() {
  try {
    const list = await db.unmatchedListing.findMany({
      orderBy: { lastSyncedAt: "desc" },
      include: {
        integration: { select: { platform: true, label: true } },
      },
    });

    const data = list.map((u) => {
      const raw = (u.rawData as Record<string, unknown>) ?? {};
      const storeFilterValue = PLATFORM_TO_STORE[u.integration?.platform ?? ""] ?? "other";
      const platformLabel = (u.integration?.platform ?? "").toLowerCase().replace("_", " ");
      return {
        id: u.id,
        platformItemId: u.platformItemId,
        sku: u.sku,
        title: u.title,
        platform: u.integration?.platform ?? "",
        storeName: u.integration?.label ?? platformLabel,
        storeFilterValue,
        lastSyncedAt: u.lastSyncedAt?.toISOString() ?? u.createdAt.toISOString(),
        rawData: raw,
      };
    });

    return NextResponse.json({ data });
  } catch (error) {
    console.error("[unmatched] GET failed", error);
    return NextResponse.json(
      { error: "Failed to fetch unmatched listings" },
      { status: 500 }
    );
  }
}
