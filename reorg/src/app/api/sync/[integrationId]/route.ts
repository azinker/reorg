import { NextResponse, type NextRequest } from "next/server";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  const { integrationId } = await params;

  // TODO: Wire to real sync service when DB is connected
  // This endpoint triggers a pull-only sync for a specific integration
  // It NEVER pushes data to marketplaces

  return NextResponse.json({
    data: {
      syncJobId: `mock-sync-${Date.now()}`,
      integrationId,
      status: "pending",
      message: "Sync queued. Connect a database and integration to run real syncs.",
    },
  });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  const { integrationId } = await params;

  return NextResponse.json({
    data: {
      integrationId,
      lastSync: null,
      status: "idle",
    },
  });
}
