import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

const updateRateSchema = z.object({
  rates: z.array(
    z.object({
      weightKey: z.string(),
      cost: z.number().nullable(),
    })
  ),
});

export async function GET() {
  // TODO: Wire to real DB when connected
  // Returns all shipping rates from the ShippingRate table

  const defaultRates = [
    ...Array.from({ length: 16 }, (_, i) => ({
      weightKey: `${i + 1}oz`,
      weightOz: i + 1,
      cost: null,
      sortOrder: i,
    })),
    ...Array.from({ length: 9 }, (_, i) => ({
      weightKey: `${i + 2}LBS`,
      weightOz: (i + 2) * 16,
      cost: null,
      sortOrder: 16 + i,
    })),
  ];

  return NextResponse.json({ data: defaultRates });
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = updateRateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // TODO: Wire to real DB when connected
    return NextResponse.json({
      data: { updated: parsed.data.rates.length },
    });
  } catch (error) {
    console.error("[shipping-rates] Failed to update rates", error);
    return NextResponse.json(
      { error: "Failed to update shipping rates" },
      { status: 500 }
    );
  }
}
