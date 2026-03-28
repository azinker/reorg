import { XMLParser } from "fast-xml-parser";
import type { Integration } from "@prisma/client";

export const MONITORED_EBAY_METHODS = [
  "GetSellerEvents",
  "GetItem",
  "GetSellerList",
  "ReviseFixedPriceItem",
] as const;

export type MonitoredEbayMethod = (typeof MONITORED_EBAY_METHODS)[number];

export const EBAY_LOCAL_QUOTA_BAR_EXPLANATION =
  "These counts are tracked by reorG, not eBay. They show calls made through this app today.";

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
  /** True when live GetApiAccessRules failed but UI shows a GetItem-only cooldown estimate */
  isDegradedEstimate?: boolean;
  degradedNote?: string;
  /** True when counts come from local call tracking, not eBay's GetApiAccessRules */
  isLocallyTracked?: boolean;
}

export interface LocalEbayApiUsage {
  date: string;
  GetItem: number;
  GetSellerList: number;
  GetSellerEvents: number;
  ReviseFixedPriceItem: number;
}

type FullEbayCredentials = {
  appId: string;
  certId: string;
  refreshToken: string;
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

const SNAPSHOT_CACHE_TTL_MS = 90_000;
const FALLBACK_CACHE_TTL_MS = 30 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 60_000;
const SITE_ID = "0";
const COMPAT_LEVEL = "1113";

const snapshotCache = new Map<string, CacheEntry>();
const fallbackSnapshotCache = new Map<string, CacheEntry>();
const tokenCache = new Map<string, TokenCacheEntry>();
let lastGetApiAccessRulesFailure: { at: number; status: number } | null = null;

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  isArray: (tagName) => tagName === "ApiAccessRule",
});

function getBaseUrl(environment: FullEbayCredentials["environment"]) {
  return environment === "SANDBOX"
    ? "https://api.sandbox.ebay.com"
    : "https://api.ebay.com";
}

function getTradingUrl(environment: FullEbayCredentials["environment"]) {
  return environment === "SANDBOX"
    ? "https://api.sandbox.ebay.com/ws/api.dll"
    : "https://api.ebay.com/ws/api.dll";
}

