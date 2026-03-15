import { NextResponse } from "next/server";

export async function GET() {
  // TODO: Wire to real database queries when DB is connected
  // This endpoint returns the main grid data:
  // - MasterRows with linked MarketplaceListings
  // - StagedChanges merged for display
  // - Shipping costs calculated from weight/rate table
  // - Profit calculations per store

  return NextResponse.json({
    data: {
      rows: [],
      total: 0,
      message: "Connect a database to fetch real grid data. Using mock data on the client.",
    },
  });
}
