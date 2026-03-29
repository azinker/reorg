import { NextResponse } from "next/server";
import { getGridData } from "@/lib/grid-query";
import { getGridVersion } from "@/lib/grid-version";
import { getServerCachedValue } from "@/lib/server-cache";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Note: cleanupFalseVariationFamilies() is intentionally NOT called here.
    // It already runs automatically at the end of every BC/Shopify sync via
    // repairVariationFamiliesForIntegration(). Running it on every grid load
    // added a DB round-trip with no benefit once the initial cleanup is done.
    // The buildGridRow() filter in grid-query.ts provides a defensive UI-level
    // guard for any synthetic rows that may still exist in the DB.
    const t0 = performance.now();
    const version = await getGridVersion();
    if (process.env.NODE_ENV !== "production") {
      const rows = await getGridData();
      const body = { data: { rows, total: rows.length, version } };
      const bytesEstimate = Buffer.byteLength(JSON.stringify(body), "utf8");
      recordNetworkTransferSample({
        channel: "CLIENT_API_RESPONSE",
        label: "GET /api/grid",
        bytesEstimate,
        durationMs: Math.round(performance.now() - t0),
        metadata: { cacheHit: false, rowCount: rows.length, version, env: "development" },
      });
      return NextResponse.json(body);
    }

    let cacheHit = true;
    const data = await getServerCachedValue({
      key: "api:grid",
      ttlMs: 5 * 60 * 1000,
      fingerprint: version,
      loader: async () => {
        cacheHit = false;
        const rows = await getGridData();
        return { rows, total: rows.length, version };
      },
    });

    const responseBody = { data };
    const bytesEstimate = Buffer.byteLength(JSON.stringify(responseBody), "utf8");
    recordNetworkTransferSample({
      channel: "CLIENT_API_RESPONSE",
      label: "GET /api/grid",
      bytesEstimate,
      durationMs: Math.round(performance.now() - t0),
      metadata: {
        cacheHit,
        rowCount: data.total,
        version,
        env: "production",
      },
    });

    return NextResponse.json(responseBody);
  } catch (error) {
    console.error("[grid] Failed to fetch grid data", error);
    return NextResponse.json(
      { error: "Failed to fetch grid data", details: String(error) },
      { status: 500 }
    );
  }
}
