/**
 * Payouts service — fetches recent payout/settlement data from each marketplace.
 *
 * eBay TPP / TT  : eBay Sell Finances API  /sell/finances/v1/payout
 * Shopify        : GraphQL shopifyPaymentsAccount.payouts (already works)
 * BigCommerce    : No payout API — static Stripe dashboard link only
 * Amazon         : SP-API /finances/v0/financialEventGroups (settlements)
 */

import { db } from "@/lib/db";
import { Platform } from "@prisma/client";
import { createHash, createHmac } from "crypto";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PayoutEntry = {
  id: string;
  /** ISO date string */
  date: string;
  grossAmount: number | null;
  netAmount: number;
  currency: string;
  status: string;
  /** e.g. DEPOSIT / WITHDRAWAL */
  type: string | null;
  /** Destination bank account, e.g. "Bank of America ···2291" */
  bankAccount: string | null;
};

export type PlatformPayouts = {
  platform: string;
  label: string;
  payouts: PayoutEntry[];
  /** Most recent net payout (for hero) */
  latestNet: number | null;
  latestCurrency: string;
  fetchError: string | null;
  /** Deep link to manage payouts externally */
  adminUrl: string | null;
  adminUrlLabel: string | null;
};

export type PayoutsSummary = {
  platforms: PlatformPayouts[];
  /** Sum of all platform latestNet amounts (USD assumed for hero) */
  heroTotal: number;
  fetchedAt: string;
};

// ─── eBay helpers ─────────────────────────────────────────────────────────────

interface EbayIntegrationConfig {
  appId: string;
  certId: string;
  refreshToken: string;
  environment?: string;
}

