import { createHmac } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { safeCompareText } from "@/lib/security";
import { handleMarketplaceWebhook } from "@/lib/services/webhook-sync";

export const runtime = "nodejs";

function getShopifyWebhookSecret() {
  return process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
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
  const sourceLabel = request.headers.get("x-shopify-shop-domain");
  const externalId =
    request.headers.get("x-shopify-event-id") ||
    request.headers.get("x-shopify-webhook-id");

  const result = await handleMarketplaceWebhook({
    platform: "SHOPIFY",
    topic,
    externalId,
    sourceLabel,
  });

  return NextResponse.json({ data: result }, { status: 202 });
}
