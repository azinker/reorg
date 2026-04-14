export const LOGO_MAP: Record<string, string> = {
  eBay: "/logos/ebay.svg",
  BigCommerce: "/logos/bigcommerce.svg",
  Shopify: "/logos/shopify.svg",
};

export const STORES = [
  { id: "tpp", name: "The Perfect Part", acronym: "TPP", platform: "eBay", apiPlatform: "TPP_EBAY" },
  { id: "tt", name: "Telitetech", acronym: "TT", platform: "eBay", apiPlatform: "TT_EBAY" },
  { id: "bc", name: "BigCommerce", acronym: "BC", platform: "BigCommerce", apiPlatform: "BIGCOMMERCE" },
  { id: "shpfy", name: "Shopify", acronym: "SHPFY", platform: "Shopify", apiPlatform: "SHOPIFY" },
] as const;

export type StoreEntry = (typeof STORES)[number];

export type IntegrationStatus = {
  platform: string;
  label: string;
  enabled: boolean;
  connected: boolean;
  lastSyncAt: string | null;
};

export type SyncPageState = "idle" | "syncing" | "done" | "error";

export type SyncError = { sku: string; message: string };

export type SyncProfile = {
  autoSyncEnabled: boolean;
  timezone: string;
  dayStartHour: number;
  dayEndHour: number;
  dayIntervalMinutes: number;
  overnightIntervalMinutes: number;
  preferredMode: "full" | "incremental";
  fullReconcileIntervalHours: number;
  incrementalStrategy: string;
  skipUpcHydration: boolean;
};

export type IntegrationSyncState = {
  lastRequestedMode: "full" | "incremental" | null;
  lastEffectiveMode: "full" | "incremental" | null;
  lastScheduledSyncAt: string | null;
  lastFullSyncAt: string | null;
  lastIncrementalSyncAt: string | null;
  lastCursor: string | null;
  lastWebhookAt: string | null;
  lastFallbackReason: string | null;
  lastRateLimitAt: string | null;
  lastRateLimitMessage: string | null;
  pendingIncrementalItemIds: string[];
  pendingIncrementalWindowEndedAt: string | null;
};

export type IntegrationWebhookState = {
  destination: string | null;
  topics: string[];
  providerIds: string[];
  lastEnsuredAt: string | null;
  lastEnsureError: string | null;
};

export type SyncJobInfo = {
  id: string;
  status: string;
  itemsProcessed: number;
  itemsCreated: number;
  itemsUpdated: number;
  errors: SyncError[];
  startedAt: string | null;
  completedAt: string | null;
  triggeredBy: string | null;
};

export type RateLimitMethod = {
  name: string;
  count: number;
  limit: number;
  remaining: number;
  reset: string | null;
  timeWindowSeconds: number | null;
  status: "healthy" | "tight" | "exhausted";
};

export type RateLimitsData = {
  fetchedAt: string;
  methods: RateLimitMethod[];
  exhaustedMethods: string[];
  nextResetAt: string | null;
  isDegradedEstimate?: boolean;
  degradedNote?: string;
  isLocallyTracked?: boolean;
};

export type CooldownData = {
  active: boolean;
  until: string | null;
  message: string | null;
  retryLabel: string | null;
};

export type SyncRouteData = {
  integrationId: string;
  platform: string;
  label: string;
  enabled: boolean;
  lastSyncAt: string | null;
  syncProfile: SyncProfile;
  syncState: IntegrationSyncState;
  lastWebhookEvent: {
    topic: string | null;
    status: string | null;
    message: string | null;
    receivedAt: string | null;
    relationToLastSync: "none" | "before_last_pull" | "after_last_pull";
  } | null;
  cooldown: CooldownData;
  rateLimits: RateLimitsData | null;
  quotaPolicy: {
    reservedGetItemCalls: number | null;
  } | null;
  webhookState: IntegrationWebhookState;
  webhookHealth: {
    status: "ok" | "warning" | "info";
    message: string;
    expectedDestination: string | null;
    currentDestination: string | null;
  };
  lastJob: SyncJobInfo | null;
};

export type CompletionTone = "success" | "warning" | "error" | "info";

export type IntegrationHealthItem = {
  integrationId: string;
  label: string;
  platform: string;
  status: "healthy" | "delayed" | "attention";
  combinedStatus: "healthy" | "delayed" | "attention";
  syncStatus: "fresh" | "delayed" | "stale" | "never";
  syncMessage: string;
  lastSyncAt: string | null;
  minutesSinceSync: number | null;
  intervalMinutes: number;
  due: boolean;
  running: boolean;
  nextDueAt: string | null;
  webhookExpected: boolean;
  lastWebhookAt: string | null;
  recentWebhookCount24h: number;
  lastWebhookTopic: string | null;
  lastWebhookMessage: string | null;
  lastWebhookEventStatus: string | null;
  minutesSinceWebhook: number | null;
  webhookStatus: "ok" | "quiet" | "missing" | "n/a";
  webhookMessage: string;
  webhookProofStatus: "none" | "before_last_pull" | "after_last_pull";
  webhookProofMessage: string;
  recommendedAction: string;
};

export type SchedulerStatus = {
  enabled: boolean;
  lastTickAt: string | null;
  lastOutcome: "dry_run" | "completed" | "failed" | null;
  lastDueCount: number;
  lastDispatchedCount: number;
  lastError: string | null;
  runningCount: number;
  dueNowCount: number;
  healthSummary: {
    status: "healthy" | "delayed" | "attention";
    healthyCount: number;
    delayedCount: number;
    attentionCount: number;
    headline: string;
    detail: string;
    recommendedAction: string;
    affectedLabels: string[];
  };
  integrationHealth: IntegrationHealthItem[];
  recentJobs: Array<{
    id: string;
    platform: string;
    label: string;
    mode: string;
    status: string;
    itemsProcessed: number;
    itemsCreated: number;
    itemsUpdated: number;
    startedAt: string | null;
    completedAt: string | null;
    latestStoreSyncAt: string | null;
    recoveredAfterScheduledFailure: boolean;
  }>;
  recentWebhooks: Array<{
    id: string;
    platform: string;
    topic: string;
    status: string;
    message: string;
    receivedAt: string;
  }>;
  upcoming: Array<{
    integrationId: string;
    platform: string;
    label: string;
    due: boolean;
    running: boolean;
    requestedMode: string;
    effectiveMode: string;
    intervalMinutes: number;
    lastScheduledSyncAt: string | null;
    nextDueAt: string | null;
    minutesUntilDue: number | null;
    reason: string;
    fallbackReason: string | null;
  }>;
  automationEvents: Array<{
    id: string;
    type: "scheduler_tick" | "stale_job" | "webhook";
    title: string;
    status: "completed" | "dry_run" | "failed" | "warning" | "ignored" | "debounced" | "running" | "started" | "unknown";
    platform: string | null;
    detail: string;
    occurredAt: string;
  }>;
};
