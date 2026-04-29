import { NextResponse } from "next/server";
import { getGridChildRows } from "@/lib/grid-query";
import { getGridVersion } from "@/lib/grid-version";
import { getServerCachedValue } from "@/lib/server-cache";
import { getCurrentCatalogPermissions } from "@/lib/catalog-permissions-server";
import { redactGridRowsForCatalogPermissions } from "@/lib/catalog-permissions";

export async function GET(
  _request: Request,
  context: { params: Promise<unknown> },
) {
  try {
    const { rowId } = (await context.params) as { rowId: string };
    const version = await getGridVersion();
    const catalogPermissions = await getCurrentCatalogPermissions();
    const data = await getServerCachedValue({
      key: `api:grid:children:${rowId}`,
      ttlMs: 5 * 60 * 1000,
      fingerprint: version,
      loader: async () => {
        const rows = await getGridChildRows(rowId);
        return { rows, total: rows.length, version };
      },
    });

    const rows = redactGridRowsForCatalogPermissions(data.rows, catalogPermissions);
    return NextResponse.json({ data: { ...data, rows, total: rows.length } });
  } catch (error) {
    console.error("[grid] Failed to fetch child rows", error);
    return NextResponse.json(
      { error: "Failed to fetch child rows", details: String(error) },
      { status: 500 },
    );
  }
}
