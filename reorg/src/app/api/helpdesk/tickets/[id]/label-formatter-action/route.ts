import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { canUseHelpdeskOrderActionsPermission } from "@/lib/helpdesk/order-actions-permission";
import { getActor } from "@/lib/impersonation";
import { appendOrUpdateLabelFormatterWorkingRow } from "@/lib/label-formatter/working-rows";
import type { LabelFormatterLineItem, LabelFormatterSourceStore } from "@/lib/label-formatter/types";
import { buildEbayConfig } from "@/lib/services/auto-responder-ebay";
import { getOrderContextCached } from "@/lib/services/helpdesk-order-context-cache";
import {
  adjustSkuVaultQuantity,
  getSkuVaultQuantity,
  InsufficientSkuVaultQuantityError,
  type SkuVaultAdjustmentResult,
} from "@/lib/services/skuvault";
import { resolveLabelFormatterActionNote } from "@/lib/helpdesk/label-formatter-action";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const bodySchema = z.object({
  inr: z.boolean().default(false),
  postageIssue: z.boolean().default(false),
});

const LABEL_FORMATTER_ACTION = "HELPDESK_ORDER_TO_LABEL_FORMATTER";
const SKUVAULT_DEDUCTED_ACTION = "HELPDESK_ORDER_SKUVAULT_DEDUCTED_SKU";
const LEGACY_INR_SKUVAULT_DEDUCTED_ACTION = "HELPDESK_INR_SKUVAULT_DEDUCTED_SKU";

