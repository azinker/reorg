import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildLiveUpcSummary } from "@/lib/upc-live";
import { hydrateMissingEbayListingUpc } from "@/lib/services/ebay-live-upc";
import { Platform } from "@prisma/client";

type RowUpcSummaryRow = {
  id?: string;
  upc: string | null;
  listings: Array<{
    id: string;
    masterRowId: string;
    platformItemId: string;
    rawData: unknown;
    integration: {
      id: string;
      platform: Platform;
      config: unknown;
    };
    childListings?: Array<{
      masterRowId: string;
    }>;
  }>;
};

async function hydrateRowListings(row: RowUpcSummaryRow) {
  let changed = false;
  for (const listing of row.listings) {
    const platform = listing.integration.platform;
    if (platform !== Platform.TPP_EBAY && platform !== Platform.TT_EBAY) {
      continue;
    }

    const hydratedUpc = await hydrateMissingEbayListingUpc({
      id: listing.id,
      masterRowId: listing.masterRowId,
      platformItemId: listing.platformItemId,
      rawData: listing.rawData,
      integration: listing.integration,
      masterRowUpc: row.upc,
    }).catch(() => null);

    if (hydratedUpc) {
      changed = true;
    }
  }

  return changed;
}

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
            id: true,
            masterRowId: true,
            platformItemId: true,
            rawData: true,
            integration: {
              select: {
                id: true,
                platform: true,
                config: true,
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

    let hydratedRow = row;
    const rowHydrated = await hydrateRowListings(row);
    if (rowHydrated) {
      hydratedRow = (await db.masterRow.findUnique({
        where: { id: masterRowId },
        select: {
          upc: true,
          listings: {
            select: {
              id: true,
              masterRowId: true,
              platformItemId: true,
              rawData: true,
              integration: {
                select: {
                  id: true,
                  platform: true,
                  config: true,
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
      })) ?? row;
    }

    const summary = buildLiveUpcSummary(hydratedRow.listings, hydratedRow.upc);
    let lines = summary.lines;
    const choices = summary.choices;

    if (!isChildRow) {
      const childMasterRowIds = [
        ...new Set(
          hydratedRow.listings.flatMap((listing) =>
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
            id: true,
            upc: true,
            listings: {
              select: {
                id: true,
                masterRowId: true,
                platformItemId: true,
                rawData: true,
                integration: {
                  select: {
                    id: true,
                    platform: true,
                    config: true,
                  },
                },
              },
            },
          },
        });

        const hydratedChildRows: RowUpcSummaryRow[] = [];
        for (const childRow of childRows) {
          const childChanged = await hydrateRowListings(childRow);
          if (!childChanged) {
            hydratedChildRows.push(childRow);
            continue;
          }

          const childRowId = childRow.id;
          const refreshedChildRow = childRowId
            ? await db.masterRow.findUnique({
                where: { id: childRowId },
                select: {
                  id: true,
                  upc: true,
                  listings: {
                    select: {
                      id: true,
                      masterRowId: true,
                      platformItemId: true,
                      rawData: true,
                      integration: {
                        select: {
                          id: true,
                          platform: true,
                          config: true,
                        },
                      },
                    },
                  },
                },
              })
            : null;
          hydratedChildRows.push(refreshedChildRow ?? childRow);
        }

        const childSummaries = hydratedChildRows
          .map((childRow) => buildLiveUpcSummary(childRow.listings, childRow.upc))
          .filter((childSummary) => childSummary.representativeValue);

        const allChildrenMatched =
          childSummaries.length > 0 && childSummaries.every((childSummary) => childSummary.allStores);

        if (allChildrenMatched) {
          const parentDisplayValue =
            summary.representativeValue ??
            childSummaries[0]?.representativeValue ??
            hydratedRow.upc;

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
