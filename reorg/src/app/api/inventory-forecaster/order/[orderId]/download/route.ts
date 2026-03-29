import { NextResponse, type NextRequest } from "next/server";
import { getOrderExportData } from "@/lib/inventory-forecast/service";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ orderId: string }> },
) {
  try {
    const { orderId } = await context.params;
    const result = await getOrderExportData(orderId);

    if (!result) {
      return NextResponse.json(
        { error: "This order has no linked forecast run. The export requires a saved forecast to include images, UPC barcodes, and full forecast details." },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: result });
  } catch (error) {
    console.error("[inventory-forecaster/order/:orderId/download] GET failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load order export data" },
      { status: 500 },
    );
  }
}
