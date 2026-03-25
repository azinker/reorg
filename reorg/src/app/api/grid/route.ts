import { NextResponse } from "next/server";
import { getGridData } from "@/lib/grid-query";
import { getGridVersion } from "@/lib/grid-version";
import { getServerCachedValue } from "@/lib/server-cache";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const version = await getGridVersion();
    if (process.env.NODE_ENV !== "production") {
      const rows = await getGridData();
      return NextResponse.json({
        data: { rows, total: rows.length, version },
      });
    }

    const data = await getServerCachedValue({
      key: "api:grid",
      ttlMs: 5 * 60 * 1000,
      fingerprint: version,
      loader: async () => {
        const rows = await getGridData();
        return { rows, total: rows.length, version };
      },
    });

    return NextResponse.json({ data });
  } catch (error) {
    console.error("[grid] Failed to fetch grid data", error);
    return NextResponse.json(
      { error: "Failed to fetch grid data", details: String(error) },
      { status: 500 }
    );
  }
}
