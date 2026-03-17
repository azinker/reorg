import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const bodySchema = z.object({
  unmatchedId: z.string().min(1),
  masterSku: z.string().min(1).max(200),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { unmatchedId, masterSku } = parsed.data;

    const unmatched = await db.unmatchedListing.findUnique({
      where: { id: unmatchedId },
      include: { integration: true },
    });

    if (!unmatched) {
      return NextResponse.json({ error: "Unmatched listing not found" }, { status: 404 });
    }

    let master = await db.masterRow.findUnique({
      where: { sku: masterSku },
    });

    if (!master) {
      master = await db.masterRow.create({
        data: {
          sku: masterSku,
          title: unmatched.title ?? undefined,
        },
      });
    }

    const raw = (unmatched.rawData as Record<string, unknown>) ?? {};
    const salePrice = typeof raw.salePrice === "number" ? raw.salePrice : null;
    const adRate = typeof raw.adRate === "number" ? raw.adRate : null;
    const imageUrl = typeof raw.imageUrl === "string" ? raw.imageUrl : null;
    const inventory = typeof raw.inventory === "number" ? raw.inventory : null;

    const platformVariantId = "";
    await db.marketplaceListing.upsert({
      where: {
        integrationId_platformItemId_platformVariantId: {
          integrationId: unmatched.integrationId,
          platformItemId: unmatched.platformItemId,
          platformVariantId,
        },
      },
      create: {
        masterRowId: master.id,
        integrationId: unmatched.integrationId,
        platformItemId: unmatched.platformItemId,
        platformVariantId,
        sku: master.sku,
        title: unmatched.title,
        imageUrl,
        salePrice,
        adRate,
        inventory,
        rawData: unmatched.rawData,
        lastSyncedAt: new Date(),
      },
      update: {
        masterRowId: master.id,
        sku: master.sku,
        title: unmatched.title ?? undefined,
        imageUrl: imageUrl ?? undefined,
        salePrice: salePrice ?? undefined,
        adRate: adRate ?? undefined,
        inventory: inventory ?? undefined,
        rawData: unmatched.rawData,
        lastSyncedAt: new Date(),
      },
    });

    await db.unmatchedListing.delete({
      where: { id: unmatchedId },
    });

    return NextResponse.json({
      data: { ok: true, masterSku: master.sku, masterRowId: master.id },
    });
  } catch (error) {
    console.error("[unmatched/link] Failed", error);
    return NextResponse.json(
      { error: "Failed to link listing" },
      { status: 500 }
    );
  }
}
