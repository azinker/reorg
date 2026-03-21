import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildLiveUpcSummary } from "@/lib/upc-live";

export async function GET(
  _request: Request,
  context: { params: Promise<unknown> },
) {
  try {
    const { rowId } = (await context.params) as { rowId: string };
    const isChildRow = rowId.startsWith("child-");
    const masterRowId = isChildRow ? rowId.replace(/^child-/, "") : rowId;

    const row = await db.masterRow.findUnique({
      where: { id: masterRowId },
      select: {
        upc: true,
        listings: {
          select: {
            rawData: true,
            integration: {
              select: {
                platform: true,
              },
            },
            childListings: {
              select: {
                masterRowId: true,
              },
            },
          },
        },
      },
    });

    if (!row) {
      return NextResponse.json({ error: "Row not found" }, { status: 404 });
    }

    const summary = buildLiveUpcSummary(row.listings, row.upc);
    let lines = summary.lines;
    const choices = summary.choices;

    if (!isChildRow) {
      const childMasterRowIds = [
        ...new Set(
          row.listings.flatMap((listing) =>
            listing.childListings
              .map((child) => child.masterRowId)
              .filter((value): value is string => typeof value === "string" && value.length > 0),
          ),
        ),
      ];

      if (childMasterRowIds.length > 0) {
        const childRows = await db.masterRow.findMany({
          where: { id: { in: childMasterRowIds } },
          select: {
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

        const childSummaries = childRows
          .map((childRow) => buildLiveUpcSummary(childRow.listings, childRow.upc))
          .filter((childSummary) => childSummary.representativeValue);

        const allChildrenMatched =
          childSummaries.length > 0 && childSummaries.every((childSummary) => childSummary.allStores);

        if (allChildrenMatched) {
          const parentDisplayValue =
            summary.representativeValue ??
            childSummaries[0]?.representativeValue ??
            row.upc;

          if (parentDisplayValue) {
            lines = [
              {
                kind: "all",
                label: "All Stores",
                value: parentDisplayValue,
              },
            ];
          }
        }
      }
    }

    return NextResponse.json(
      { data: { lines, choices } },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("[grid] Failed to fetch UPC live summary", error);
    return NextResponse.json(
      { error: "Failed to fetch UPC live summary", details: String(error) },
      { status: 500 },
    );
  }
}
