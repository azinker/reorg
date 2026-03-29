import { NextResponse, type NextRequest } from "next/server";
import { getOrderExportData } from "@/lib/inventory-forecast/service";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ orderId: string }> },
) {
  try {
    const { orderId } = await context.params;
    const t0 = performance.now();
    const result = await getOrderExportData(orderId);

    if (!result) {
      return NextResponse.json(
        { error: "This order has no linked forecast run. The export requires a saved forecast to include images, UPC barcodes, and full forecast details." },
        { status: 404 },
      );
    }

    const body = { data: result };
    void recordNetworkTransferSample({
      channel: "FORECAST",
      label: "Supplier order — loaded data for Excel (JSON to browser)",
      bytesEstimate: Buffer.byteLength(JSON.stringify(body), "utf8"),
      durationMs: Math.round(performance.now() - t0),
      metadata: {
        route: "GET /api/inventory-forecaster/order/:orderId/download",
        orderId,
      },
    });

    return NextResponse.json(body);
  } catch (error) {
    console.error("[inventory-forecaster/order/:orderId/download] GET failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load order export data" },
      { status: 500 },
    );
  }
}
