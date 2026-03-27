import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { forecastLineSchema } from "@/lib/inventory-forecast/schemas";
import { createSupplierOrderFromForecast } from "@/lib/inventory-forecast/service";

const createOrderSchema = z.object({
  forecastRunId: z.string().nullable().optional(),
  supplier: z.string().trim().max(200).nullable().optional(),
  eta: z.string().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  transitDays: z.number().int().min(0).max(365),
  lines: z.array(forecastLineSchema),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = createOrderSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const session = await auth();
    const order = await createSupplierOrderFromForecast({
      createdById: session?.user?.id ?? null,
      forecastRunId: parsed.data.forecastRunId ?? null,
      supplier: parsed.data.supplier ?? null,
      eta: parsed.data.eta ?? null,
      notes: parsed.data.notes ?? null,
      transitDays: parsed.data.transitDays,
      lines: parsed.data.lines,
    });

    return NextResponse.json({
      data: {
        id: order.id,
        status: order.status,
        eta: order.eta ? order.eta.toISOString() : null,
        supplier: order.supplier,
        notes: order.notes,
        lineCount: order.lines.length,
      },
    });
  } catch (error) {
    console.error("[inventory-forecaster/order] POST failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to create supplier order",
      },
      { status: 500 },
    );
  }
}