async function getEbayToken(cfg: EbayIntegrationConfig): Promise<string> {
  const base =
    cfg.environment === "SANDBOX"
      ? "https://api.sandbox.ebay.com"
      : "https://api.ebay.com";
  const credentials = Buffer.from(`${cfg.appId}:${cfg.certId}`).toString("base64");
  const res = await fetch(`${base}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cfg.refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`eBay token refresh failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

async function fetchEbayPayouts(platform: Platform, label: string): Promise<PlatformPayouts> {
  const integration = await db.integration.findFirst({
    where: { platform, enabled: true },
    select: { config: true },
  });
  if (!integration) {
    return noIntegration(platform, label, "Not connected.");
  }

  const cfg = integration.config as Record<string, unknown>;
  const appId = cfg.appId as string | undefined;
  const certId = cfg.certId as string | undefined;
  const refreshToken = cfg.refreshToken as string | undefined;
  const env = (cfg.environment as string | undefined) ?? "PRODUCTION";

  if (!appId || !certId || !refreshToken) {
    return noIntegration(platform, label, "Missing eBay credentials in integration config.");
  }

  try {
    const token = await getEbayToken({ appId, certId, refreshToken, environment: env });
    const base = env === "SANDBOX" ? "https://apiz.sandbox.ebay.com" : "https://apiz.ebay.com";

    // Use a date range filter (same pattern as the revenue transactions endpoint).
    // eBay sort params are camelCase with optional "-" prefix — avoid them to prevent 400s.
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date().toISOString();
    const url = new URL(`${base}/sell/finances/v1/payout`);
    url.searchParams.set("limit", "25");
    url.searchParams.set("filter", `payoutDate:[${since}..${to}]`);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return error(platform, label, `eBay payout fetch failed: ${res.status} — ${text.slice(0, 200)}`);
    }

    type EbayPayoutResponse = {
      payouts?: Array<{
        payoutId?: string;
        payoutStatus?: string;
        payoutDate?: string;
        lastAttemptedPayoutDate?: string;
        amount?: { value?: string; currency?: string };
        payoutInstrument?: {
          instrumentType?: string;
          accountLastFourDigits?: string;
          nickname?: string;
        };
      }>;
    };

    const rawText = await res.text();
    void recordNetworkTransferSample({
      channel: "MARKETPLACE_INBOUND",
      label: `Payouts page — eBay Finances API (${label})`,
      bytesEstimate: new TextEncoder().encode(rawText).length,
      metadata: { platform: String(platform), source: "payouts-page" },
    });
    const json = JSON.parse(rawText) as EbayPayoutResponse;
    // Sort descending by date client-side (most recent first)
    const sorted = (json.payouts ?? []).sort((a, b) => {
      const da = new Date(a.lastAttemptedPayoutDate ?? a.payoutDate ?? 0).getTime();
      const db = new Date(b.lastAttemptedPayoutDate ?? b.payoutDate ?? 0).getTime();
      return db - da;
    });
    const payouts: PayoutEntry[] = sorted.map((p) => {
      const inst = p.payoutInstrument;
      let bankAccount: string | null = null;
      if (inst?.accountLastFourDigits) {
        const label = inst.nickname?.trim() || inst.instrumentType?.replace(/_/g, " ") || "Bank";
        bankAccount = `${label} ···${inst.accountLastFourDigits}`;
      }
      return {
        id: p.payoutId ?? "",
        date: p.lastAttemptedPayoutDate ?? p.payoutDate ?? "",
        grossAmount: null,
        netAmount: Number(p.amount?.value ?? 0),
        currency: p.amount?.currency ?? "USD",
        status: p.payoutStatus ?? "",
        type: "DEPOSIT",
        bankAccount,
      };
    });

    return {
      platform: String(platform),
      label,
      payouts,
      latestNet: payouts[0]?.netAmount ?? null,
      latestCurrency: payouts[0]?.currency ?? "USD",
      fetchError: null,
      adminUrl: "https://www.ebay.com/sh/fin/payouts",
      adminUrlLabel: "View in eBay Seller Hub",
    };
  } catch (e) {
    return error(platform, label, e instanceof Error ? e.message : String(e));
  }
}

// ─── Shopify helpers ──────────────────────────────────────────────────────────

async function fetchShopifyPayouts(storeHandle: string): Promise<PlatformPayouts> {
  const integration = await db.integration.findFirst({
    where: { platform: Platform.SHOPIFY, enabled: true },
    select: { config: true },
  });
  if (!integration) return noIntegration(Platform.SHOPIFY, "Shopify (SHPFY)", "Not connected.");

  const cfg = integration.config as Record<string, unknown>;
  const rawDomain = cfg.storeDomain as string | undefined;
  const accessToken = (cfg.accessToken as string | undefined) ?? process.env.SHOPIFY_ACCESS_TOKEN;
  const apiVersion = (cfg.apiVersion as string | undefined) ?? "2026-01";

  if (!rawDomain || !accessToken) {
    return noIntegration(Platform.SHOPIFY, "Shopify (SHPFY)", "Missing Shopify credentials.");
  }

  const domain = rawDomain.includes(".") ? rawDomain : `${rawDomain}.myshopify.com`;
  const endpoint = `https://${domain}/admin/api/${apiVersion}/graphql.json`;

  const query = `#graphql
    query PayoutsShopify {
      shopifyPaymentsAccount {
        payouts(first: 25, reverse: true) {
          nodes {
            id
            status
            issuedAt
            transactionType
            net { amount currencyCode }
            summary {
              chargesGross { amount currencyCode }
              chargesFee { amount currencyCode }
            }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) throw new Error(`Shopify GraphQL HTTP ${res.status}`);

    const rawText = await res.text();
    void recordNetworkTransferSample({
      channel: "MARKETPLACE_INBOUND",
      label: "Payouts page — Shopify GraphQL (payouts)",
      bytesEstimate: new TextEncoder().encode(rawText).length,
      metadata: { platform: "SHOPIFY", source: "payouts-page" },
    });
    const rawJson = JSON.parse(rawText) as unknown;

    type ShopifyPayoutResponse = {
      data?: {
        shopifyPaymentsAccount?: {
          payouts?: {
            nodes?: Array<{
              id: string;
              status: string;
              issuedAt: string;
              transactionType: string;
              net: { amount: string; currencyCode: string };
              summary?: {
                chargesGross?: { amount: string; currencyCode: string };
                chargesFee?: { amount: string; currencyCode: string };
              };
            }>;
          };
        };
      };
    };

    const json = rawJson as ShopifyPayoutResponse;
    const nodes = json.data?.shopifyPaymentsAccount?.payouts?.nodes ?? [];

    const payouts: PayoutEntry[] = nodes.map((p) => {
      const gross = p.summary?.chargesGross ? Number(p.summary.chargesGross.amount) : null;
      const net = Number(p.net.amount);
      return {
        id: p.id,
        date: p.issuedAt,
        grossAmount: gross,
        netAmount: net,
        currency: p.net.currencyCode,
        status: p.status,
        type: p.transactionType,
        // Shopify Payments always sweeps into Shopify Balance (internal wallet)
        bankAccount: "Shopify Balance",
      };
    });

    return {
      platform: "SHOPIFY",
      label: "Shopify (SHPFY)",
      payouts,
      latestNet: payouts[0]?.netAmount ?? null,
      latestCurrency: payouts[0]?.currency ?? "USD",
      fetchError: null,
      adminUrl: `https://admin.shopify.com/store/${storeHandle}/shopify-balance/account`,
      adminUrlLabel: "Open Shopify Balance",
    };
  } catch (e) {
    return error(Platform.SHOPIFY, "Shopify (SHPFY)", e instanceof Error ? e.message : String(e));
  }
}

