import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { safeCompareText } from "@/lib/security";
import { handleMarketplaceWebhook } from "@/lib/services/webhook-sync";
import { recordNetworkTransferSample, estimateJsonBytes } from "@/lib/services/network-transfer-samples";

export const runtime = "nodejs";

function readSharedSecret(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return (
    request.headers.get("x-reorg-webhook-secret") ||
    request.headers.get("x-bc-webhook-secret")
  );
}

function extractBigCommerceProductIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];

  const record = payload as Record<string, unknown>;
  const data =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : null;

  const candidates = [
    record.id,
    record.product_id,
    data?.id,
    data?.product_id,
    data?.inventory && typeof data.inventory === "object"
      ? (data.inventory as Record<string, unknown>).product_id
      : null,
    data?.sku && typeof data.sku === "object"
      ? (data.sku as Record<string, unknown>).product_id
      : null,
  ];

  return [...new Set(
    candidates
      .map((value) =>
        typeof value === "number" || typeof value === "string"
          ? String(value)
          : null,
      )
      .filter((value): value is string => !!value),
  )];
}

function extractBigCommerceVariantIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];

  const record = payload as Record<string, unknown>;
  const data =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : null;

  const candidates = [
    record.variant_id,
    data?.variant_id,
    data?.inventory && typeof data.inventory === "object"
      ? (data.inventory as Record<string, unknown>).variant_id
      : null,
    data?.sku && typeof data.sku === "object"
      ? (data.sku as Record<string, unknown>).variant_id
      : null,
    data?.id,
  ];

  return [...new Set(
    candidates
      .map((value) =>
        typeof value === "number" || typeof value === "string"
          ? String(value)
          : null,
      )
      .filter((value): value is string => !!value),
  )];
}

async function resolveBigCommerceProductIdsFromVariantIds(variantIds: string[]) {
  if (variantIds.length === 0) return [];

  const listings = await db.marketplaceListing.findMany({
    where: {
      integration: {
        platform: "BIGCOMMERCE",
      },
      platformVariantId: {
        in: variantIds,
      },
    },
    select: {
      platformItemId: true,
    },
  });

  return [...new Set(listings.map((listing) => listing.platformItemId))];
}

export async function POST(request: NextRequest) {
  const secret = process.env.BIGCOMMERCE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "BIGCOMMERCE_WEBHOOK_SECRET is not configured." },
      { status: 503 },
    );
  }

  const providedSecret = readSharedSecret(request);
  if (!providedSecret || !safeCompareText(secret, providedSecret)) {
    return NextResponse.json(
      { error: "Invalid BigCommerce webhook secret." },
      { status: 401 },
    );
  }

  const payload = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;

  void recordNetworkTransferSample({
    channel: "WEBHOOK_INBOUND",
    label: "BigCommerce webhook inbound",
    bytesEstimate: estimateJsonBytes(payload),
    metadata: { topic: typeof payload?.scope === "string" ? payload.scope : request.headers.get("x-bc-topic") },
  });

  const topic =
    typeof payload?.scope === "string"
      ? payload.scope
      : request.headers.get("x-bc-topic");
  const productIds = extractBigCommerceProductIds(payload);
  const variantIds = extractBigCommerceVariantIds(payload);
  const resolvedProductIds =
    productIds.length > 0
      ? productIds
      : await resolveBigCommerceProductIdsFromVariantIds(variantIds);
  const sourceLabel =
    typeof payload?.producer === "string"
      ? payload.producer
      : request.headers.get("user-agent");
  const externalId =
    typeof payload?.hash === "string"
      ? payload.hash
      : typeof payload?.id === "number" || typeof payload?.id === "string"
        ? String(payload.id)
        : null;

  const result = await handleMarketplaceWebhook({
    platform: "BIGCOMMERCE",
    topic,
    externalId,
    sourceLabel,
    changedIds: topic === "store/product/deleted" ? [] : resolvedProductIds,
    deletedIds: topic === "store/product/deleted" ? resolvedProductIds : [],
    changedVariantIds: variantIds,
  });

  return NextResponse.json({ data: result }, { status: 202 });
}
