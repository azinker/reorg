import { NextResponse, type NextRequest } from "next/server";
import { buildInventoryForecastWorkbook, inventoryForecastExportFileName } from "@/lib/inventory-forecast/export";
import { forecastResultSchema } from "@/lib/inventory-forecast/schemas";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = forecastResultSchema.safeParse(body?.result);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const t0 = performance.now();
    const buffer = await buildInventoryForecastWorkbook(parsed.data);
    void recordNetworkTransferSample({
      channel: "FORECAST",
      label: "Inventory forecast — Excel file built on server (.xlsx sent to browser)",
      bytesEstimate: buffer.byteLength,
      durationMs: Math.round(performance.now() - t0),
      metadata: {
        route: "POST /api/inventory-forecaster/export",
        skuLineCount: parsed.data.lines.length,
      },
    });
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${inventoryForecastExportFileName(
          parsed.data.runDateTime,
        )}"`,
      },
    });
  } catch (error) {
    console.error("[inventory-forecaster/export] POST failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to export forecast",
      },
      { status: 500 },
    );
  }
}