function getCacheKey(credentials: FullEbayCredentials) {
  return `${credentials.environment}:${credentials.appId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNullableString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toStatus(remaining: number, limit: number): EbayMethodRateLimit["status"] {
  if (remaining <= 0) return "exhausted";
  if (limit > 0 && remaining / limit <= 0.1) return "tight";
  return "healthy";
}

async function getUserAccessToken(credentials: FullEbayCredentials) {
  const cacheKey = `user:${getCacheKey(credentials)}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const basicAuth = Buffer.from(
    `${credentials.appId}:${credentials.certId}`,
  ).toString("base64");
  const baseUrl = getBaseUrl(credentials.environment);
  const ac = new AbortController();
  const abortTimer = setTimeout(() => ac.abort(), 8_000);
  let bodyText: string;
  let ok: boolean;
  let status: number;
  try {
    const response = await fetch(`${baseUrl}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
      }),
      signal: ac.signal,
    });
    bodyText = await response.text();
    ok = response.ok;
    status = response.status;
  } finally {
    clearTimeout(abortTimer);
  }

  if (!ok) {
    throw new Error(`eBay token refresh failed: ${status} — ${bodyText.slice(0, 200)}`);
  }

  const payload = JSON.parse(bodyText) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token || typeof payload.expires_in !== "number") {
    throw new Error("eBay token response missing access_token.");
  }

  tokenCache.set(cacheKey, {
    accessToken: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
  });

  return payload.access_token;
}

function extractFullCredentials(integration: Pick<Integration, "config">): FullEbayCredentials | null {
  if (!isRecord(integration.config)) return null;
  const appId = asNullableString(integration.config.appId);
  const certId = asNullableString(integration.config.certId);
  const refreshToken = asNullableString(integration.config.refreshToken);
  const environment =
    integration.config.environment === "SANDBOX" ? "SANDBOX" : "PRODUCTION";

  if (!appId || !certId || !refreshToken) return null;

  return { appId, certId, refreshToken, environment };
}

export function getEbayCredentialFingerprint(
  integration: Pick<Integration, "config">,
) {
  const credentials = extractFullCredentials(integration);
  return credentials ? getCacheKey(credentials) : null;
}

/**
 * Evict the snapshot cache for an integration so the next call to
 * `getEbayTradingRateLimitSnapshotForIntegration` fetches live data.
 * Call this after any eBay sync that consumed API quota.
 */
export function invalidateEbayRateLimitSnapshotCache(
  integration: Pick<Integration, "config">,
): void {
  const credentials = extractFullCredentials(integration);
  if (!credentials) return;
  const key = getCacheKey(credentials);
  snapshotCache.delete(key);
  lastGetApiAccessRulesFailure = null;
}

/**
 * Shown when GetApiAccessRules is unavailable but we know GetItem is in a
 * cooldown window. All non-GetItem method counts are shown as UNKNOWN (limit 0)
 * because GetApiAccessRules failing means we genuinely cannot determine their
 * usage — ReviseFixedPriceItem, GetSellerList, and GetSellerEvents may each
 * also be exhausted. Never show fake ~0 values that imply available quota.
 */
export function buildGetItemCooldownRateLimitsSnapshot(cooldownUntil: Date): EbayTradingRateLimitSnapshot {
  const resetIso = cooldownUntil.toISOString();
  return {
    fetchedAt: new Date().toISOString(),
    methods: MONITORED_EBAY_METHODS.map((name) => ({
      name,
      // limit=0 signals "unknown" to the UI so it renders "—" instead of a fake count
      count: name === "GetItem" ? EBAY_DAILY_LIMIT : 0,
      limit: name === "GetItem" ? EBAY_DAILY_LIMIT : 0,
      remaining: 0,
      reset: resetIso,
      timeWindowSeconds: 86400,
      status: (name === "GetItem" ? "exhausted" : "healthy") as EbayMethodRateLimit["status"],
    })),
    exhaustedMethods: ["GetItem"],
    nextResetAt: resetIso,
    isDegradedEstimate: true,
    degradedNote:
      "GetItem is over quota. Other method counts are unknown until the quota resets.",
  };
}

function buildServiceUnavailableSnapshot(): EbayTradingRateLimitSnapshot {
  return {
    fetchedAt: new Date().toISOString(),
    methods: MONITORED_EBAY_METHODS.map((name) => ({
      name,
      count: 0,
      limit: 0,
      remaining: 0,
      reset: null,
      timeWindowSeconds: 86400,
      status: "healthy" as EbayMethodRateLimit["status"],
    })),
    exhaustedMethods: [],
    nextResetAt: null,
    isDegradedEstimate: true,
    degradedNote: "Credit counts are temporarily unavailable from eBay. Syncs still work — counts will appear shortly.",
  };
}

function buildSnapshotFromRules(rules: unknown[], cacheKey: string): EbayTradingRateLimitSnapshot {
  const monitoredSet = new Set<string>(MONITORED_EBAY_METHODS);
  const methodMap = new Map<string, EbayMethodRateLimit>();

  for (const rule of rules) {
    if (!isRecord(rule)) continue;
    const callName = String(rule.CallName ?? "");
    if (!monitoredSet.has(callName)) continue;
    const dailyLimit = Number(rule.DailyHardLimit) || 0;
    const dailyUsage = Number(rule.DailyUsage) || 0;
    const remaining = Math.max(0, dailyLimit - dailyUsage);
    const periodicEnd = asNullableString(rule.PeriodicEndDate as string);
    methodMap.set(callName, {
      name: callName,
      count: dailyUsage,
      limit: dailyLimit,
      remaining,
      reset: periodicEnd,
      timeWindowSeconds: 86400,
      status: toStatus(remaining, dailyLimit),
    });
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
    .filter((m) => m.status === "exhausted" && m.reset)
    .map((m) => m.name);
  const resetCandidates = methods
    .filter((m) => m.status === "exhausted" && m.reset)
    .map((m) => new Date(m.reset as string))
    .filter((v) => !Number.isNaN(v.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());

  const snapshot: EbayTradingRateLimitSnapshot = {
    fetchedAt: new Date().toISOString(),
    methods,
    exhaustedMethods,
    nextResetAt: resetCandidates[0]?.toISOString() ?? null,
  };

  lastGetApiAccessRulesFailure = null;

  snapshotCache.set(cacheKey, {
    snapshot,
    expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS,
  });
  fallbackSnapshotCache.set(cacheKey, {
    snapshot,
    expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS,
  });

  return snapshot;
}

function readSavedSnapshotFromConfig(
  integration: Pick<Integration, "config">,
): EbayTradingRateLimitSnapshot | null {
  const configRecord = isRecord(integration.config) ? integration.config : null;
  if (!configRecord) return null;
  const syncState = isRecord(configRecord.syncState) ? configRecord.syncState : null;
  if (!syncState) return null;
  return deserializeSnapshotFromConfig(syncState.lastRateLimitSnapshot);
}

export async function getEbayTradingRateLimitSnapshotForIntegration(
  integration: Pick<Integration, "config">,
): Promise<EbayTradingRateLimitSnapshot | null> {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return null;
  }

  // Short-circuit if eBay's GetApiAccessRules recently returned 503/5xx.
  // Fall back to the DB-persisted snapshot saved after the last sync.
  if (
    lastGetApiAccessRulesFailure &&
    Date.now() - lastGetApiAccessRulesFailure.at < NEGATIVE_CACHE_TTL_MS
  ) {
    const savedSnapshot = readSavedSnapshotFromConfig(integration);
    if (savedSnapshot) return savedSnapshot;
    return buildServiceUnavailableSnapshot();
  }

  const credentials = extractFullCredentials(integration);
  if (!credentials) return null;

  const cacheKey = getCacheKey(credentials);
  const cached = snapshotCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.snapshot;
  }

  try {
    const configRecord = integration.config as Record<string, unknown>;
    const storedToken = typeof configRecord.accessToken === "string" ? configRecord.accessToken : null;
    const storedExpiry = typeof configRecord.accessTokenExpiresAt === "number" ? configRecord.accessTokenExpiresAt : 0;
    const tradingUrl = getTradingUrl(credentials.environment);

    const tryGetApiAccessRules = async (token: string): Promise<{ ok: boolean; status: number; body: string }> => {
      const reqBody = `<?xml version="1.0" encoding="utf-8"?>
<GetApiAccessRulesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
</GetApiAccessRulesRequest>`;
      const ac = new AbortController();
      const abortTimer = setTimeout(() => ac.abort(), 8_000);
      try {
        const resp = await fetch(tradingUrl, {
          method: "POST",
          headers: {
            "X-EBAY-API-IAF-TOKEN": token,
            "X-EBAY-API-SITEID": SITE_ID,
            "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
            "X-EBAY-API-CALL-NAME": "GetApiAccessRules",
            "Content-Type": "text/xml",
          },
          body: reqBody,
          signal: ac.signal,
        });
        const body = await resp.text();
        return { ok: resp.ok, status: resp.status, body };
      } finally {
        clearTimeout(abortTimer);
      }
    };

    let usedStoredToken = false;
    let token: string;
    if (storedToken && storedExpiry > Date.now() + 60_000) {
      token = storedToken;
      usedStoredToken = true;
    } else {
      token = await getUserAccessToken(credentials);
    }

    let result = await tryGetApiAccessRules(token);

    if (!result.ok && usedStoredToken) {
      token = await getUserAccessToken(credentials);
      result = await tryGetApiAccessRules(token);
    }

    if (!result.ok) {
      if (result.status >= 500) {
        lastGetApiAccessRulesFailure = { at: Date.now(), status: result.status };
      }
      throw new Error(`GetApiAccessRules failed: ${result.status}`);
    }

    const parsed = xmlParser.parse(result.body);
    const apiResponse = parsed?.GetApiAccessRulesResponse;
    const ack =
      apiResponse && typeof apiResponse === "object"
        ? String((apiResponse as Record<string, unknown>).Ack ?? "")
        : "";
    if (ack === "Failure") {
      if (usedStoredToken) {
        token = await getUserAccessToken(credentials);
        const retryResult = await tryGetApiAccessRules(token);
        if (retryResult.ok) {
          const retryParsed = xmlParser.parse(retryResult.body);
          const retryApi = retryParsed?.GetApiAccessRulesResponse;
          const retryAck = retryApi && typeof retryApi === "object"
            ? String((retryApi as Record<string, unknown>).Ack ?? "")
            : "";
          if (retryAck !== "Failure") {
            const retryRules: unknown[] = retryApi?.ApiAccessRule ?? [];
            return buildSnapshotFromRules(retryRules, cacheKey);
          }
        }
      }
      throw new Error("GetApiAccessRules Ack=Failure");
    }
    const rules: unknown[] = apiResponse?.ApiAccessRule ?? [];
    return buildSnapshotFromRules(rules, cacheKey);
  } catch (error) {
    const errMsg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[ebay-analytics] GetApiAccessRules failed for cacheKey=${cacheKey.slice(0, 8)}…: ${errMsg}`);
    const fallback = fallbackSnapshotCache.get(cacheKey);
    if (fallback && fallback.expiresAt > Date.now()) {
      return {
        ...fallback.snapshot,
        isDegradedEstimate: true,
        degradedNote: "Using recent counts. Live refresh will retry shortly.",
      };
    }
    // Try the DB-persisted snapshot saved after the last sync
    const savedSnapshot = readSavedSnapshotFromConfig(integration);
    if (savedSnapshot) return savedSnapshot;
    console.warn("[ebay-analytics] No fallback snapshot available, returning Unknown placeholder");
    return {
      fetchedAt: new Date().toISOString(),
      methods: MONITORED_EBAY_METHODS.map((name) => ({
        name,
        count: 0,
        limit: 0,
        remaining: 0,
        reset: null,
        timeWindowSeconds: 86400,
        status: "healthy" as EbayMethodRateLimit["status"],
      })),
      exhaustedMethods: [],
      nextResetAt: null,
      isDegradedEstimate: true,
      degradedNote: "Could not load credit counts. Will retry automatically.",
    };
  }
}

