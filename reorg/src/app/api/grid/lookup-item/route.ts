import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";
import type { Platform as PrismaPlatform } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const platformSchema = z.enum(["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"]);

function buildPlatformItemIdCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const out = new Set<string>([trimmed]);
  if (/^\d+$/.test(trimmed)) {
    out.add(`SH-${trimmed}`);
    out.add(`BC-${trimmed}`);
  }
  return [...out];
}

/** Grid row id: child variation rows use `child-${masterRowId}`. */
function gridRowIdFromListing(listing: {
  masterRowId: string;
  parentListingId: string | null;
}): string {
  return listing.parentListingId != null ? `child-${listing.masterRowId}` : listing.masterRowId;
}

export async function GET(request: NextRequest) {
  const t0 = performance.now();
  const session = await auth();
  if (!session?.user?.id && !isAuthBypassEnabled()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const platformItemIdParam = request.nextUrl.searchParams.get("platformItemId");
  const itemIdAlias = request.nextUrl.searchParams.get("itemId");
  const rawId = platformItemIdParam ?? itemIdAlias;
  if (!rawId?.trim()) {
    return NextResponse.json(
      { error: "Missing platformItemId or itemId query parameter" },
      { status: 400 },
    );
  }

  const platformParam = request.nextUrl.searchParams.get("platform");
  const platformParsed = platformParam ? platformSchema.safeParse(platformParam) : null;
  const platformFilter: PrismaPlatform | undefined = platformParsed?.success
    ? platformParsed.data
    : undefined;

  const candidates = buildPlatformItemIdCandidates(rawId);
  if (candidates.length === 0) {
    return NextResponse.json({ error: "Invalid item id" }, { status: 400 });
  }

  const listings = await db.marketplaceListing.findMany({
    where: {
      platformItemId: { in: candidates },
      ...(platformFilter ? { integration: { platform: platformFilter } } : {}),
    },
    select: {
      masterRowId: true,
      parentListingId: true,
      platformItemId: true,
      integration: { select: { platform: true } },
    },
    take: 25,
  });

  if (listings.length === 0) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  const platformOrder: PrismaPlatform[] = ["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"];
  const rank = (p: PrismaPlatform) => {
    const i = platformOrder.indexOf(p);
    return i === -1 ? 99 : i;
  };

  listings.sort((a, b) => rank(a.integration.platform) - rank(b.integration.platform));

  const chosen = listings[0]!;
  const rowId = gridRowIdFromListing(chosen);

  const body = {
    data: {
      rowId,
      platform: chosen.integration.platform,
      platformItemId: chosen.platformItemId,
      ambiguous: listings.length > 1,
    },
  };
  const bytesEstimate = Buffer.byteLength(JSON.stringify(body), "utf8");
  void recordNetworkTransferSample({
    channel: "CLIENT_API_RESPONSE",
    label: "GET /api/grid/lookup-item",
    bytesEstimate,
    durationMs: Math.round(performance.now() - t0),
    metadata: { rowId, ambiguous: body.data.ambiguous },
  });

  return NextResponse.json(body);
}
