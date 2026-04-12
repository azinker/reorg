import { createHmac } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { safeCompareText } from "@/lib/security";
import { handleMarketplaceWebhook } from "@/lib/services/webhook-sync";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";

export const runtime = "nodejs";

function getShopifyWebhookSecret() {
  return process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
}

function extractShopifyProductIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];

  const record = payload as Record<string, unknown>;
  const candidates = [
    record.id,
    record.product_id,
    typeof record.product === "object" && record.product
      ? (record.product as Record<string, unknown>).id
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

function extractShopifyVariantIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];

  const record = payload as Record<string, unknown>;
  const variants = Array.isArray(record.variants)
    ? (record.variants as Array<Record<string, unknown>>)
    : [];
  const candidates = [
    record.variant_id,
    typeof record.variant === "object" && record.variant
      ? (record.variant as Record<string, unknown>).id
      : null,
    ...variants.map((variant) => variant.id),
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

function extractShopifyInventoryItemIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];

  const record = payload as Record<string, unknown>;
  const candidates = [
    record.inventory_item_id,
    typeof record.inventory_item === "object" && record.inventory_item
      ? (record.inventory_item as Record<string, unknown>).id
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

async function resolveShopifyProductIdsFromVariantIds(variantIds: string[]) {
  if (variantIds.length === 0) {
    return {
      productIds: [],
      variantIds: [],
    };
  }

  const listings = await db.marketplaceListing.findMany({
    where: {
      integration: {
        platform: "SHOPIFY",
      },
      platformVariantId: {
        in: variantIds,
      },
    },
    select: {
      platformItemId: true,
      platformVariantId: true,
    },
  });

  return {
    productIds: [...new Set(listings.map((listing) => listing.platformItemId))],
    variantIds: [
      ...new Set(
        listings
          .map((listing) => listing.platformVariantId)
          .filter((value): value is string => Boolean(value)),
      ),
    ],
  };
}

async function resolveShopifyTargets(payload: unknown) {
  const directIds = extractShopifyProductIds(payload);
  const directVariantIds = extractShopifyVariantIds(payload);
  if (directIds.length > 0) {
    return {
      productIds: directIds,
      variantIds: directVariantIds,
    };
  }

  const inventoryItemIds = extractShopifyInventoryItemIds(payload);
  const platformItemIds = new Set<string>();
  const platformVariantIds = new Set<string>();

  for (const inventoryItemId of inventoryItemIds) {
    const numericInventoryItemId = Number(inventoryItemId);
    const jsonValue =
      Number.isFinite(numericInventoryItemId) && !Number.isNaN(numericInventoryItemId)
        ? numericInventoryItemId
        : inventoryItemId;

    const listings = await db.marketplaceListing.findMany({
      where: {
        integration: {
          platform: "SHOPIFY",
        },
        rawData: {
          path: ["variant", "inventory_item_id"],
          equals: jsonValue,
        },
      },
      select: {
        platformItemId: true,
        platformVariantId: true,
      },
    });

    for (const listing of listings) {
      platformItemIds.add(listing.platformItemId);
      if (listing.platformVariantId) {
        platformVariantIds.add(listing.platformVariantId);
      }
    }
  }

  if (platformItemIds.size === 0 && directVariantIds.length > 0) {
    const resolved = await resolveShopifyProductIdsFromVariantIds(directVariantIds);
    for (const productId of resolved.productIds) {
      platformItemIds.add(productId);
    }
    for (const variantId of resolved.variantIds) {
      platformVariantIds.add(variantId);
    }
  }

  return {
    productIds: [...platformItemIds],
    variantIds: [...new Set([...directVariantIds, ...platformVariantIds])],
  };
}

function isShopifyProductDeleteTopic(topic: string | null) {
  return topic === "PRODUCTS_DELETE" || topic === "products/delete";
}

export async function POST(request: NextRequest) {
  const secret = getShopifyWebhookSecret();
  if (!secret) {
    return NextResponse.json(
      { error: "SHOPIFY_WEBHOOK_SECRET is not configured." },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const receivedSignature = request.headers.get("x-shopify-hmac-sha256");

  if (!receivedSignature) {
    return NextResponse.json(
      { error: "Missing Shopify webhook signature." },
      { status: 401 },
    );
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  if (!safeCompareText(expectedSignature, receivedSignature)) {
    return NextResponse.json(
      { error: "Invalid Shopify webhook signature." },
      { status: 401 },
    );
  }

  const topic = request.headers.get("x-shopify-topic");
  const payload = rawBody ? (JSON.parse(rawBody) as unknown) : null;

  void recordNetworkTransferSample({
    channel: "WEBHOOK_INBOUND",
    label: "Shopify webhook inbound",
    bytesEstimate: rawBody ? Buffer.byteLength(rawBody, "utf8") : null,
    metadata: { topic },
  });

  const targets = await resolveShopifyTargets(payload);
  const sourceLabel = request.headers.get("x-shopify-shop-domain");
  const externalId =
    request.headers.get("x-shopify-event-id") ||
    request.headers.get("x-shopify-webhook-id");

  const result = await handleMarketplaceWebhook({
    platform: "SHOPIFY",
    topic,
    externalId,
    sourceLabel,
    changedIds: isShopifyProductDeleteTopic(topic) ? [] : targets.productIds,
    deletedIds: isShopifyProductDeleteTopic(topic) ? targets.productIds : [],
    changedVariantIds: targets.variantIds,
  });

  return NextResponse.json({ data: result }, { status: 202 });
}
