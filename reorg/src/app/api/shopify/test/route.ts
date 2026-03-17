import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Platform } from "@prisma/client";

export async function GET() {
  try {
    const integration = await db.integration.findUnique({
      where: { platform: Platform.SHOPIFY },
    });

    if (!integration?.enabled) {
      return NextResponse.json({ ok: false, message: "Shopify not connected" });
    }

    const config = integration.config as Record<string, string>;
    const { storeDomain, accessToken, apiVersion } = config;

    if (!storeDomain || !accessToken) {
      return NextResponse.json({ ok: false, message: "Missing credentials" });
    }

    const url = `https://${storeDomain}/admin/api/${apiVersion || "2026-01"}/shop.json`;
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({
        ok: false,
        message: `Shopify API returned ${res.status}`,
        details: text.slice(0, 500),
      });
    }

    const data = await res.json();
    const shop = data.shop;

    const productsRes = await fetch(
      `https://${storeDomain}/admin/api/${apiVersion || "2026-01"}/products/count.json`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          Accept: "application/json",
        },
      }
    );

    let productCount = null;
    if (productsRes.ok) {
      const pData = await productsRes.json();
      productCount = pData.count;
    }

    return NextResponse.json({
      ok: true,
      shop: {
        name: shop?.name,
        domain: shop?.domain,
        myshopifyDomain: shop?.myshopify_domain,
        plan: shop?.plan_display_name,
        currency: shop?.currency,
      },
      productCount,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
