import { Prisma } from "@prisma/client";
import { XMLParser } from "fast-xml-parser";
import { db } from "@/lib/db";
import { getManageOrderDetail } from "@/lib/manage-orders/ebay";
import type { EbayStore, ManageOrder } from "@/lib/manage-orders/types";
import { checkWriteSafety } from "@/lib/safety";
import { buildEbayConfig, getEbayAccessToken } from "@/lib/services/auto-responder-ebay";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const EBAY_STORES: EbayStore[] = ["TPP_EBAY", "TT_EBAY"];

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });

export type EbayTrackingCarrier = "USPS" | "UPS" | "FedEx";

export type EbayTrackingPayloadRow = {
  carrier: EbayTrackingCarrier;
  trackingNumber: string;
};

export type EbayTrackingAdditionInput = {
  sourceRow: number;
  orderId: string;
  trackingNumber: string;
  storeHint?: EbayStore | null;
  reshipRowId?: string | null;
  preflightBlockers?: string[];
};

export type EbayTrackingPlanRow = EbayTrackingAdditionInput & {
  status: "ready" | "blocked";
  store: EbayStore | null;
  apiOrderId: string | null;
  existingTracking: ManageOrder["trackingNumbers"];
  trackingPayload: EbayTrackingPayloadRow[];
  blockers: string[];
};

export type EbayTrackingPlanSummary = {
  inputRows: number;
  readyCount: number;
  blockedCount: number;
  storeCounts: Record<EbayStore, number>;
};

export type EbayTrackingExecutionRow = {
  sourceRow: number;
  reshipRowId?: string | null;
  orderId: string;
  trackingNumber: string;
  store: EbayStore | null;
  success: boolean;
  marketplaceAck?: string;
  marketplaceWarnings?: EbayApiMessage[];
  verifiedTracking?: ManageOrder["trackingNumbers"];
  verificationStatus?: "verified" | "unverified";
  error?: string;
};

export type EbayTrackingExecutionResult = {
  generatedAt: string;
  attemptedCount: number;
  successCount: number;
  failureCount: number;
  verifiedCount: number;
  unverifiedCount: number;
  storeCounts: Record<EbayStore, number>;
  results: EbayTrackingExecutionRow[];
};

type EbayApiMessage = {
  severity: string | null;
  code: string | null;
  shortMessage: string | null;
  longMessage: string | null;
};

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function normalizeTracking(value: string | null | undefined) {
  return (value ?? "").replace(/[\s-]+/g, "").toUpperCase();
}

function normalizeCarrier(value: string | null | undefined): EbayTrackingCarrier {
  if (value === "UPS" || value === "FedEx") return value;
  return "USPS";
}

function extractMessages(root: Record<string, unknown> | undefined) {
  const errors = asArray(root?.Errors as Record<string, unknown> | Record<string, unknown>[] | undefined);
  return errors.map((error) => ({
    severity: typeof error.SeverityCode === "string" ? error.SeverityCode : null,
    code: typeof error.ErrorCode === "string" ? error.ErrorCode : null,
    shortMessage: typeof error.ShortMessage === "string" ? error.ShortMessage : null,
    longMessage: typeof error.LongMessage === "string" ? error.LongMessage : null,
  }));
}

function summarizePlan(plan: EbayTrackingPlanRow[]): EbayTrackingPlanSummary {
  const ready = plan.filter((row) => row.status === "ready");
  return {
    inputRows: plan.length,
    readyCount: ready.length,
    blockedCount: plan.length - ready.length,
    storeCounts: {
      TPP_EBAY: ready.filter((row) => row.store === "TPP_EBAY").length,
      TT_EBAY: ready.filter((row) => row.store === "TT_EBAY").length,
    },
  };
}

