import { db } from "@/lib/db";
import { Platform } from "@prisma/client";
import { shopifyGraphQL } from "@/lib/integrations/shopify-graphql";

const WITHDRAW_FUNDS_QUERY = `#graphql
  query WithdrawFundsShopifySnapshot {
    shop {
      name
      myshopifyDomain
    }
    shopifyPaymentsAccount {
      activated
      country
      defaultCurrency
      balance {
        amount
        currencyCode
      }
      payoutSchedule {
        interval
        monthlyAnchor
        weeklyAnchor
      }
      bankAccounts(first: 10) {
        nodes {
          bankName
          accountNumberLastDigits
          country
          currency
          status
        }
      }
      payouts(first: 25, reverse: true) {
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

export type WithdrawFundsShopifySnapshot = {
  shop: {
    name: string;
    myshopifyDomain: string;
  };
  storeHandle: string;
  adminUrls: {
    /** Settings → Payments (bank account, Shopify Payments). */
    paymentsSettings: string;
    /** Finance → Payouts style view (logged-in Shopify session). */
    payoutsInAdmin: string;
  };
  paymentsAccount: {
    activated: boolean;
    country: string;
    defaultCurrency: string;
    balances: { amount: string; currencyCode: string }[];
    payoutSchedule: {
      interval: string;
      monthlyAnchor: number | null;
      weeklyAnchor: string | null;
    } | null;
    bankAccounts: {
      bankName: string | null;
      lastDigits: string;
      country: string;
      currency: string;
      status: string;
    }[];
    payouts: {
      id: string;
      status: string;
      issuedAt: string;
      transactionType: string;
      netAmount: string;
      currencyCode: string;
    }[];
  } | null;
  fetchError: string | null;
};

function normalizeStoreDomain(storeDomain: string): string {
  const t = storeDomain.trim();
  return t.includes(".") ? t : `${t}.myshopify.com`;
}

/** Admin URL store segment, e.g. `my-store` from `my-store.myshopify.com`. */
export function shopifyStoreHandleFromDomain(myshopifyDomain: string): string {
  const host = myshopifyDomain.trim().toLowerCase();
  if (host.endsWith(".myshopify.com")) {
    return host.slice(0, -".myshopify.com".length);
  }
  const parts = host.split(".");
  return parts[0] ?? host;
}

export async function getWithdrawFundsShopifySnapshot(): Promise<WithdrawFundsShopifySnapshot> {
  const integration = await db.integration.findFirst({
    where: { platform: Platform.SHOPIFY, enabled: true },
    select: { config: true },
  });

  if (!integration) {
    throw new Error("No enabled Shopify integration found.");
  }

  const cfg = integration.config as Record<string, unknown>;
  const rawDomain =
    typeof cfg.storeDomain === "string" && cfg.storeDomain.trim()
      ? cfg.storeDomain.trim()
      : null;
  const accessToken =
    typeof cfg.accessToken === "string" && cfg.accessToken.trim()
      ? cfg.accessToken.trim()
      : null;
  const apiVersion =
    typeof cfg.apiVersion === "string" && cfg.apiVersion.trim()
      ? cfg.apiVersion.trim()
      : "2026-01";

  if (!rawDomain || !accessToken) {
    throw new Error("Shopify integration is missing store domain or access token.");
  }

  const storeDomain = normalizeStoreDomain(rawDomain);
  const endpoint = `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`;

  type GqlData = {
    shop: { name: string; myshopifyDomain: string };
    shopifyPaymentsAccount: {
      activated: boolean;
      country: string;
      defaultCurrency: string;
      balance: Array<{ amount: string; currencyCode: string }>;
      payoutSchedule: {
        interval: string;
        monthlyAnchor: number | null;
        weeklyAnchor: string | null;
      } | null;
      bankAccounts: {
        nodes: Array<{
          bankName: string | null;
          accountNumberLastDigits: string;
          country: string;
          currency: string;
          status: string;
        }>;
      };
      payouts: {
        nodes: Array<{
          id: string;
          status: string;
          issuedAt: string;
          transactionType: string;
          net: { amount: string; currencyCode: string };
        }>;
      };
    } | null;
  };

  let data: GqlData;
  try {
    data = await shopifyGraphQL<GqlData>(endpoint, accessToken, WITHDRAW_FUNDS_QUERY);
  } catch (e) {
    const handle = shopifyStoreHandleFromDomain(normalizeStoreDomain(rawDomain));
    return {
      shop: { name: rawDomain, myshopifyDomain: normalizeStoreDomain(rawDomain) },
      storeHandle: handle,
      adminUrls: buildAdminUrls(handle),
      paymentsAccount: null,
      fetchError: e instanceof Error ? e.message : String(e),
    };
  }

  const handle = shopifyStoreHandleFromDomain(data.shop.myshopifyDomain);
  const acc = data.shopifyPaymentsAccount;

  if (!acc) {
    return {
      shop: { name: data.shop.name, myshopifyDomain: data.shop.myshopifyDomain },
      storeHandle: handle,
      adminUrls: buildAdminUrls(handle),
      paymentsAccount: null,
      fetchError:
        "Shopify Payments data is not available for this shop. You may not use Shopify Payments, or the app token may need the read_shopify_payments and read_shopify_payments_bank_accounts scopes.",
    };
  }

  return {
    shop: { name: data.shop.name, myshopifyDomain: data.shop.myshopifyDomain },
    storeHandle: handle,
    adminUrls: buildAdminUrls(handle),
    paymentsAccount: {
      activated: acc.activated,
      country: acc.country,
      defaultCurrency: acc.defaultCurrency,
      balances: (acc.balance ?? []).map((b) => ({
        amount: b.amount,
        currencyCode: b.currencyCode,
      })),
      payoutSchedule: acc.payoutSchedule
        ? {
            interval: acc.payoutSchedule.interval,
            monthlyAnchor: acc.payoutSchedule.monthlyAnchor,
            weeklyAnchor: acc.payoutSchedule.weeklyAnchor,
          }
        : null,
      bankAccounts: acc.bankAccounts.nodes.map((b) => ({
        bankName: b.bankName,
        lastDigits: b.accountNumberLastDigits,
        country: b.country,
        currency: b.currency,
        status: b.status,
      })),
      payouts: acc.payouts.nodes.map((p) => ({
        id: p.id,
        status: p.status,
        issuedAt: p.issuedAt,
        transactionType: p.transactionType,
        netAmount: p.net.amount,
        currencyCode: p.net.currencyCode,
      })),
    },
    fetchError: null,
  };
}

function buildAdminUrls(storeHandle: string) {
  return {
    paymentsSettings: `https://admin.shopify.com/store/${storeHandle}/settings/payments`,
    payoutsInAdmin: "https://admin.shopify.com/payments/payouts",
  };
}