// ─── Amazon SP-API helpers ────────────────────────────────────────────────────

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function awsSignHeaders(opts: {
  method: string;
  path: string;
  query: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Record<string, string> {
  const { method, path, query, accessKeyId, secretAccessKey } = opts;
  const host = "sellingpartnerapi-na.amazon.com";
  const region = "us-east-1";
  const service = "execute-api";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex("");
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-date";
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(`AWS4${secretAccessKey}`, dateStamp), region), service),
    "aws4_request",
  );
  const signature = hmacSha256(signingKey, stringToSign).toString("hex");
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date": amzDate,
    host,
  };
}

async function fetchAmazonPayouts(): Promise<PlatformPayouts> {
  const integration = await db.integration.findFirst({
    where: { platform: Platform.AMAZON, enabled: true },
    select: { config: true },
  });

  const accessKeyId = process.env.AMAZON_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AMAZON_AWS_SECRET_ACCESS_KEY;
  const clientId = process.env.AMAZON_LWA_CLIENT_ID;
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;

  if (!integration || !accessKeyId || !secretAccessKey || !clientId || !clientSecret) {
    return noIntegration(Platform.AMAZON, "Amazon", "Amazon integration not configured.");
  }

  const cfg = integration.config as Record<string, unknown>;
  const refreshToken = cfg.refreshToken as string | undefined;
  if (!refreshToken) {
    return noIntegration(Platform.AMAZON, "Amazon", "Amazon refresh token missing.");
  }

  try {
    // Get LWA token
    const tokenRes = await fetch("https://api.amazon.com/auth/o2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!tokenRes.ok) throw new Error(`LWA token failed: ${tokenRes.status}`);
    const tokenData = (await tokenRes.json()) as { access_token: string };
    const lwaToken = tokenData.access_token;

    // Get financial event groups (settlements) from last 90 days
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const path = "/finances/v0/financialEventGroups";
    const queryStr = `FinancialEventGroupStartedAfter=${encodeURIComponent(since)}&MaxResultsPerPage=30`;

    const awsHeaders = awsSignHeaders({
      method: "GET",
      path,
      query: queryStr,
      accessKeyId,
      secretAccessKey,
    });

    const spRes = await fetch(
      `https://sellingpartnerapi-na.amazon.com${path}?${queryStr}`,
      {
        headers: {
          ...awsHeaders,
          "x-amz-access-token": lwaToken,
          Accept: "application/json",
        },
      },
    );

    const spRawText = await spRes.text();
    if (!spRes.ok) {
      return error(Platform.AMAZON, "Amazon", `SP-API failed: ${spRes.status} — ${spRawText.slice(0, 200)}`);
    }

    void recordNetworkTransferSample({
      channel: "MARKETPLACE_INBOUND",
      label: "Payouts page — Amazon SP-API (financial event groups)",
      bytesEstimate: new TextEncoder().encode(spRawText).length,
      metadata: { platform: "AMAZON", source: "payouts-page" },
    });

    type AmazonGroup = {
      FinancialEventGroupId: string;
      ProcessingStatus: string;
      FundTransferDate?: string;
      OriginalTotal?: { CurrencyCode: string; CurrencyAmount: number };
      ConvertedTotal?: { CurrencyCode: string; CurrencyAmount: number };
      BeginningBalance?: { CurrencyAmount: number };
    };

    const spJson = JSON.parse(spRawText) as {
      payload?: { FinancialEventGroupList?: AmazonGroup[] };
    };

    const groups = spJson.payload?.FinancialEventGroupList ?? [];

    const payouts: PayoutEntry[] = groups
      .filter((g) => g.FundTransferDate)
      .sort((a, b) =>
        new Date(b.FundTransferDate!).getTime() - new Date(a.FundTransferDate!).getTime(),
      )
      .map((g) => {
        const net = g.ConvertedTotal?.CurrencyAmount ?? g.OriginalTotal?.CurrencyAmount ?? 0;
        const currency = g.ConvertedTotal?.CurrencyCode ?? g.OriginalTotal?.CurrencyCode ?? "USD";
        return {
          id: g.FinancialEventGroupId,
          date: g.FundTransferDate!,
          grossAmount: null,
          netAmount: net,
          currency,
          status: g.ProcessingStatus,
          type: "SETTLEMENT",
          bankAccount: null,
        };
      });

    return {
      platform: "AMAZON",
      label: "Amazon",
      payouts,
      latestNet: payouts[0]?.netAmount ?? null,
      latestCurrency: payouts[0]?.currency ?? "USD",
      fetchError: null,
      adminUrl: "https://sellercentral.amazon.com/payments/dashboard/index.html",
      adminUrlLabel: "View in Seller Central",
    };
  } catch (e) {
    return error(Platform.AMAZON, "Amazon", e instanceof Error ? e.message : String(e));
  }
}

// ─── BigCommerce / Stripe ─────────────────────────────────────────────────────

async function fetchBigCommercePayouts(): Promise<PlatformPayouts> {
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeKey) {
    return {
      platform: "BIGCOMMERCE",
      label: "BigCommerce (BC)",
      payouts: [],
      latestNet: null,
      latestCurrency: "USD",
      fetchError: "STRIPE_SECRET_KEY not configured — add it to your environment variables to see live payout data.",
      adminUrl: "https://dashboard.stripe.com/payouts",
      adminUrlLabel: "Open Stripe dashboard",
    };
  }

  try {
    const res = await fetch(
      "https://api.stripe.com/v1/payouts?limit=25&expand[]=data.destination",
      {
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Stripe-Version": "2024-11-20.acacia",
        },
      },
    );

    const stripeRawText = await res.text();
    if (!res.ok) {
      return error(
        Platform.BIGCOMMERCE,
        "BigCommerce (BC)",
        `Stripe payout fetch failed: ${res.status} — ${stripeRawText.slice(0, 200)}`,
      );
    }

    void recordNetworkTransferSample({
      channel: "MARKETPLACE_INBOUND",
      label: "Payouts page — Stripe API (payouts)",
      bytesEstimate: new TextEncoder().encode(stripeRawText).length,
      metadata: { platform: "BIGCOMMERCE", source: "payouts-page" },
    });

    type StripePayout = {
      id: string;
      status: string;
      arrival_date: number;
      amount: number;
      currency: string;
      description?: string | null;
      destination?: {
        bank_name?: string;
        last4?: string;
        routing_number?: string;
      } | null;
    };

    const json = JSON.parse(stripeRawText) as { data?: StripePayout[] };
    const payouts: PayoutEntry[] = (json.data ?? []).map((p) => {
      let bankAccount: string | null = null;
      if (p.destination?.last4) {
        const bankName = p.destination.bank_name?.trim() || "Bank";
        bankAccount = `${bankName} ···${p.destination.last4}`;
      }
      return {
        id: p.id,
        date: new Date(p.arrival_date * 1000).toISOString(),
        grossAmount: null,
        netAmount: p.amount / 100,
        currency: p.currency.toUpperCase(),
        status: p.status.toUpperCase(),
        type: "DEPOSIT",
        bankAccount,
      };
    });

    return {
      platform: "BIGCOMMERCE",
      label: "BigCommerce (BC)",
      payouts,
      latestNet: payouts[0]?.netAmount ?? null,
      latestCurrency: payouts[0]?.currency ?? "USD",
      fetchError: null,
      adminUrl: "https://dashboard.stripe.com/payouts",
      adminUrlLabel: "Open Stripe dashboard",
    };
  } catch (e) {
    return error(
      Platform.BIGCOMMERCE,
      "BigCommerce (BC)",
      e instanceof Error ? e.message : String(e),
    );
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

function shopifyStoreHandle(rawDomain: string): string {
  const h = rawDomain.trim().toLowerCase();
  return h.endsWith(".myshopify.com") ? h.slice(0, -".myshopify.com".length) : h.split(".")[0] ?? h;
}

export async function getAllPayouts(): Promise<PayoutsSummary> {
  // Need Shopify store handle for the Balance URL
  const shopifyIntegration = await db.integration.findFirst({
    where: { platform: Platform.SHOPIFY, enabled: true },
    select: { config: true },
  });
  const rawShopifyDomain = (shopifyIntegration?.config as Record<string, unknown> | null)?.storeDomain as string | undefined;
  const storeHandle = rawShopifyDomain ? shopifyStoreHandle(rawShopifyDomain) : "fd7279";

  const [tpp, tt, shopify, amazon, bigcommerce] = await Promise.all([
    fetchEbayPayouts(Platform.TPP_EBAY, "eBay TPP"),
    fetchEbayPayouts(Platform.TT_EBAY, "eBay TT"),
    fetchShopifyPayouts(storeHandle),
    fetchAmazonPayouts(),
    fetchBigCommercePayouts(),
  ]);

  const platforms = [tpp, tt, shopify, amazon, bigcommerce];

  const heroTotal = platforms.reduce((sum, p) => {
    if (p.latestNet != null && p.latestCurrency === "USD") {
      return sum + p.latestNet;
    }
    return sum;
  }, 0);

  return { platforms, heroTotal, fetchedAt: new Date().toISOString() };
}

// ─── Util ─────────────────────────────────────────────────────────────────────

function noIntegration(platform: Platform, label: string, msg: string): PlatformPayouts {
  return {
    platform: String(platform),
    label,
    payouts: [],
    latestNet: null,
    latestCurrency: "USD",
    fetchError: msg,
    adminUrl: null,
    adminUrlLabel: null,
  };
}

function error(platform: Platform, label: string, msg: string): PlatformPayouts {
  return {
    platform: String(platform),
    label,
    payouts: [],
    latestNet: null,
    latestCurrency: "USD",
    fetchError: msg,
    adminUrl: null,
    adminUrlLabel: null,
  };
}
