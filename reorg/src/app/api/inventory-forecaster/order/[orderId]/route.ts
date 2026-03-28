import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { deleteSupplierOrder, patchSupplierOrder } from "@/lib/inventory-forecast/service";

const patchSchema = z.object({
  status: z.enum(["DRAFT", "ORDERED", "IN_TRANSIT", "RECEIVED", "CANCELLED"]).optional(),
  eta: z.string().nullable().optional(),
  orderName: z.string().trim().max(200).nullable().optional(),
  supplier: z.string().trim().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ orderId: string }> },
) {
  try {
    const { orderId } = await context.params;
    const body = await request.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const order = await patchSupplierOrder({
      orderId,
      ...parsed.data,
    });

    return NextResponse.json({
      data: {
        id: order.id,
        status: order.status,
        eta: order.eta ? order.eta.toISOString() : null,
        orderName: order.orderName,
        supplier: order.supplier,
        notes: order.notes,
      },
    });
  } catch (error) {
    console.error("[inventory-forecaster/order/:orderId] PATCH failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update supplier order",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ orderId: string }> },
) {
  try {
    const { orderId } = await context.params;
    await deleteSupplierOrder(orderId);
    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    console.error("[inventory-forecaster/order/:orderId] DELETE failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete supplier order",
      },
      { status: 500 },
    );
  }
}
