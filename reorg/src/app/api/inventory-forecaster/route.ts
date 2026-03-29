import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getInventoryForecasterBootstrap,
  runInventoryForecast,
  runInventoryForecastFromUpload,
} from "@/lib/inventory-forecast/service";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";

export const runtime = "nodejs";
export const maxDuration = 300;

const uploadedSaleSchema = z.object({
  sku: z.string().min(1),
  qty: z.number().int().min(1),
  platformQty: z.record(z.string(), z.number()),
});

const runSchema = z.object({
  lookbackDays: z.number().int().min(1).max(365),
  forecastBucket: z.enum(["DAILY", "WEEKLY"]),
  transitDays: z.number().int().min(0).max(365),
  desiredCoverageDays: z.number().int().min(0).max(730),
  useOpenInTransit: z.boolean().default(true),
  reorderRelevantOnly: z.boolean().default(true),
  mode: z.enum(["simple", "smart"]).default("smart"),
  uploadedSales: z.array(uploadedSaleSchema).optional(),
});

export async function GET() {
  try {
    const t0 = performance.now();
    const data = await getInventoryForecasterBootstrap();
    const body = { data };
    const bytesEstimate = Buffer.byteLength(JSON.stringify(body), "utf8");
    void recordNetworkTransferSample({
      channel: "FORECAST",
      label: "Inventory Forecaster — loaded page data (recent runs & supplier orders)",
      bytesEstimate,
      durationMs: Math.round(performance.now() - t0),
      metadata: {
        route: "GET /api/inventory-forecaster",
        recentRunCount: data.recentRuns?.length ?? 0,
      },
    });
    return NextResponse.json(body);
  } catch (error) {
    console.error("[inventory-forecaster] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load Inventory Forecaster" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = runSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const t0 = performance.now();
    const data = parsed.data.uploadedSales?.length
      ? await runInventoryForecastFromUpload({
          lookbackDays: parsed.data.lookbackDays,
          forecastBucket: parsed.data.forecastBucket,
          transitDays: parsed.data.transitDays,
          desiredCoverageDays: parsed.data.desiredCoverageDays,
          useOpenInTransit: parsed.data.useOpenInTransit,
          reorderRelevantOnly: parsed.data.reorderRelevantOnly,
          uploadedSales: parsed.data.uploadedSales,
        })
      : await runInventoryForecast(parsed.data);

    const responseBody = { data };
    const bytesEstimate = Buffer.byteLength(JSON.stringify(responseBody), "utf8");
    const uploadedCount = parsed.data.uploadedSales?.length ?? 0;
    void recordNetworkTransferSample({
      channel: "FORECAST",
      label: uploadedCount
        ? `Inventory forecast finished — uploaded sales (${uploadedCount} SKU rows, Simple mode)`
        : `Inventory forecast finished — ${parsed.data.mode === "simple" ? "Simple" : "Smart"} mode (${parsed.data.lookbackDays}-day lookback)`,
      bytesEstimate,
      durationMs: Math.round(performance.now() - t0),
      metadata: {
        route: "POST /api/inventory-forecaster",
        mode: uploadedCount ? "simple_upload" : parsed.data.mode,
        lookbackDays: parsed.data.lookbackDays,
        skuLinesReturned: data.lines.length,
        uploadedSalesRows: uploadedCount || undefined,
      },
    });

    return NextResponse.json(responseBody);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack?.slice(0, 800) : undefined;
    console.error("[inventory-forecaster] POST failed:", msg, stack, error);
    return NextResponse.json(
      { error: msg || "Failed to run inventory forecast", stack },
      { status: 500 },
    );
  }
}
