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

  // 4. Probe REST endpoints for Shopify Balance (separate product from Shopify Payments)
  const restProbes = [
    // Shopify Payments processing buffer (known: returns $0.00)
    `/admin/api/${apiVersion}/shopify_payments/balance.json`,
    // Shopify Balance — various plausible paths
    `/admin/api/${apiVersion}/balance/transactions.json?limit=2`,
    `/admin/api/${apiVersion}/balance_accounts.json`,
    `/admin/api/${apiVersion}/shopify_balance/accounts.json`,
    `/admin/api/${apiVersion}/shopify_balance/account.json`,
    `/admin/api/${apiVersion}/financial_accounts.json`,
    `/admin/api/${apiVersion}/finances/balance.json`,
    `/admin/api/${apiVersion}/balance.json`,
  ];

  result.restProbes = {};
  for (const path of restProbes) {
    try {
      const r = await fetch(`https://${storeDomain}${path}`, {
        headers: { "X-Shopify-Access-Token": resolvedToken, Accept: "application/json" },
      });
      const body = await r.text();
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { parsed = body; }
      (result.restProbes as Record<string, unknown>)[path] = { status: r.status, body: parsed };
    } catch (e) {
      (result.restProbes as Record<string, unknown>)[path] = { error: String(e) };
    }
  }

  // 5. GraphQL probes for Shopify Balance
  const gqlProbes: Record<string, string> = {
    shopifyBalanceQuery: `{ shopifyBalance { id balance { amount currencyCode } } }`,
    balanceTxQuery: `{ shopifyPaymentsAccount { balance { amount currencyCode } balanceTransactions(first: 3, reverse: true) { nodes { id type amount { amount currencyCode } net { amount } } } } }`,
    businessEntityQuery: `{ businessEntities(first: 3) { nodes { id name shopifyPaymentsAccount { balance { amount currencyCode } } } } }`,
    shopQuery: `{ shop { name balance { amount currencyCode } } }`,
  };

  result.gqlProbes = {};
  for (const [key, query] of Object.entries(gqlProbes)) {
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": resolvedToken },
        body: JSON.stringify({ query }),
      });
      (result.gqlProbes as Record<string, unknown>)[key] = { httpStatus: r.status, body: await r.json() };
    } catch (e) {
      (result.gqlProbes as Record<string, unknown>)[key] = { error: String(e) };
    }
  }

  return NextResponse.json({ data: result });
}
