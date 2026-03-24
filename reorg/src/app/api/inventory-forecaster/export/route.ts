import { NextResponse, type NextRequest } from "next/server";
import { buildInventoryForecastWorkbook, inventoryForecastExportFileName } from "@/lib/inventory-forecast/export";
import { forecastResultSchema } from "@/lib/inventory-forecast/schemas";

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

    const buffer = await buildInventoryForecastWorkbook(parsed.data);
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
