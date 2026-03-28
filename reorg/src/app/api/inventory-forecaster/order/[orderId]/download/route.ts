import { NextResponse, type NextRequest } from "next/server";
import { getSupplierOrderForDownload } from "@/lib/inventory-forecast/service";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ orderId: string }> },
) {
  try {
    const { orderId } = await context.params;
    const order = await getSupplierOrderForDownload(orderId);

    const totalUnits = order.lines.reduce((t, l) => t + l.finalQty, 0);
    const hasAnyCost = order.lines.some((l) => l.supplierCost != null);
    const totalCost = hasAnyCost
      ? order.lines.reduce((t, l) => t + l.finalQty * (l.supplierCost ?? 0), 0)
      : null;

    return NextResponse.json({
      data: {
        id: order.id,
        orderName: order.orderName,
        supplier: order.supplier,
        status: order.status,
        eta: order.eta.toISOString(),
        notes: order.notes,
        createdAt: order.createdAt.toISOString(),
        totalUnits,
        totalCost,
        lines: order.lines.map((l) => ({
          sku: l.sku,
          title: l.title,
          supplierCost: l.supplierCost,
          qty: l.finalQty,
          lineCost: l.supplierCost != null ? l.finalQty * l.supplierCost : null,
        })),
      },
    });
  } catch (error) {
    console.error("[inventory-forecaster/order/:orderId/download] GET failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load order" },
      { status: 500 },
    );
  }
}
