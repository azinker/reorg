import type { Integration } from "@prisma/client";

export const MONITORED_EBAY_METHODS = [
  "GetSellerEvents",
  "GetItem",
  "GetSellerList",
] as const;

export type MonitoredEbayMethod = (typeof MONITORED_EBAY_METHODS)[number];

export interface EbayMethodRateLimit {
  name: string;
  count: number;
  limit: number;
  remaining: number;
  reset: string | null;
  timeWindowSeconds: number | null;
  status: "healthy" | "tight" | "exhausted";
}

export interface EbayTradingRateLimitSnapshot {
  fetchedAt: string;
  methods: EbayMethodRateLimit[];
  exhaustedMethods: string[];
  nextResetAt: string | null;
}

type EbayCredentialSet = {
  appId: string;
  certId: string;
  environment: "PRODUCTION" | "SANDBOX";
};

type CacheEntry = {
  expiresAt: number;
  snapshot: EbayTradingRateLimitSnapshot;
};

type TokenCacheEntry = {
  expiresAt: number;
  accessToken: string;
};

const SNAPSHOT_CACHE_TTL_MS = 60_000;

const snapshotCache = new Map<string, CacheEntry>();
const tokenCache = new Map<string, TokenCacheEntry>();

function getBaseUrl(environment: EbayCredentialSet["environment"]) {
  return environment === "SANDBOX"
    ? "https://api.sandbox.ebay.com"
    : "https://api.ebay.com";
}

function getCacheKey(credentials: EbayCredentialSet) {
  return `${credentials.environment}:${credentials.appId}:${credentials.certId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNullableString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toStatus(remaining: number, limit: number): EbayMethodRateLimit["status"] {
  if (remaining <= 0) return "exhausted";
  if (limit > 0 && remaining / limit <= 0.1) return "tight";
  return "healthy";
}

async function getClientCredentialsToken(credentials: EbayCredentialSet) {
  const cacheKey = getCacheKey(credentials);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const basicAuth = Buffer.from(
    `${credentials.appId}:${credentials.certId}`,
  ).toString("base64");
  const baseUrl = getBaseUrl(credentials.environment);
  const response = await fetch(`${baseUrl}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });

  if (!response.ok) {
    throw new Error(`eBay Analytics token request failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token || typeof payload.expires_in !== "number") {
    throw new Error("eBay Analytics token response was missing access token data.");
  }

  tokenCache.set(cacheKey, {
    accessToken: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
  });

  return payload.access_token;
}

function extractCredentials(integration: Pick<Integration, "config">): EbayCredentialSet | null {
  if (!isRecord(integration.config)) return null;
  const appId = asNullableString(integration.config.appId);
  const certId = asNullableString(integration.config.certId);
  const environment =
    integration.config.environment === "SANDBOX" ? "SANDBOX" : "PRODUCTION";

  if (!appId || !certId) return null;

  return {
    appId,
    certId,
    environment,
  };
}

function pickMonitoredMethod(resourceName: string | null) {
  if (!resourceName) return null;
  return (
    MONITORED_EBAY_METHODS.find(
      (method) =>
        resourceName === method ||
        resourceName.endsWith(`.${method}`) ||
        resourceName.includes(method),
    ) ?? null
  );
}

export async function getEbayTradingRateLimitSnapshotForIntegration(
  integration: Pick<Integration, "config">,
) {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return null;
  }

  const credentials = extractCredentials(integration);
  if (!credentials) return null;

  const cacheKey = getCacheKey(credentials);
  const cached = snapshotCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.snapshot;
  }

  const token = await getClientCredentialsToken(credentials);
  const baseUrl = getBaseUrl(credentials.environment);
  const response = await fetch(
    `${baseUrl}/developer/analytics/v1_beta/rate_limit?api_name=tradingapi&api_context=tradingapi`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`eBay Analytics getRateLimits failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    rateLimits?: Array<{
      resources?: Array<{
        name?: string;
        rates?: Array<{
          count?: number;
          limit?: number;
          remaining?: number;
          reset?: string;
          timeWindow?: number;
        }>;
      }>;
    }>;
  };

  const methodMap = new Map<string, EbayMethodRateLimit>();

  for (const rateLimit of payload.rateLimits ?? []) {
    for (const resource of rateLimit.resources ?? []) {
      const method = pickMonitoredMethod(asNullableString(resource.name));
      if (!method) continue;

      const rate = resource.rates?.[0];
      if (!rate) continue;

      const count = asNumber(rate.count);
      const limit = asNumber(rate.limit);
      const remaining = asNumber(rate.remaining);
      const reset = asNullableString(rate.reset);

      methodMap.set(method, {
        name: method,
        count,
        limit,
        remaining,
        reset,
        timeWindowSeconds:
          typeof rate.timeWindow === "number" ? rate.timeWindow : null,
        status: toStatus(remaining, limit),
      });
    }
  }

  const methods = MONITORED_EBAY_METHODS.map(
    (method) =>
      methodMap.get(method) ?? {
        name: method,
        count: 0,
        limit: 0,
        remaining: 0,
        reset: null,
        timeWindowSeconds: null,
        status: "healthy" as const,
      },
  );

  const exhaustedMethods = methods
    .filter((method) => method.status === "exhausted" && method.reset)
    .map((method) => method.name);
  const resetCandidates = methods
    .filter((method) => method.status === "exhausted" && method.reset)
    .map((method) => new Date(method.reset as string))
    .filter((value) => !Number.isNaN(value.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());

  const snapshot: EbayTradingRateLimitSnapshot = {
    fetchedAt: new Date().toISOString(),
    methods,
    exhaustedMethods,
    nextResetAt: resetCandidates[0]?.toISOString() ?? null,
  };

  snapshotCache.set(cacheKey, {
    snapshot,
    expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS,
  });

  return snapshot;
}

export function getRelevantMonitoredEbayMethods(message: string | null | undefined) {
  const normalized = message?.toLowerCase() ?? "";
  if (normalized.includes("getsellerevents")) return ["GetSellerEvents"] as const;
  if (normalized.includes("getitem")) return ["GetItem"] as const;
  if (normalized.includes("getsellerlist")) return ["GetSellerList"] as const;
  return [...MONITORED_EBAY_METHODS];
}

export function getEbayCooldownUntilFromSnapshot(
  snapshot: EbayTradingRateLimitSnapshot | null,
  message: string | null | undefined,
  now = new Date(),
) {
  if (!snapshot) return null;
  const relevantMethods = new Set(getRelevantMonitoredEbayMethods(message));
  const resets = snapshot.methods
    .filter(
      (method) =>
        relevantMethods.has(method.name as MonitoredEbayMethod) &&
        method.status === "exhausted" &&
        method.reset,
    )
    .map((method) => new Date(method.reset as string))
    .filter((value) => !Number.isNaN(value.getTime()) && value.getTime() > now.getTime())
    .sort((a, b) => b.getTime() - a.getTime());

  if (resets.length > 0) return resets[0];

  const fallbackResets = snapshot.methods
    .filter((method) => method.status === "exhausted" && method.reset)
    .map((method) => new Date(method.reset as string))
    .filter((value) => !Number.isNaN(value.getTime()) && value.getTime() > now.getTime())
    .sort((a, b) => b.getTime() - a.getTime());

  return fallbackResets[0] ?? null;
}
