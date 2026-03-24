import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { forecastResultSchema } from "@/lib/inventory-forecast/schemas";
import { saveInventoryForecastRun } from "@/lib/inventory-forecast/service";

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

    const session = await auth();
    const saved = await saveInventoryForecastRun({
      createdById: session?.user?.id ?? null,
      result: parsed.data,
    });

    return NextResponse.json({
      data: {
        id: saved.id,
        createdAt: saved.createdAt.toISOString(),
        lineCount: saved.lines.length,
      },
    });
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
