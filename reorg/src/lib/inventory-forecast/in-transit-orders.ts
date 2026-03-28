import { addDays, startOfDay } from "date-fns";
import { db } from "@/lib/db";
import type {
  CreateSupplierOrderInput,
  OpenInboundSummary,
  SupplierOrderSummary,
} from "@/lib/inventory-forecast/types";

const OPEN_INBOUND_STATUSES = ["ORDERED", "IN_TRANSIT"] as const;

export async function getOpenInboundByMasterRowId(
  masterRowIds: string[],
  arrivalDate: Date,
) {
  if (masterRowIds.length === 0) return new Map<string, OpenInboundSummary>();

  const rows = await db.supplierOrderLine.findMany({
    where: {
      masterRowId: { in: masterRowIds },
      supplierOrder: {
        status: { in: [...OPEN_INBOUND_STATUSES] },
        eta: { lte: arrivalDate },
      },
    },
    select: {
      masterRowId: true,
      finalQty: true,
      supplierOrder: {
        select: {
          id: true,
          eta: true,
        },
      },
    },
    orderBy: [
      { supplierOrder: { eta: "asc" } },
      { createdAt: "asc" },
    ],
  });

  const grouped = new Map<string, OpenInboundSummary>();
  for (const row of rows) {
    const current = grouped.get(row.masterRowId) ?? {
      totalQty: 0,
      earliestEta: null,
      orderIds: [],
    };
    current.totalQty += row.finalQty;
    current.earliestEta ??= row.supplierOrder.eta.toISOString();
    if (!current.orderIds.includes(row.supplierOrder.id)) {
      current.orderIds.push(row.supplierOrder.id);
    }
    grouped.set(row.masterRowId, current);
  }

  return grouped;
}

export async function createSupplierOrderRecord(input: CreateSupplierOrderInput) {
  const order = await db.supplierOrder.create({
    data: {
      createdById: input.createdById ?? null,
      forecastRunId: input.forecastRunId ?? null,
      orderName: input.orderName ?? null,
      supplier: input.supplier ?? null,
      status: input.status ?? "DRAFT",
      eta: input.eta,
      notes: input.notes ?? null,
      lines: {
        create: input.lines.map((line) => ({
          masterRowId: line.masterRowId,
          title: line.title,
          sku: line.sku,
          supplierCost: line.supplierCost ?? null,
          systemRecommendedQty: line.systemRecommendedQty,
          overrideQty: line.overrideQty,
          finalQty: line.finalQty,
        })),
      },
    },
    include: {
      lines: true,
    },
  });

  await db.auditLog.create({
    data: {
      action: "supplier_order_created",
      entityType: "supplier_order",
      entityId: order.id,
      details: {
        status: order.status,
        eta: order.eta.toISOString(),
        lineCount: order.lines.length,
      },
    },
  });

  return order;
}

export async function updateSupplierOrderRecord(input: {
  orderId: string;
  status?: "DRAFT" | "ORDERED" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED";
  eta?: Date;
  orderName?: string | null;
  supplier?: string | null;
  notes?: string | null;
}) {
  const existing = await db.supplierOrder.findUnique({
    where: { id: input.orderId },
    select: { status: true },
  });

  if (!existing) {
    throw new Error(`Supplier order ${input.orderId} not found.`);
  }

  if (input.eta && !["DRAFT", "ORDERED", "IN_TRANSIT"].includes(existing.status)) {
    throw new Error("ETA can only be edited while the order is Draft, Ordered, or In Transit.");
  }

  const updated = await db.supplierOrder.update({
    where: { id: input.orderId },
    data: {
      status: input.status,
      eta: input.eta,
      orderName: input.orderName === undefined ? undefined : input.orderName,
      supplier: input.supplier === undefined ? undefined : input.supplier,
      notes: input.notes === undefined ? undefined : input.notes,
    },
    include: {
      lines: true,
    },
  });

  await db.auditLog.create({
    data: {
      action: "supplier_order_updated",
      entityType: "supplier_order",
      entityId: updated.id,
      details: {
        status: updated.status,
        eta: updated.eta.toISOString(),
      },
    },
  });

  return updated;
}

export async function deleteSupplierOrderRecord(orderId: string) {
  const existing = await db.supplierOrder.findUnique({
    where: { id: orderId },
    select: { id: true, status: true },
  });
  if (!existing) throw new Error(`Supplier order ${orderId} not found.`);

  await db.supplierOrderLine.deleteMany({ where: { supplierOrderId: orderId } });
  await db.supplierOrder.delete({ where: { id: orderId } });

  await db.auditLog.create({
    data: {
      action: "supplier_order_deleted",
      entityType: "supplier_order",
      entityId: orderId,
      details: { previousStatus: existing.status },
    },
  });
}

export async function listRecentSupplierOrders(limit = 12): Promise<SupplierOrderSummary[]> {
  const orders = await db.supplierOrder.findMany({
    take: limit,
    orderBy: { createdAt: "desc" },
    include: {
      lines: {
        select: {
          finalQty: true,
          supplierCost: true,
        },
      },
    },
  });

  return orders.map((order) => {
    const totalUnits = order.lines.reduce((t, l) => t + l.finalQty, 0);
    const hasAnyCost = order.lines.some((l) => l.supplierCost != null);
    const totalCost = hasAnyCost
      ? order.lines.reduce((t, l) => t + l.finalQty * (l.supplierCost ?? 0), 0)
      : null;
    return {
      id: order.id,
      orderName: order.orderName,
      supplier: order.supplier,
      status: order.status,
      eta: order.eta.toISOString(),
      forecastRunId: order.forecastRunId,
      notes: order.notes,
      lineCount: order.lines.length,
      totalUnits,
      totalCost,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };
  });
}

export async function getSupplierOrderWithLines(orderId: string) {
  const order = await db.supplierOrder.findUnique({
    where: { id: orderId },
    include: {
      lines: {
        select: {
          sku: true,
          title: true,
          supplierCost: true,
          finalQty: true,
        },
        orderBy: { title: "asc" },
      },
    },
  });
  if (!order) throw new Error(`Order ${orderId} not found.`);
  return order;
}

export function defaultEtaFromTransitDays(transitDays: number, runDate = new Date()) {
  return startOfDay(addDays(runDate, transitDays));
}
