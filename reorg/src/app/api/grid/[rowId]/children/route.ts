import { NextResponse } from "next/server";
import { getGridChildRows } from "@/lib/grid-query";
import { getGridVersion } from "@/lib/grid-version";
import { getServerCachedValue } from "@/lib/server-cache";

export async function GET(
  _request: Request,
  context: { params: Promise<unknown> },
) {
  try {
    const { rowId } = (await context.params) as { rowId: string };
    const version = await getGridVersion();
    const data = await getServerCachedValue({
      key: `api:grid:children:${rowId}`,
      ttlMs: 5 * 60 * 1000,
      fingerprint: version,
      loader: async () => {
        const rows = await getGridChildRows(rowId);
        return { rows, total: rows.length, version };
      },
    });

    return NextResponse.json({ data });
  } catch (error) {
    console.error("[grid] Failed to fetch child rows", error);
    return NextResponse.json(
      { error: "Failed to fetch child rows", details: String(error) },
      { status: 500 },
    );
  }
}
