import { createHmac } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { safeCompareText } from "@/lib/security";
import { handleMarketplaceWebhook } from "@/lib/services/webhook-sync";

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

async function resolveShopifyProductIds(payload: unknown) {
  const directIds = extractShopifyProductIds(payload);
  if (directIds.length > 0) return directIds;

  const inventoryItemIds = extractShopifyInventoryItemIds(payload);
  if (inventoryItemIds.length === 0) return [];

  const platformItemIds = new Set<string>();

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
      },
    });

    for (const listing of listings) {
      platformItemIds.add(listing.platformItemId);
    }
  }

  return [...platformItemIds];
}

function isShopifyDeleteTopic(topic: string | null) {
  if (!topic) return false;
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
  const productIds = await resolveShopifyProductIds(payload);
  const sourceLabel = request.headers.get("x-shopify-shop-domain");
  const externalId =
    request.headers.get("x-shopify-event-id") ||
    request.headers.get("x-shopify-webhook-id");

  const result = await handleMarketplaceWebhook({
    platform: "SHOPIFY",
    topic,
    externalId,
    sourceLabel,
    changedIds: isShopifyDeleteTopic(topic) ? [] : productIds,
    deletedIds: isShopifyDeleteTopic(topic) ? productIds : [],
  });

  return NextResponse.json({ data: result }, { status: 202 });
}
