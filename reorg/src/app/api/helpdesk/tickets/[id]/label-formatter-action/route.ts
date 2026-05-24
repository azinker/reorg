import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getActor } from "@/lib/impersonation";
import { appendOrUpdateLabelFormatterWorkingRow } from "@/lib/label-formatter/working-rows";
import type { LabelFormatterLineItem, LabelFormatterSourceStore } from "@/lib/label-formatter/types";
import { buildEbayConfig } from "@/lib/services/auto-responder-ebay";
import { getOrderContextCached } from "@/lib/services/helpdesk-order-context-cache";
import { adjustSkuVaultQuantity, type SkuVaultAdjustmentResult } from "@/lib/services/skuvault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const bodySchema = z.object({
  inr: z.boolean().default(false),
});

const LABEL_FORMATTER_ACTION = "HELPDESK_ORDER_TO_LABEL_FORMATTER";
const SKUVAULT_DEDUCTED_ACTION = "HELPDESK_ORDER_SKUVAULT_DEDUCTED_SKU";
const LEGACY_INR_SKUVAULT_DEDUCTED_ACTION = "HELPDESK_INR_SKUVAULT_DEDUCTED_SKU";

async function getActionStatus(ticketId: string) {
  const [labelLog, skuLogs] = await Promise.all([
    db.auditLog.findFirst({
      where: {
        action: LABEL_FORMATTER_ACTION,
        entityType: "HelpdeskTicket",
        entityId: ticketId,
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, details: true },
    }),
    db.auditLog.findMany({
      where: {
        action: { in: [SKUVAULT_DEDUCTED_ACTION, LEGACY_INR_SKUVAULT_DEDUCTED_ACTION] },
        entityType: "HelpdeskTicketSku",
        entityId: { startsWith: `${ticketId}:` },
      },
      orderBy: { createdAt: "asc" },
      select: { entityId: true, createdAt: true, details: true },
    }),
  ]);

  return {
    labelFormatter: {
      added: Boolean(labelLog),
      addedAt: labelLog?.createdAt.toISOString() ?? null,
      lastDetails: labelLog?.details ?? null,
    },
    skuvault: {
      deducted: skuLogs.length > 0,
      deductedAt: skuLogs.at(-1)?.createdAt.toISOString() ?? null,
      skuCount: skuLogs.length,
      rows: skuLogs.map((log) => ({
        sku: log.entityId?.split(":").slice(1).join(":") ?? "",
        deductedAt: log.createdAt.toISOString(),
        details: log.details,
      })),
    },
  };
}

function canUseHelpdeskOrderActions(actor: {
  email: string;
  helpdeskOrderActionsEnabled: boolean;
}) {
  return (
    actor.email.trim().toLowerCase() === "adam@theperfectpart.net" ||
    actor.helpdeskOrderActionsEnabled
  );
}

function sourceStoreForPlatform(platform: string): LabelFormatterSourceStore {
  if (platform === "TPP_EBAY") return "EBAY_TPP";
  if (platform === "TT_EBAY") return "EBAY_TT";
  return "MANUAL";
}