/**
 * Fetch rate-limit snapshot using an ALREADY-VALID access token.
 * Use this from sync functions that have their own working token — it
 * bypasses the analytics module's `getUserAccessToken` (which may fail
 * on serverless cold-starts or when the eBay token endpoint is slow).
 */
export async function fetchRateLimitSnapshotWithToken(
  accessToken: string,
): Promise<EbayTradingRateLimitSnapshot | null> {

  const SYNC_COMPAT = "1199";
  try {
    const tradingUrl = "https://api.ebay.com/ws/api.dll";
    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetApiAccessRulesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
</GetApiAccessRulesRequest>`;

    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), 15_000);
    let xml: string;
    let ok: boolean;
    let status: number;
    try {
      const response = await fetch(tradingUrl, {
        method: "POST",
        headers: {
          "X-EBAY-API-IAF-TOKEN": accessToken,
          "X-EBAY-API-SITEID": "0",
          "X-EBAY-API-COMPATIBILITY-LEVEL": SYNC_COMPAT,
          "X-EBAY-API-CALL-NAME": "GetApiAccessRules",
          "Content-Type": "text/xml",
        },
        body,
        signal: ac.signal,
      });
      xml = await response.text();
      ok = response.ok;
      status = response.status;
    } finally {
      clearTimeout(abortTimer);
    }

    if (!ok) {
      if (status >= 500) {
        lastGetApiAccessRulesFailure = { at: Date.now(), status };
      }
      return null;
    }

    const parsed = xmlParser.parse(xml);
    const apiResponse = parsed?.GetApiAccessRulesResponse;
    const ack =
      apiResponse && typeof apiResponse === "object"
        ? String((apiResponse as Record<string, unknown>).Ack ?? "")
        : "";
    if (ack === "Failure") return null;

    const rules: unknown[] = apiResponse?.ApiAccessRule ?? [];

    const monitoredSet = new Set<string>(MONITORED_EBAY_METHODS);
    const methodMap = new Map<string, EbayMethodRateLimit>();

    for (const rule of rules) {
      if (!isRecord(rule)) continue;
      const callName = String(rule.CallName ?? "");
      if (!monitoredSet.has(callName)) continue;
      const dailyLimit = Number(rule.DailyHardLimit) || 0;
      const dailyUsage = Number(rule.DailyUsage) || 0;
      const remaining = Math.max(0, dailyLimit - dailyUsage);
      const periodicEnd = asNullableString(rule.PeriodicEndDate as string);
      methodMap.set(callName, {
        name: callName,
        count: dailyUsage,
        limit: dailyLimit,
        remaining,
        reset: periodicEnd,
        timeWindowSeconds: 86400,
        status: toStatus(remaining, dailyLimit),
      });
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
      .filter((m) => m.status === "exhausted" && m.reset)
      .map((m) => m.name);
    const resetCandidates = methods
      .filter((m) => m.status === "exhausted" && m.reset)
      .map((m) => new Date(m.reset as string))
      .filter((v) => !Number.isNaN(v.getTime()))
      .sort((a, b) => b.getTime() - a.getTime());

    const snapshot: EbayTradingRateLimitSnapshot = {
      fetchedAt: new Date().toISOString(),
      methods,
      exhaustedMethods,
      nextResetAt: resetCandidates[0]?.toISOString() ?? null,
    };

    lastGetApiAccessRulesFailure = null;
    return snapshot;
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[ebay-analytics] fetchRateLimitSnapshotWithToken FAILED: ${msg}`);
    return null;
  }
}

