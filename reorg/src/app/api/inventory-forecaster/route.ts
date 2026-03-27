import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getInventoryForecasterBootstrap,
  runInventoryForecast,
} from "@/lib/inventory-forecast/service";

export const maxDuration = 300;

const runSchema = z.object({
  lookbackDays: z.number().int().min(1).max(365),
  forecastBucket: z.enum(["DAILY", "WEEKLY"]),
  transitDays: z.number().int().min(0).max(365),
  desiredCoverageDays: z.number().int().min(0).max(730),
  useOpenInTransit: z.boolean().default(true),
  reorderRelevantOnly: z.boolean().default(true),
  mode: z.enum(["simple", "smart"]).default("smart"),
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

    const data = await runInventoryForecast(parsed.data);
    return NextResponse.json({ data });
  } catch (error) {
    console.error("[inventory-forecaster] POST failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to run inventory forecast",
      },
      { status: 500 },
    );
  }
}
