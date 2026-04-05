import { NextRequest, NextResponse } from "next/server";

const SCOPES = [
  // Products & inventory
  "read_products",
  "write_products",
  "read_inventory",
  "write_inventory",
  // Orders & fulfillments
  "read_orders",
  "write_orders",
  "read_all_orders",
  "read_fulfillments",
  "write_fulfillments",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
  "read_assigned_fulfillment_orders",
  "write_assigned_fulfillment_orders",
  // Shopify Payments & finance (required for Withdraw Funds page)
  "read_shopify_payments_accounts",
  "read_shopify_payments_payouts",
  "read_shopify_payments_bank_accounts",
  "read_shopify_payments_disputes",
  // Shopify Balance (banking wallet product)
  "read_balance",
].join(",");

export async function GET(request: NextRequest) {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const baseUrl =
    process.env.AUTH_URL?.replace(/\/$/, "") ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    request.nextUrl.origin;

  if (!clientId || !storeDomain) {
    return NextResponse.json(
      {
        error:
          "Missing SHOPIFY_CLIENT_ID or SHOPIFY_STORE_DOMAIN in environment",
      },
      { status: 500 }
    );
  }

  const shop = storeDomain.includes(".")
    ? storeDomain
    : `${storeDomain}.myshopify.com`;

  const redirectUri = `${baseUrl}/api/shopify/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state: shop,
  });

  const authUrl = `https://${shop}/admin/oauth/authorize?${params.toString()}`;

  return NextResponse.redirect(authUrl);
}