/** Persist last successful snapshot to integration config for cold-start recovery. */
export function serializeSnapshotForConfig(
  snapshot: EbayTradingRateLimitSnapshot,
): Record<string, unknown> {
  return {
    fetchedAt: snapshot.fetchedAt,
    methods: snapshot.methods,
    exhaustedMethods: snapshot.exhaustedMethods,
    nextResetAt: snapshot.nextResetAt,
    isLocallyTracked: snapshot.isLocallyTracked ?? false,
  };
}

/** Recover a snapshot from integration config. */
export function deserializeSnapshotFromConfig(
  raw: unknown,
): EbayTradingRateLimitSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.fetchedAt !== "string" || !Array.isArray(obj.methods)) return null;
  const age = Date.now() - new Date(obj.fetchedAt).getTime();
  const maxAge = obj.isLocallyTracked === true ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  if (age > maxAge) return null;
  const isLocal = obj.isLocallyTracked === true;
  return {
    fetchedAt: obj.fetchedAt,
    methods: obj.methods as EbayMethodRateLimit[],
    exhaustedMethods: Array.isArray(obj.exhaustedMethods) ? obj.exhaustedMethods as string[] : [],
    nextResetAt: typeof obj.nextResetAt === "string" ? obj.nextResetAt : null,
    isDegradedEstimate: true,
    isLocallyTracked: isLocal,
    degradedNote: isLocal
      ? EBAY_LOCAL_QUOTA_BAR_EXPLANATION
      : "Using saved counts. Live data will load on next refresh.",
  };
}