function mergeLineItems(lines: Array<{ sku: string | null; quantity: number }>): LabelFormatterLineItem[] {
  const bySku = new Map<string, number>();
  for (const line of lines) {
    const sku = line.sku?.trim();
    if (!sku) continue;
    const quantity = Number(line.quantity);
    bySku.set(sku, (bySku.get(sku) ?? 0) + (Number.isInteger(quantity) && quantity > 0 ? quantity : 1));
  }
  return [...bySku.entries()].map(([sku, quantity]) => ({ sku, quantity }));
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const actor = await getActor();
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (actor.isImpersonating) {
    return NextResponse.json(
      { error: "Return to your own account before running order actions." },
      { status: 403 },
    );
  }
  if (!canUseHelpdeskOrderActions(actor)) {
    return NextResponse.json(
      { error: "This Help Desk order action is not enabled for your user." },
      { status: 403 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid order action request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { id } = await params;
  const ticket = await db.helpdeskTicket.findUnique({
    where: { id },
    select: {
      id: true,
      ebayOrderNumber: true,
      channel: true,
      buyerName: true,
      buyerUserId: true,
      integration: {
        select: { id: true, label: true, platform: true, config: true },
      },
    },
  });
  if (!ticket) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }
  if (!ticket.ebayOrderNumber) {
    return NextResponse.json(
      { error: "This ticket is not linked to an order number." },
      { status: 400 },
    );
  }

  const platform = ticket.integration.platform;
  if (platform !== "TPP_EBAY" && platform !== "TT_EBAY") {
    return NextResponse.json(
      { error: "Help Desk order actions are currently supported for eBay orders only." },
      { status: 400 },
    );
  }

  const config = buildEbayConfig({ config: ticket.integration.config });
  const order = await getOrderContextCached(
    ticket.integration.id,
    config,
    ticket.ebayOrderNumber,
    { awaitFresh: true },
  );
  if (!order) {
    return NextResponse.json(
      { error: "Could not load the eBay order details needed for this action." },
      { status: 502 },
    );
  }

  const lineItems = mergeLineItems(order.lineItems);
  if (lineItems.length === 0) {
    return NextResponse.json(
      { error: "This order does not have SKU lines available to add or deduct." },
      { status: 400 },
    );
  }
  if (lineItems.some((line) => !line.sku.trim())) {
    return NextResponse.json(
      { error: "Every line needs a SKU before SkuVault can be deducted." },
      { status: 400 },
    );
  }

  const address = order.shippingAddress;
  const labelResult = await appendOrUpdateLabelFormatterWorkingRow(actor.userId, {
    note: parsed.data.inr ? "INR CASE" : "",
    orderNumber: order.orderId || ticket.ebayOrderNumber,
    sourceStore: sourceStoreForPlatform(platform),
    buyerName:
      address?.name?.trim() ||
      order.buyerName?.trim() ||
      ticket.buyerName?.trim() ||
      ticket.buyerUserId?.trim() ||
      "",
    addressLine1: address?.street1?.trim() ?? "",
    addressLine2: address?.street2?.trim() ?? "",
    city: address?.cityName?.trim() ?? "",
    state: address?.stateOrProvince?.trim() ?? "",
    zipCode: address?.postalCode?.trim() ?? "",
    lineItems,
  });

  let skuvault: SkuVaultAdjustmentResult[] = [];
  let skuvaultAlreadyDeducted = false;
  let skippedAlreadyDeducted = 0;
  for (const line of lineItems) {
    const deductionEntityId = `${ticket.id}:${line.sku}`;
    const priorLineDeduction = await db.auditLog.findFirst({
      where: {
        action: { in: [SKUVAULT_DEDUCTED_ACTION, LEGACY_INR_SKUVAULT_DEDUCTED_ACTION] },
        entityType: "HelpdeskTicketSku",
        entityId: deductionEntityId,
      },
      select: { id: true },
    });
    if (priorLineDeduction) {
      skippedAlreadyDeducted += 1;
      continue;
    }

    const result = await adjustSkuVaultQuantity({
      sku: line.sku,
      quantity: line.quantity,
      action: "remove",
    });
    skuvault.push(result);
    await db.auditLog.create({
      data: {
        userId: actor.userId,
        action: SKUVAULT_DEDUCTED_ACTION,
        entityType: "HelpdeskTicketSku",
        entityId: deductionEntityId,
        details: {
          orderNumber: ticket.ebayOrderNumber,
          ticketId: ticket.id,
          lineItem: line,
          inrNoteRequested: parsed.data.inr,
          result,
        },
      },
    });
  }
  skuvaultAlreadyDeducted = skippedAlreadyDeducted === lineItems.length;

  await db.auditLog.create({
    data: {
      userId: actor.userId,
      action: LABEL_FORMATTER_ACTION,
      entityType: "HelpdeskTicket",
      entityId: ticket.id,
      details: {
        orderNumber: ticket.ebayOrderNumber,
        labelFormatterRowId: labelResult.row.id,
        labelFormatterCreated: labelResult.created,
        totalLabelFormatterRows: labelResult.totalRows,
        inr: parsed.data.inr,
        skuvaultDeducted: skuvault.length > 0,
        skuvaultAlreadyDeducted,
      },
    },
  });

  return NextResponse.json({
    data: {
      orderNumber: ticket.ebayOrderNumber,
      labelFormatter: {
        rowId: labelResult.row.id,
        created: labelResult.created,
        totalRows: labelResult.totalRows,
        note: labelResult.row.note,
      },
      lineItems,
      skuvault: {
        deducted: skuvault,
        alreadyDeducted: skuvaultAlreadyDeducted,
      },
      status: await getActionStatus(ticket.id),
    },
  });
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const actor = await getActor();
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canUseHelpdeskOrderActions(actor)) {
    return NextResponse.json(
      { error: "This Help Desk order action is not enabled for your user." },
      { status: 403 },
    );
  }

  const { id } = await params;
  const ticket = await db.helpdeskTicket.findUnique({
    where: { id },
    select: { id: true, ebayOrderNumber: true },
  });
  if (!ticket) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }

  return NextResponse.json({
    data: {
      orderNumber: ticket.ebayOrderNumber,
      status: await getActionStatus(ticket.id),
    },
  });
}