async function completeSaleWithTracking(
  store: EbayStore,
  apiOrderId: string,
  trackingRows: EbayTrackingPayloadRow[],
) {
  const integration = await db.integration.findUnique({ where: { platform: store } });
  if (!integration) throw new Error(`Integration not found for ${store}`);

  const accessToken = await getEbayAccessToken(integration.id, buildEbayConfig(integration));
  const trackingXml = trackingRows
    .map((tracking) => `    <ShipmentTrackingDetails>
      <ShippingCarrierUsed>${escapeXml(tracking.carrier)}</ShippingCarrierUsed>
      <ShipmentTrackingNumber>${escapeXml(tracking.trackingNumber)}</ShipmentTrackingNumber>
    </ShipmentTrackingDetails>`)
    .join("\n");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<CompleteSaleRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderID>${escapeXml(apiOrderId)}</OrderID>
  <Shipped>true</Shipped>
  <Shipment>
${trackingXml}
  </Shipment>
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
  if (!response.ok) throw new Error(`CompleteSale HTTP ${response.status}: ${xml.slice(0, 300)}`);

  const parsed = parser.parse(xml) as Record<string, unknown>;
  const root = parsed.CompleteSaleResponse as Record<string, unknown> | undefined;
  const ack = root?.Ack ? String(root.Ack) : "Unknown";
  if (ack !== "Success" && ack !== "Warning") {
    throw new Error(`CompleteSale ${ack}: ${xml.slice(0, 600)}`);
  }
  return {
    ack,
    warnings: extractMessages(root).filter((message) => message.severity !== "Error"),
  };
}

export async function buildEbayTrackingAdditionPlan(
  input: EbayTrackingAdditionInput[],
): Promise<{ summary: EbayTrackingPlanSummary; plan: EbayTrackingPlanRow[] }> {
  const seen = new Set<string>();
  const entries: EbayTrackingPlanRow[] = [];

  for (const row of input) {
    const blockers = [...(row.preflightBlockers ?? [])];
    const orderId = row.orderId.trim();
    const trackingNumber = row.trackingNumber.trim().replace(/\s+/g, "");

    if (!/^\d{2}-\d{5}-\d{5}$/.test(orderId)) blockers.push("Order number is not an eBay order ID.");
    if (!trackingNumber) blockers.push("Tracking number is blank.");

    const duplicateKey = `${orderId}:${normalizeTracking(trackingNumber)}`;
    if (seen.has(duplicateKey)) blockers.push("Duplicate order/tracking pair in selection.");
    seen.add(duplicateKey);

    const matches: Array<{ store: EbayStore; order: Awaited<ReturnType<typeof getManageOrderDetail>> }> = [];
    if (blockers.length === 0) {
      const stores = row.storeHint ? [row.storeHint] : EBAY_STORES;
      for (const store of stores) {
        const order = await getManageOrderDetail(store, orderId);
        if (!order) continue;
        const safety = await checkWriteSafety(store);
        if (!safety.allowed) blockers.push(`${store}: ${safety.reason ?? "Write not allowed"}`);
        matches.push({ store, order });
      }
    }

    if (blockers.length === 0 && matches.length === 0) {
      blockers.push(row.storeHint
        ? `Order was not found in ${row.storeHint}.`
        : "Order was not found in TPP or TT eBay.");
    }
    if (matches.length > 1) blockers.push("Order matched more than one eBay store.");

    const selected = matches.length === 1 ? matches[0] : null;
    const existingTracking = selected?.order?.trackingNumbers ?? [];
    const alreadyPresent = existingTracking.some(
      (tracking) => normalizeTracking(tracking.number) === normalizeTracking(trackingNumber),
    );
    if (alreadyPresent) blockers.push("Tracking number is already present on the order.");

    const trackingPayload = selected
      ? [
          ...existingTracking
            .filter((tracking) => tracking.number)
            .map((tracking) => ({
              carrier: normalizeCarrier(tracking.carrier),
              trackingNumber: tracking.number!,
            })),
          { carrier: "USPS" as const, trackingNumber },
        ].filter((tracking, index, all) =>
          all.findIndex((other) => normalizeTracking(other.trackingNumber) === normalizeTracking(tracking.trackingNumber)) === index,
        )
      : [];

    if (trackingPayload.length > 6) {
      blockers.push(`eBay allows up to 6 tracking numbers; payload would have ${trackingPayload.length}.`);
    }

    entries.push({
      ...row,
      orderId,
      trackingNumber,
      status: blockers.length === 0 ? "ready" : "blocked",
      store: selected?.store ?? null,
      apiOrderId: selected?.order?.apiOrderId ?? null,
      existingTracking,
      trackingPayload,
      blockers,
    });
  }

  return { summary: summarizePlan(entries), plan: entries };
}

