import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { forecastResultSchema } from "@/lib/inventory-forecast/schemas";
import { saveInventoryForecastRun } from "@/lib/inventory-forecast/service";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";

export async function POST(request: NextRequest) {
  try {
    const json = await request.json();
    const parsed = forecastResultSchema.safeParse(json?.result);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const t0 = performance.now();
    const session = await auth();
    const saved = await saveInventoryForecastRun({
      createdById: session?.user?.id ?? null,
      result: parsed.data,
    });

    const responseBody = {
      data: {
        id: saved.id,
        createdAt: saved.createdAt.toISOString(),
        lineCount: saved.lines.length,
      },
    };
    void recordNetworkTransferSample({
      channel: "FORECAST",
      label: "Inventory forecast — saved run to database",
      bytesEstimate: Buffer.byteLength(JSON.stringify(responseBody), "utf8"),
      durationMs: Math.round(performance.now() - t0),
      metadata: {
        route: "POST /api/inventory-forecaster/save-run",
        forecastRunId: saved.id,
        lineCount: saved.lines.length,
      },
    });

    return NextResponse.json(responseBody);
  } catch (error) {
    console.error("[inventory-forecaster/save-run] POST failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to save forecast run",
      },
      { status: 500 },
    );
  }
}
