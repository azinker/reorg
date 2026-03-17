import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Platform } from "@prisma/client";

const SHOPIFY_API_VERSION = "2026-01";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const shop = searchParams.get("shop");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(
        `/integrations?shopify=error&message=${encodeURIComponent(error)}`,
        request.url
      )
    );
  }

  if (!code || !shop) {
    return NextResponse.redirect(
      new URL(
        "/integrations?shopify=error&message=Missing+code+or+shop",
        request.url
      )
    );
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      new URL(
        "/integrations?shopify=error&message=Server+config+missing",
        request.url
      )
    );
  }

  try {
    const tokenUrl = `https://${shop}/admin/oauth/access_token`;
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[shopify/callback] token exchange failed", res.status, text);
      return NextResponse.redirect(
        new URL(
          `/integrations?shopify=error&message=${encodeURIComponent("Token exchange failed")}`,
          request.url
        )
      );
    }

    const data = (await res.json()) as { access_token: string };
    const accessToken = data.access_token;

    if (!accessToken) {
      return NextResponse.redirect(
        new URL(
          "/integrations?shopify=error&message=No+token+in+response",
          request.url
        )
      );
    }

    await db.integration.update({
      where: { platform: Platform.SHOPIFY },
      data: {
        enabled: true,
        config: {
          storeDomain: shop,
          accessToken,
          apiVersion: SHOPIFY_API_VERSION,
        },
      },
    });

    return NextResponse.redirect(
      new URL("/integrations?shopify=connected", request.url)
    );
  } catch (err) {
    console.error("[shopify/callback]", err);
    return NextResponse.redirect(
      new URL(
        "/integrations?shopify=error&message=Connection+failed",
        request.url
      )
    );
  }
}