async function getActionStatus(
  ticketId: string,
  options?: { orderNumber: string; sourceStore: LabelFormatterSourceStore },
) {
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
  const [workingRow, exportRow] = options
    ? await Promise.all([
        db.labelFormatterWorkingRow.findFirst({
          where: {
            orderNumber: options.orderNumber,
            sourceStore: options.sourceStore,
          },
          select: { id: true, createdAt: true, updatedAt: true },
        }),
        db.labelFormatterExportRow.findFirst({
          where: {
            orderNumber: options.orderNumber,
            sourceStore: options.sourceStore,
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, createdAt: true, batch: { select: { id: true, createdAt: true } } },
        }),
      ])
    : [null, null];

  return {
    labelFormatter: {
      added: Boolean(labelLog),
      addedAt: labelLog?.createdAt.toISOString() ?? null,
      lastDetails: labelLog?.details ?? null,
      currentWorkingRow: Boolean(workingRow),
      currentWorkingRowId: workingRow?.id ?? null,
      exported: Boolean(exportRow),
      exportedAt: exportRow?.batch.createdAt.toISOString() ?? null,
      exportBatchId: exportRow?.batch.id ?? null,
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
  return canUseHelpdeskOrderActionsPermission(actor);
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

function formatInsufficientSkuVaultMessage(
  shortages: Array<{ sku: string; requestedQuantity: number; availableQuantity: number }>,
) {
  const lines = shortages
    .map((item) => `${item.sku}: needs ${item.requestedQuantity}, only ${item.availableQuantity} left`)
    .join("; ");
  return `Cannot add this order to Label Formatter because SkuVault does not have enough inventory. ${lines}. No inventory was deducted and no Label Formatter row was added.`;
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

  const sourceStore = sourceStoreForPlatform(platform);
  const statusBeforeAction = await getActionStatus(ticket.id, {
    orderNumber: ticket.ebayOrderNumber,
    sourceStore,
  });
  let skuvault: SkuVaultAdjustmentResult[] = [];
  let skippedAlreadyDeducted = 0;
  const linesToDeduct: LabelFormatterLineItem[] = [];
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
    linesToDeduct.push(line);
  }
  const skuvaultAlreadyDeducted = skippedAlreadyDeducted === lineItems.length;

  const quantityChecks = await Promise.all(
    linesToDeduct.map(async (line) => ({
      line,
      current: await getSkuVaultQuantity(line.sku),
    })),
  );
  const shortages = quantityChecks
    .filter((check) => check.current.quantityOnHand < check.line.quantity)
    .map((check) => ({
      sku: check.line.sku,
      requestedQuantity: check.line.quantity,
      availableQuantity: check.current.quantityOnHand,
    }));
  if (shortages.length > 0) {
    return NextResponse.json(
      {
        error: formatInsufficientSkuVaultMessage(shortages),
        details: { shortages },
      },
      { status: 409 },
    );
  }
  const availableQuantityBySku = new Map(
    quantityChecks.map((check) => [check.line.sku, check.current.quantityOnHand]),
  );

  try {
    for (const line of linesToDeduct) {
      const currentQuantityOnHand = availableQuantityBySku.get(line.sku);
      if (currentQuantityOnHand === undefined) {
        throw new Error(`Missing SkuVault preflight quantity for ${line.sku}.`);
      }
      const result = await adjustSkuVaultQuantity({
        sku: line.sku,
        quantity: line.quantity,
        action: "remove",
      }, {
        currentQuantityOnHand,
        fetchUpdatedQuantity: false,
        skipRemoveQuantityCheck: true,
      });
      skuvault.push(result);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const deduction of [...skuvault].reverse()) {
      try {
        await adjustSkuVaultQuantity({
          sku: deduction.sku,
          quantity: deduction.quantityChanged,
          action: "add",
        }, {
          currentQuantityOnHand: deduction.quantityOnHand,
          fetchUpdatedQuantity: false,
        });
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error ? rollbackError.message : `Failed to roll back ${deduction.sku}`,
        );
      }
    }

    if (rollbackErrors.length > 0) {
      return NextResponse.json(
        {
          error: `SkuVault deduction failed and automatic rollback had errors. Check SkuVault before retrying. ${rollbackErrors.join("; ")}`,
        },
        { status: 502 },
      );
    }

    if (error instanceof InsufficientSkuVaultQuantityError) {
      return NextResponse.json(
        {
          error: formatInsufficientSkuVaultMessage([{
            sku: error.sku,
            requestedQuantity: error.requestedQuantity,
            availableQuantity: error.availableQuantity,
          }]),
          details: {
            shortages: [{
              sku: error.sku,
              requestedQuantity: error.requestedQuantity,
              availableQuantity: error.availableQuantity,
            }],
          },
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        error: "SkuVault deduction failed. No Label Formatter row was added.",
      },
      { status: 502 },
    );
  }

  for (const result of skuvault) {
    const line = lineItems.find((item) => item.sku === result.sku);
    if (!line) continue;
    const deductionEntityId = `${ticket.id}:${line.sku}`;
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
          postageIssueNoteRequested: parsed.data.postageIssue,
          result,
        },
      },
    });
  }

  const address = order.shippingAddress;
  const labelResult = await appendOrUpdateLabelFormatterWorkingRow(actor.userId, {
    note: resolveLabelFormatterActionNote({
      inr: parsed.data.inr,
      postageIssue: parsed.data.postageIssue,
    }),
    orderNumber: order.orderId || ticket.ebayOrderNumber,
    sourceStore,
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
        postageIssue: parsed.data.postageIssue,
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
        previouslyAdded: statusBeforeAction.labelFormatter.added,
        totalRows: labelResult.totalRows,
        note: labelResult.row.note,
      },
      lineItems,
      skuvault: {
        deducted: skuvault,
        alreadyDeducted: skuvaultAlreadyDeducted,
      },
      status: await getActionStatus(ticket.id, {
        orderNumber: ticket.ebayOrderNumber,
        sourceStore,
      }),
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
    select: { id: true, ebayOrderNumber: true, integration: { select: { platform: true } } },
  });
  if (!ticket) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }

  const sourceStore = ticket.ebayOrderNumber
    ? sourceStoreForPlatform(ticket.integration.platform)
    : "MANUAL";
  return NextResponse.json({
    data: {
      orderNumber: ticket.ebayOrderNumber,
      status: ticket.ebayOrderNumber
        ? await getActionStatus(ticket.id, {
            orderNumber: ticket.ebayOrderNumber,
            sourceStore,
          })
        : await getActionStatus(ticket.id),
    },
  });
}