export async function executeEbayTrackingAdditions(input: {
  rows: EbayTrackingAdditionInput[];
  actorUserId: string;
  feature: string;
}): Promise<EbayTrackingExecutionResult> {
  const { plan } = await buildEbayTrackingAdditionPlan(input.rows);
  const blocked = plan.filter((row) => row.status !== "ready");
  if (blocked.length > 0) {
    throw new Error(`Refusing live send because ${blocked.length} rows are blocked.`);
  }

  const results: EbayTrackingExecutionRow[] = [];
  for (const row of plan) {
    try {
      if (!row.store || !row.apiOrderId) throw new Error("Ready row is missing eBay store or API order ID.");
      const result = await completeSaleWithTracking(row.store, row.apiOrderId, row.trackingPayload);
      const verified = await getManageOrderDetail(row.store, row.orderId);
      const verifiedTracking = verified?.trackingNumbers ?? [];
      const verificationStatus = verifiedTracking.some(
        (tracking) => normalizeTracking(tracking.number) === normalizeTracking(row.trackingNumber),
      )
        ? "verified"
        : "unverified";

      await db.auditLog.create({
        data: {
          userId: input.actorUserId,
          action: "manage_orders_ebay_action",
          entityType: "ebay_order",
          entityId: row.orderId,
          details: {
            feature: input.feature,
            actionType: "add_tracking",
            store: row.store,
            apiOrderId: row.apiOrderId,
            trackingNumbers: [{ carrier: "USPS", trackingNumber: row.trackingNumber }],
            trackingNumbersSentToEbay: row.trackingPayload,
            marketplaceAck: result.ack,
            marketplaceWarnings: result.warnings,
            sourceRow: row.sourceRow,
            reshipRowId: row.reshipRowId ?? null,
          } as Prisma.InputJsonValue,
        },
      });

      results.push({
        sourceRow: row.sourceRow,
        reshipRowId: row.reshipRowId,
        orderId: row.orderId,
        trackingNumber: row.trackingNumber,
        store: row.store,
        success: true,
        marketplaceAck: result.ack,
        marketplaceWarnings: result.warnings,
        verifiedTracking,
        verificationStatus,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.auditLog.create({
        data: {
          userId: input.actorUserId,
          action: "manage_orders_ebay_action_failed",
          entityType: "ebay_order",
          entityId: row.orderId,
          details: {
            feature: input.feature,
            actionType: "add_tracking",
            store: row.store,
            trackingNumber: row.trackingNumber,
            sourceRow: row.sourceRow,
            reshipRowId: row.reshipRowId ?? null,
            error: message,
          } as Prisma.InputJsonValue,
        },
      });

      results.push({
        sourceRow: row.sourceRow,
        reshipRowId: row.reshipRowId,
        orderId: row.orderId,
        trackingNumber: row.trackingNumber,
        store: row.store,
        success: false,
        error: message,
      });
    }
  }

  const successes = results.filter((row) => row.success);
  const verified = successes.filter((row) => row.verificationStatus === "verified");
  const unverified = successes.filter((row) => row.verificationStatus === "unverified");

  return {
    generatedAt: new Date().toISOString(),
    attemptedCount: results.length,
    successCount: successes.length,
    failureCount: results.length - successes.length,
    verifiedCount: verified.length,
    unverifiedCount: unverified.length,
    storeCounts: {
      TPP_EBAY: successes.filter((row) => row.store === "TPP_EBAY").length,
      TT_EBAY: successes.filter((row) => row.store === "TT_EBAY").length,
    },
    results,
  };
}

export async function auditEbayTrackingAdditionsBlocked(input: {
  actorUserId?: string | null;
  reason: string;
  rows: Array<{ orderId: string; trackingNumber: string; reshipRowId?: string | null }>;
  details?: Record<string, unknown>;
}) {
  await db.auditLog.create({
    data: {
      userId: input.actorUserId ?? undefined,
      action: "label_formatter_add_trackings_blocked",
      entityType: "label_formatter_reship_rows",
      entityId: null,
      details: {
        reason: input.reason,
        rowCount: input.rows.length,
        rows: input.rows,
        ...(input.details ?? {}),
      } as Prisma.InputJsonValue,
    },
  }).catch(() => {});
}
