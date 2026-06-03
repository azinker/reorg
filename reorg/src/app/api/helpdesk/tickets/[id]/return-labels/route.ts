import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { canUseHelpdeskOrderActionsPermission } from "@/lib/helpdesk/order-actions-permission";
import { getActor } from "@/lib/impersonation";
import {
  createLabelCrowLabel,
  type LabelCrowAddress,
} from "@/lib/services/labelcrow";
import { buildEbayConfig } from "@/lib/services/auto-responder-ebay";
import { getOrderContextCached } from "@/lib/services/helpdesk-order-context-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const bodySchema = z.object({
  force: z.boolean().default(false),
});

const RETURN_LABEL_GENERATED_ACTION = "HELPDESK_RETURN_LABEL_GENERATED";

function canUseReturnLabels(actor: {
  email?: string | null;
  helpdeskOrderActionsEnabled?: boolean | null;
}) {
  return canUseHelpdeskOrderActionsPermission(actor);
}

function clientLabel(ticketId: string, label: {
  id: string;
  orderNumber: string;
  trackingNumber: string;
  carrier: string;
  serviceClass: string;
  providerKey: string;
  seriesCode: string;
  weightLbs: number;
  createdAt: Date;
}) {
  const base = `/api/helpdesk/tickets/${ticketId}/return-labels/${label.id}/download`;
  return {
    id: label.id,
    orderNumber: label.orderNumber,
    trackingNumber: label.trackingNumber,
    carrier: label.carrier,
    serviceClass: label.serviceClass,
    providerKey: label.providerKey,
    seriesCode: label.seriesCode,
    weightLbs: label.weightLbs,
    createdAt: label.createdAt.toISOString(),
    openUrl: base,
    downloadUrl: `${base}?download=1`,
  };
}

async function listLabels(ticketId: string) {
  const rows = await db.helpdeskReturnLabel.findMany({
    where: { ticketId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      orderNumber: true,
      trackingNumber: true,
      carrier: true,
      serviceClass: true,
      providerKey: true,
      seriesCode: true,
      weightLbs: true,
      createdAt: true,
    },
  });
  return rows.map((row) => clientLabel(ticketId, row));
}

function requiredAddressPart(value: string | null | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`The buyer shipping address is missing ${label}.`);
  return trimmed;
}

function destinationForPlatform(platform: string): LabelCrowAddress {
  const name = platform === "TT_EBAY" ? "TT RETURNS" : "TPP RETURNS";
  return {
    name,
    address: "1407 SW 10TH AVE",
    city: "POMPANO BEACH",
    state: "FL",
    zip: "33069",
  };
}

function buildReturnFromAddress(orderNumber: string, address: {
  street1: string | null;
  street2: string | null;
  cityName: string | null;
  stateOrProvince: string | null;
  postalCode: string | null;
} | null): LabelCrowAddress {
  if (!address) throw new Error("The eBay order does not include a buyer shipping address.");
  return {
    name: orderNumber,
    address: requiredAddressPart(address.street1, "street address"),
    address2: address.street2?.trim() || "",
    city: requiredAddressPart(address.cityName, "city"),
    state: requiredAddressPart(address.stateOrProvince, "state"),
    zip: requiredAddressPart(address.postalCode, "ZIP code"),
  };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const actor = await getActor();
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canUseReturnLabels(actor)) {
    return NextResponse.json(
      { error: "Return label generation is not enabled for your user." },
      { status: 403 },
    );
  }

  const { id } = await params;
  return NextResponse.json({ data: { labels: await listLabels(id) } });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const actor = await getActor();
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (actor.isImpersonating) {
    return NextResponse.json(
      { error: "Return to your own account before generating a return label." },
      { status: 403 },
    );
  }
  if (!canUseReturnLabels(actor)) {
    return NextResponse.json(
      { error: "Return label generation is not enabled for your user." },
      { status: 403 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid return label request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { id } = await params;
  const existingLabels = await listLabels(id);
  if (existingLabels.length > 0 && !parsed.data.force) {
    return NextResponse.json(
      {
        error: "A return label was already generated for this ticket.",
        code: "ALREADY_GENERATED",
        data: { labels: existingLabels },
      },
      { status: 409 },
    );
  }

  const ticket = await db.helpdeskTicket.findUnique({
    where: { id },
    select: {
      id: true,
      ebayOrderNumber: true,
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
      { error: "This ticket is not linked to an eBay order number." },
      { status: 400 },
    );
  }

  const platform = ticket.integration.platform;
  if (platform !== "TPP_EBAY" && platform !== "TT_EBAY") {
    return NextResponse.json(
      { error: "Return labels are currently supported for TPP and TT eBay orders only." },
      { status: 400 },
    );
  }

  try {
    const config = buildEbayConfig({ config: ticket.integration.config });
    const order = await getOrderContextCached(
      ticket.integration.id,
      config,
      ticket.ebayOrderNumber,
      { awaitFresh: true },
    );
    if (!order) {
      return NextResponse.json(
        { error: "Could not load the eBay order details needed for this return label." },
        { status: 502 },
      );
    }

    const orderNumber = order.orderId || ticket.ebayOrderNumber;
    const fromAddress = buildReturnFromAddress(orderNumber, order.shippingAddress);
    const toAddress = destinationForPlatform(platform);
    const label = await createLabelCrowLabel({
      from: fromAddress,
      to: toAddress,
      orderNumber,
      carrier: "usps",
      serviceClass: "ground",
      providerKey: "api",
      seriesCode: "9302",
      weightLbs: 2,
    });

    const created = await db.helpdeskReturnLabel.create({
      data: {
        ticketId: ticket.id,
        createdByUserId: actor.realUserId,
        orderNumber,
        labelCrowId: label.labelCrowId,
        labelCrowDownloadUrl: label.downloadUrl,
        trackingNumber: label.trackingNumber,
        carrier: "USPS",
        serviceClass: "Ground",
        providerKey: "api",
        seriesCode: "9302",
        seriesId: process.env.LABELCROW_USPS_GROUND_SERIES_ID?.trim() || "13",
        weightLbs: 2,
        fromAddress,
        toAddress,
        pdfBytes: label.pdfBytes ? Uint8Array.from(label.pdfBytes) : undefined,
        rawResponse: (label.rawResponse ?? {}) as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        orderNumber: true,
        trackingNumber: true,
        carrier: true,
        serviceClass: true,
        providerKey: true,
        seriesCode: true,
        weightLbs: true,
        createdAt: true,
      },
    });

    await db.auditLog.create({
      data: {
        userId: actor.realUserId,
        action: RETURN_LABEL_GENERATED_ACTION,
        entityType: "HelpdeskTicket",
        entityId: ticket.id,
        details: {
          orderNumber,
          platform,
          labelCrowId: label.labelCrowId,
          trackingNumber: label.trackingNumber,
          carrier: "USPS",
          serviceClass: "Ground",
          providerKey: "api",
          seriesCode: "9302",
          weightLbs: 2,
          duplicateGeneration: existingLabels.length > 0,
        },
      },
    });

    const labels = await listLabels(ticket.id);
    return NextResponse.json({
      data: {
        label: clientLabel(ticket.id, created),
        labels,
      },
    });
  } catch (err) {
    console.error("[helpdesk/return-labels] generation failed", {
      ticketId: id,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Return label generation failed.",
      },
      { status: 502 },
    );
  }
}