export function getRelevantMonitoredEbayMethods(message: string | null | undefined) {
  const normalized = message?.toLowerCase() ?? "";
  if (normalized.includes("getsellerevents")) return ["GetSellerEvents"] as const;
  if (normalized.includes("getitem")) return ["GetItem"] as const;
  if (normalized.includes("getsellerlist")) return ["GetSellerList"] as const;
  return [...MONITORED_EBAY_METHODS];
}

export function getEbayMethodRate(
  snapshot: EbayTradingRateLimitSnapshot | null,
  method: MonitoredEbayMethod,
) {
  return snapshot?.methods.find((entry) => entry.name === method) ?? null;
}

export function buildEbayQuotaExhaustedMessage(
  method: MonitoredEbayMethod,
  snapshot: EbayTradingRateLimitSnapshot | null,
) {
  const rate = getEbayMethodRate(snapshot, method);
  const resetLabel = rate?.reset
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "America/New_York",
        timeZoneName: "short",
      }).format(new Date(rate.reset))
    : null;

  return resetLabel
    ? `${method} is out of eBay Trading API calls until about ${resetLabel}.`
    : `${method} is out of eBay Trading API calls until the next eBay reset window.`;
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

const EBAY_DAILY_LIMIT = 50_000;

/**
 * Merge the current sync's API call counts into the cumulative daily tracker.
 * Resets to zero when the date (America/New_York) changes.
 */
export function mergeSyncCallsIntoLocalUsage(
  existing: LocalEbayApiUsage | null | undefined,
  delta: Partial<Record<MonitoredEbayMethod, number>>,
): LocalEbayApiUsage {
  const todayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());

  const base: LocalEbayApiUsage =
    existing && existing.date === todayET
      ? { ...existing }
      : { date: todayET, GetItem: 0, GetSellerList: 0, GetSellerEvents: 0, ReviseFixedPriceItem: 0 };

  for (const [key, value] of Object.entries(delta)) {
    if (key in base && typeof value === "number") {
      const current = (base as unknown as Record<string, number>)[key] ?? 0;
      (base as unknown as Record<string, number>)[key] = Math.max(current, value);
    }
  }
  return base;
}

/**
 * Build a rate-limit snapshot from locally tracked API call counts.
 * Used as fallback when eBay's GetApiAccessRules is unreachable (e.g. 503).
 */
export function buildLocallyTrackedSnapshot(
  usage: LocalEbayApiUsage,
): EbayTradingRateLimitSnapshot {
  const methods: EbayMethodRateLimit[] = MONITORED_EBAY_METHODS.map((name) => {
    const count = usage[name] ?? 0;
    const remaining = Math.max(0, EBAY_DAILY_LIMIT - count);
    let status: EbayMethodRateLimit["status"] = "healthy";
    if (remaining === 0) status = "exhausted";
    else if (remaining < EBAY_DAILY_LIMIT * 0.1) status = "tight";
    return { name, count, limit: EBAY_DAILY_LIMIT, remaining, reset: null, timeWindowSeconds: 86400, status };
  });

  return {
    fetchedAt: new Date().toISOString(),
    methods,
    exhaustedMethods: methods.filter((m) => m.status === "exhausted").map((m) => m.name),
    nextResetAt: null,
    isDegradedEstimate: true,
    isLocallyTracked: true,
    degradedNote: EBAY_LOCAL_QUOTA_BAR_EXPLANATION,
  };
}
