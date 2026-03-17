import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const updateRateSchema = z.object({
  rates: z.array(
    z.object({
      weightKey: z.string(),
      cost: z.number().nullable(),
    })
  ),
});

export async function GET() {
  try {
    const rates = await db.shippingRate.findMany({
      orderBy: { sortOrder: "asc" },
    });

    return NextResponse.json({
      data: rates.map((r) => ({
        weightKey: r.weightKey,
        weightOz: r.weightOz,
        cost: r.cost,
        sortOrder: r.sortOrder,
      })),
    });
  } catch (error) {
    console.error("[shipping-rates] Failed to fetch rates", error);
    return NextResponse.json(
      { error: "Failed to fetch shipping rates" },
      { status: 500 }
    );
  }
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

    const updates = parsed.data.rates;

    for (const rate of updates) {
      const normalized = rate.weightKey.trim().toUpperCase();
      let weightOz: number;
      if (normalized.endsWith("LBS")) {
        weightOz = parseFloat(normalized.replace("LBS", "")) * 16;
      } else {
        weightOz = parseFloat(normalized) || 0;
      }

      await db.shippingRate.upsert({
        where: { weightKey: rate.weightKey },
        create: { weightKey: rate.weightKey, weightOz, cost: rate.cost },
        update: { cost: rate.cost },
      });
    }

    return NextResponse.json({
      data: { updated: updates.length },
    });
  } catch (error) {
    console.error("[shipping-rates] Failed to update rates", error);
    return NextResponse.json(
      { error: "Failed to update shipping rates" },
      { status: 500 }
    );
  }
}
