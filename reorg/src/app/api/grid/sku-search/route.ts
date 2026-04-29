import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getCurrentCatalogPermissions } from "@/lib/catalog-permissions-server";

export async function GET(request: NextRequest) {
  try {
    const catalogPermissions = await getCurrentCatalogPermissions();
    if (
      catalogPermissions.hiddenColumns.includes("sku") ||
      catalogPermissions.hiddenColumns.includes("title") ||
      catalogPermissions.hiddenColumns.includes("itemIds")
    ) {
      return NextResponse.json({ data: [] });
    }

    const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";

    if (q.length === 0) {
      return NextResponse.json({ data: [] });
    }

    const rows = await db.masterRow.findMany({
      where: {
        isActive: true,
        sku: { contains: q, mode: "insensitive" },
      },
      select: {
        id: true,
        sku: true,
        title: true,
        listings: {
          select: {
            id: true,
            platformItemId: true,
            integration: { select: { platform: true } },
          },
        },
      },
      orderBy: { sku: "asc" },
      take: 15,
    });

    const results = rows.map((row) => ({
      id: row.id,
      sku: row.sku,
      title: row.title,
      stores: row.listings.map((l) => ({
        marketplaceListingId: l.id,
        platform: l.integration.platform,
        itemId: l.platformItemId,
      })),
    }));

    return NextResponse.json({ data: results });
  } catch (error) {
    console.error("[sku-search] failed", error);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
