import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { buildLiveUpcSummary } from "@/lib/upc-live";

const bulkUpcSchema = z.object({
  rowIds: z.array(z.string().min(1)).max(10_000).optional().default([]),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = bulkUpcSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ data: { items: [] } });
    }

    const requestedRowIds = [...new Set(parsed.data.rowIds)];
    const rowIdMap = new Map(
      requestedRowIds.map((rowId) => [rowId, rowId.startsWith("child-") ? rowId.replace(/^child-/, "") : rowId]),
    );
    const masterRowIds = [...new Set(rowIdMap.values())];

    const rows = await db.masterRow.findMany({
      where: { id: { in: masterRowIds } },
      select: {
        id: true,
        upc: true,
        listings: {
          select: {
            rawData: true,
            integration: {
              select: {
                platform: true,
              },
            },
          },
        },
      },
    });

    const rowById = new Map(rows.map((row) => [row.id, row]));
    const items = requestedRowIds.flatMap((rowId) => {
      const masterRowId = rowIdMap.get(rowId);
      if (!masterRowId) return [];
      const row = rowById.get(masterRowId);
      if (!row) return [];
      const summary = buildLiveUpcSummary(row.listings, row.upc);
      return [{ rowId, choices: summary.choices }];
    });

    return NextResponse.json(
      { data: { items } },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("[grid] Failed to bulk fetch UPC summaries", error);
    return NextResponse.json(
      { error: "Failed to bulk fetch UPC summaries", details: String(error) },
      { status: 500 },
    );
  }
}
