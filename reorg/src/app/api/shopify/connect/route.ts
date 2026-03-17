import { NextResponse } from "next/server";

const SCOPES =
  "read_products,write_products,read_inventory,write_inventory";

export async function GET() {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const baseUrl = process.env.AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

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

  const redirectUri = `${baseUrl.replace(/\/$/, "")}/api/shopify/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state: shop,
  });

  const authUrl = `https://${shop}/admin/oauth/authorize?${params.toString()}`;

  return NextResponse.redirect(authUrl);
}
