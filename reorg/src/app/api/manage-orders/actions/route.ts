import { XMLParser } from "fast-xml-parser";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { buildEbayConfig, getEbayAccessToken } from "@/lib/services/auto-responder-ebay";
import { assertCanPerformLiveEbayOrderMutation } from "@/lib/manage-orders/safety";
import type { EbayStore, ManageOrderActionType } from "@/lib/manage-orders/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });

const schema = z.object({
  actionType: z.enum(["add_tracking", "mark_shipped", "cancel_order", "message_buyer"]),
  store: z.enum(["TPP_EBAY", "TT_EBAY"]),
  orderId: z.string().min(1),
  humanActionToken: z.string().min(1),
  trackingNumbers: z.array(z.object({
    carrier: z.enum(["USPS", "UPS", "FedEx"]),
    trackingNumber: z.string().min(4),
  })).optional(),
  cancelReason: z.string().optional(),
  messageBody: z.string().optional(),
  sendAutoResponder: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  const json = await request.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid action request", details: parsed.error.flatten() }, { status: 400 });
  }

  const input = parsed.data;
  const guard = await assertCanPerformLiveEbayOrderMutation({
    user: session?.user ? { id: session.user.id, role: session.user.role } : null,
    actionType: input.actionType,
    orderId: input.orderId,
    store: input.store,
    humanActionToken: input.humanActionToken,
    requestHeaders: request.headers,
  });
  if (!guard.allowed) {
    return NextResponse.json({ error: guard.message }, { status: guard.message === "Unauthorized." ? 401 : 403 });
  }

  try {
    if (input.actionType === "add_tracking") {
      if (!input.trackingNumbers?.length) {
        return NextResponse.json({ error: "At least one tracking number is required." }, { status: 400 });
      }
      const result = await completeSale(input.store, input.orderId, input.trackingNumbers, true);
      await auditAction(session!.user.id, input.actionType, input.store, input.orderId, true, {
        trackingNumbers: input.trackingNumbers,
        sendAutoResponderRequested: input.sendAutoResponder === true,
        autoResponderTriggered: false,
        marketplaceAck: result.ack,
      });
      return NextResponse.json({
        data: {
          success: true,
          message: input.sendAutoResponder
            ? "Tracking was added. Auto-responder was not triggered from Manage Orders yet."
            : "Tracking was added and the order was marked shipped.",
        },
      });
    }

    if (input.actionType === "mark_shipped") {
      const result = await completeSale(input.store, input.orderId, [], true);
      await auditAction(session!.user.id, input.actionType, input.store, input.orderId, true, {
        sendAutoResponderRequested: input.sendAutoResponder === true,
        autoResponderTriggered: false,
        marketplaceAck: result.ack,
      });
      return NextResponse.json({
        data: { success: true, message: "Order was marked shipped." },
      });
    }

    await auditAction(session!.user.id, input.actionType, input.store, input.orderId, false, {
      reason: "not_wired_to_live_ebay",
    });
    return NextResponse.json(
      {
        error:
          input.actionType === "cancel_order"
            ? "Cancel Order is protected but not wired to live eBay cancellation yet."
            : "Message Buyer is protected but must be sent through the existing Help Desk workflow.",
      },
      { status: 501 },
    );
  } catch (error) {
    await auditAction(session!.user.id, input.actionType, input.store, input.orderId, false, {
      error: error instanceof Error ? error.message : String(error),
    });
    console.error("[manage-orders/actions] failed", error);
    return NextResponse.json({ error: "eBay did not accept the order action." }, { status: 502 });
  }
}

async function completeSale(
  store: EbayStore,
  orderId: string,
  trackingNumbers: Array<{ carrier: string; trackingNumber: string }>,
  shipped: boolean,
) {
  const integration = await db.integration.findUnique({ where: { platform: store } });
  if (!integration) throw new Error(`Integration not found for ${store}`);
  const accessToken = await getEbayAccessToken(integration.id, buildEbayConfig(integration));
  const trackingXml = trackingNumbers
    .map((tracking) => `
    <ShipmentTrackingDetails>
      <ShippingCarrierUsed>${escapeXml(tracking.carrier)}</ShippingCarrierUsed>
      <ShipmentTrackingNumber>${escapeXml(tracking.trackingNumber)}</ShipmentTrackingNumber>
    </ShipmentTrackingDetails>`)
    .join("");
  const shipmentXml = trackingXml ? `<Shipment>${trackingXml}\n  </Shipment>` : "";
  const body = `<?xml version="1.0" encoding="utf-8"?>
<CompleteSaleRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderID>${escapeXml(orderId)}</OrderID>
  <Shipped>${shipped ? "true" : "false"}</Shipped>
  ${shipmentXml}
</CompleteSaleRequest>`;
  const response = await fetch(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": accessToken,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-CALL-NAME": "CompleteSale",
      "Content-Type": "text/xml",
    },
    body,
  });
  const xml = await response.text();
  if (!response.ok) throw new Error(`CompleteSale HTTP ${response.status}`);
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const root = parsed.CompleteSaleResponse as Record<string, unknown> | undefined;
  const ack = root?.Ack ? String(root.Ack) : "Unknown";
  if (ack !== "Success" && ack !== "Warning") {
    throw new Error(`CompleteSale ${ack}`);
  }
  return { ack };
}

async function auditAction(
  userId: string,
  actionType: ManageOrderActionType,
  store: EbayStore,
  orderId: string,
  success: boolean,
  details: Record<string, unknown>,
) {
  await db.auditLog.create({
    data: {
      userId,
      action: success ? "manage_orders_ebay_action" : "manage_orders_ebay_action_failed",
      entityType: "ebay_order",
      entityId: orderId,
      details: { feature: "manage_orders", actionType, store, ...details },
    },
  });
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
