import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireCatalogMutationAllowed } from "@/lib/catalog-permissions-server";

const editMasterSchema = z.object({
  sku: z.string(),
  field: z.enum(["supplierCost", "supplierShipping", "weight"]),
  value: z.union([z.number(), z.string(), z.null()]),
});

export async function PUT(request: NextRequest) {
  try {
    const access = await requireCatalogMutationAllowed();
    if (!access.allowed) return access.response;

    const body = await request.json();
    const parsed = editMasterSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { sku, field, value } = parsed.data;

    const master = await db.masterRow.findUnique({ where: { sku } });
    if (!master) {
      return NextResponse.json({ error: `Product not found: ${sku}` }, { status: 404 });
    }

    const oldValue = master[field];

    const updateData: Record<string, unknown> = {};
    if (field === "weight") {
      updateData.weight = value as string | null;
    } else {
      updateData[field] = value as number | null;
    }

    const updated = await db.masterRow.update({
      where: { sku },
      data: updateData,
    });

    await db.auditLog.create({
      data: {
        action: "edit_master",
        entityType: "MasterRow",
        entityId: master.id,
        details: { field, oldValue, newValue: value, sku },
      },
    });

    return NextResponse.json({
      data: {
        sku: updated.sku,
        field,
        oldValue,
        newValue: value,
      },
    });
  } catch (error) {
    console.error("[grid/edit] Failed to update master row", error);
    return NextResponse.json(
      { error: "Failed to update product" },
      { status: 500 }
    );
  }
}
