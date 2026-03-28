import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getInventoryForecasterBootstrap,
  runInventoryForecast,
  runInventoryForecastFromUpload,
} from "@/lib/inventory-forecast/service";

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
    const data = await getInventoryForecasterBootstrap();
    return NextResponse.json({ data });
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

    return NextResponse.json({ data });
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
