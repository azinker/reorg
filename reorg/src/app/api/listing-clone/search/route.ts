import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCurrentCatalogPermissions } from "@/lib/catalog-permissions-server";
import { isAuthBypassEnabled } from "@/lib/app-env";
import type { Prisma } from "@prisma/client";
import type { Platform } from "@prisma/client";

const platformSchema = z.enum(["TPP_EBAY", "TT_EBAY"]);

function queryTokens(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 8);
}

function rankRow(
  row: {
    platformItemId: string;
    sku: string;
    title: string | null;
  },
  tokens: string[],
): number {
  const sku = row.sku.toLowerCase();
  const title = (row.title ?? "").toLowerCase();
  const pid = row.platformItemId;
  let score = 0;
  for (const t of tokens) {
    const tl = t.toLowerCase();
    if (pid.includes(t)) score += 12;
    if (sku.includes(tl)) score += 8;
    if (title.includes(tl)) score += 5;
  }
  return score;
}

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    if (!isAuthBypassEnabled()) {
      const session = await auth();
      if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const catalogPermissions = await getCurrentCatalogPermissions();
    if (
      catalogPermissions.hiddenColumns.includes("sku") ||
      catalogPermissions.hiddenColumns.includes("title") ||
      catalogPermissions.hiddenColumns.includes("itemIds")
    ) {
      return NextResponse.json({ data: [] });
    }

    const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    const platformParsed = platformSchema.safeParse(
      request.nextUrl.searchParams.get("platform"),
    );

    if (!platformParsed.success) {
      return NextResponse.json({ error: "Invalid platform" }, { status: 400 });
    }

    const platform = platformParsed.data;

    if (q.length < 2) {
      return NextResponse.json({ data: [] });
    }

    const tokens = queryTokens(q);
    if (tokens.length === 0) {
      return NextResponse.json({ data: [] });
    }

    const tokenPredicates: Prisma.MarketplaceListingWhereInput[] = tokens.map(
      (token) => ({
        OR: [
          { sku: { contains: token, mode: "insensitive" } },
          { title: { contains: token, mode: "insensitive" } },
          { platformItemId: { contains: token, mode: "insensitive" } },
        ],
      }),
    );

    const rows = await db.marketplaceListing.findMany({
      where: {
        integration: { platform: platform as Platform },
        platformVariantId: null,
        status: "ACTIVE",
        AND: tokenPredicates,
      },
      select: {
        id: true,
        platformItemId: true,
        sku: true,
        title: true,
        masterRowId: true,
        imageUrl: true,
      },
      orderBy: { lastSyncedAt: "desc" },
      take: 80,
    });

    const ranked = [...rows]
      .map((row) => ({
        row,
        score: rankRow(row, tokens),
      }))
      .sort((a, b) => b.score - a.score || a.row.sku.localeCompare(b.row.sku))
      .slice(0, 25)
      .map(({ row }) => ({
        marketplaceListingId: row.id,
        masterRowId: row.masterRowId,
        platformItemId: row.platformItemId,
        sku: row.sku,
        title: row.title,
        imageUrl: row.imageUrl ?? null,
      }));

    return NextResponse.json({ data: ranked });
  } catch (error) {
    console.error("[listing-clone/search] failed", error);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
