import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Platform } from "@prisma/client";
import { shopifyGraphQL } from "@/lib/integrations/shopify-graphql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeStoreDomain(storeDomain: string): string {
  const t = storeDomain.trim();
  return t.includes(".") ? t : `${t}.myshopify.com`;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result: Record<string, unknown> = {};

  // 1. DB integration record
  const integration = await db.integration.findFirst({
    where: { platform: Platform.SHOPIFY, enabled: true },
    select: { id: true, config: true, enabled: true, writeLocked: true },
  });

  if (!integration) {
    result.dbIntegration = { found: false };
    return NextResponse.json({ data: result });
  }

  const cfg = integration.config as Record<string, unknown>;
  const rawDomain = typeof cfg.storeDomain === "string" ? cfg.storeDomain : null;
  const dbToken = typeof cfg.accessToken === "string" ? cfg.accessToken : null;
  const envToken = process.env.SHOPIFY_ACCESS_TOKEN ?? null;
  const resolvedToken = dbToken ?? envToken;
  const apiVersion = (typeof cfg.apiVersion === "string" ? cfg.apiVersion : null) ?? "2026-01";

  result.dbIntegration = {
    found: true,
    id: integration.id,
    enabled: integration.enabled,
    writeLocked: integration.writeLocked,
    storeDomain: rawDomain,
    apiVersion,
    dbTokenPresent: !!dbToken,
    dbTokenPreview: dbToken ? `${dbToken.slice(0, 10)}...` : null,
    envTokenPresent: !!envToken,
    envTokenPreview: envToken ? `${envToken.slice(0, 10)}...` : null,
    resolvedTokenSource: dbToken ? "DB" : envToken ? "ENV" : "NONE",
  };

  if (!rawDomain || !resolvedToken) {
    result.error = "Missing store domain or access token — cannot proceed.";
    return NextResponse.json({ data: result });
  }

  const storeDomain = normalizeStoreDomain(rawDomain);
  const endpoint = `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`;
  result.endpoint = endpoint;

  // 2. Check token scopes
  try {
    const scopeRes = await fetch(`https://${storeDomain}/admin/oauth/access_scopes.json`, {
      headers: { "X-Shopify-Access-Token": resolvedToken, Accept: "application/json" },
    });
    const scopeBody = await scopeRes.text();
    result.tokenScopes = {
      status: scopeRes.status,
      body: scopeRes.ok ? JSON.parse(scopeBody) : scopeBody,
      hasPaymentsScope: scopeRes.ok && scopeBody.includes("shopify_payments"),
    };
  } catch (e) {
    result.tokenScopes = { error: String(e) };
  }

  // 3. Raw shopifyPaymentsAccount query
  const paymentsQuery = `#graphql
    query WithdrawFundsDiag {
      shop {
        name
        myshopifyDomain
        paymentSettings {
          supportedDigitalWallets
        }
      }
      shopifyPaymentsAccount {
        activated
        country
        defaultCurrency
        balance {
          amount
          currencyCode
        }
        bankAccounts(first: 5) {
          nodes {
            bankName
            accountNumberLastDigits
            currency
            status
          }
        }
        payouts(first: 5, reverse: true) {
          nodes {
            id
            status
            issuedAt
            transactionType
            net {
              amount
              currencyCode
            }
          }
        }
      }
    }
  `;

  try {
    const raw = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": resolvedToken,
        Accept: "application/json",
      },
      body: JSON.stringify({ query: paymentsQuery }),
    });
    const rawBody = await raw.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = rawBody;
    }
    result.shopifyPaymentsAccountRaw = {
      httpStatus: raw.status,
      body: parsed,
    };
  } catch (e) {
    result.shopifyPaymentsAccountRaw = { error: String(e) };
  }

  // 4. Try the shared helper to see if it succeeds
  try {
    type ShopData = { shop: { name: string }; shopifyPaymentsAccount: unknown };
    const data = await shopifyGraphQL<ShopData>(endpoint, resolvedToken, paymentsQuery);
    result.helperResult = {
      ok: true,
      shopName: data.shop.name,
      shopifyPaymentsAccountNull: data.shopifyPaymentsAccount === null,
    };
  } catch (e) {
    result.helperResult = { ok: false, error: String(e) };
  }

  return NextResponse.json({ data: result });
}
