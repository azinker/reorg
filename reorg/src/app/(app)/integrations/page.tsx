"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  Plug,
  Crown,
  Lock,
  Unlock,
  CheckCircle,
  XCircle,
  Settings2,
  Zap,
  Link2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";

const PLATFORM_TO_CARD: Record<string, string> = {
  TPP_EBAY: "tpp",
  TT_EBAY: "tt",
  BIGCOMMERCE: "bc",
  SHOPIFY: "shpfy",
};

const CARD_TO_PLATFORM: Record<string, string> = {
  tpp: "TPP_EBAY",
  tt: "TT_EBAY",
  bc: "BIGCOMMERCE",
  shpfy: "SHOPIFY",
};

const LOGO_MAP: Record<string, string> = {
  eBay: "/logos/ebay.svg",
  BigCommerce: "/logos/bigcommerce.svg",
  Shopify: "/logos/shopify.svg",
};

const integrations = [
  {
    id: "tpp",
    name: "TPP eBay",
    subtitle: "The Perfect Part",
    acronym: "TPP",
    platform: "eBay",
    theme: "blue" as const,
    isMaster: true,
  },
  {
    id: "tt",
    name: "TT eBay",
    subtitle: "Telitetech",
    acronym: "TT",
    platform: "eBay",
    theme: "emerald" as const,
    isMaster: false,
  },
  {
    id: "bc",
    name: "BigCommerce",
    subtitle: null,
    acronym: "BC",
    platform: "BigCommerce",
    theme: "orange" as const,
    isMaster: false,
  },
  {
    id: "shpfy",
    name: "Shopify",
    subtitle: null,
    acronym: "SHPFY",
    platform: "Shopify",
    theme: "lime" as const,
    isMaster: false,
  },
] as const;

const themeClasses = {
  blue: {
    badge:
      "bg-blue-500/15 text-blue-400 border-blue-500/30 dark:bg-blue-500/20 dark:text-blue-400 dark:border-blue-500/40",
  },
  emerald: {
    badge:
      "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 dark:bg-emerald-500/20 dark:text-emerald-400 dark:border-emerald-500/40",
  },
  orange: {
    badge:
      "bg-orange-500/15 text-orange-400 border-orange-500/30 dark:bg-orange-500/20 dark:text-orange-400 dark:border-orange-500/40",
  },
  lime: {
    badge:
      "bg-lime-500/15 text-lime-400 border-lime-500/30 dark:bg-lime-500/20 dark:text-lime-400 dark:border-lime-500/40",
  },
} as const;

type IntegrationSnapshot = {
  platform: string;
  connected: boolean;
  writeLocked: boolean;
  lastSyncAt: string | null;
  accountUserId: string | null;
  accountStoreName: string | null;
  accountSellerLevel: string | null;
  storeHash: string | null;
  storeDomain: string | null;
  environment: string | null;
};

function formatLastSync(value: string | null): string {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Never";
  return parsed.toLocaleString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function IntegrationsContent() {
  const searchParams = useSearchParams();
  const [writeLocks, setWriteLocks] = useState<Record<string, boolean>>({
    tpp: true,
    tt: true,
    bc: true,
    shpfy: true,
  });
  const [connected, setConnected] = useState<Record<string, boolean>>({
    tpp: false,
    tt: false,
    bc: false,
    shpfy: false,
  });
  const [banner, setBanner] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [testing, setTesting] = useState<Record<string, boolean>>({
    tpp: false,
    tt: false,
    bc: false,
    shpfy: false,
  });
  const [integrationMeta, setIntegrationMeta] = useState<Record<string, IntegrationSnapshot>>({});

  useEffect(() => {
    fetch("/api/integrations")
      .then((res) => res.ok ? res.json() : { data: [] })
      .then((json) => {
        const nextConnected: Record<string, boolean> = {};
        const nextLocks: Record<string, boolean> = {};
        const nextMeta: Record<string, IntegrationSnapshot> = {};
        for (const i of json.data ?? []) {
          const id = PLATFORM_TO_CARD[i.platform];
          if (id) {
            nextConnected[id] = !!i.connected;
            nextLocks[id] = !!i.writeLocked;
            nextMeta[id] = {
              platform: i.platform,
              connected: !!i.connected,
              writeLocked: !!i.writeLocked,
              lastSyncAt: typeof i.lastSyncAt === "string" ? i.lastSyncAt : null,
              accountUserId: typeof i.accountUserId === "string" ? i.accountUserId : null,
              accountStoreName: typeof i.accountStoreName === "string" ? i.accountStoreName : null,
              accountSellerLevel: typeof i.accountSellerLevel === "string" ? i.accountSellerLevel : null,
              storeHash: typeof i.storeHash === "string" ? i.storeHash : null,
              storeDomain: typeof i.storeDomain === "string" ? i.storeDomain : null,
              environment: typeof i.environment === "string" ? i.environment : null,
            };
          }
        }
        setConnected((prev) => ({ ...prev, ...nextConnected }));
        setWriteLocks((prev) => ({ ...prev, ...nextLocks }));
        setIntegrationMeta(nextMeta);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const shopify = searchParams.get("shopify");
    const ebay = searchParams.get("ebay");
    const message = searchParams.get("message");
    if (shopify === "connected") {
      setBanner({ type: "success", message: "Shopify connected. You can sync products now." });
      setConnected((prev) => ({ ...prev, shpfy: true }));
      window.history.replaceState({}, "", "/integrations");
    } else if (shopify === "error") {
      setBanner({ type: "error", message: message ? decodeURIComponent(message) : "Shopify connection failed." });
      window.history.replaceState({}, "", "/integrations");
    } else if (ebay === "connected") {
      const store = searchParams.get("store") || "tpp";
      setBanner({ type: "success", message: store === "tt" ? "eBay TT connected." : "eBay TPP (master) connected. You can sync listings now." });
      setConnected((prev) => ({ ...prev, [store === "tt" ? "tt" : "tpp"]: true }));
      window.history.replaceState({}, "", "/integrations");
    } else if (ebay === "error") {
      setBanner({ type: "error", message: message ? decodeURIComponent(message) : "eBay connection failed." });
      window.history.replaceState({}, "", "/integrations");
    }
  }, [searchParams]);

  const connectedCount = Object.values(connected).filter(Boolean).length;
  const tppSeller = integrationMeta.tpp?.accountUserId?.trim().toLowerCase() ?? null;
  const ttSeller = integrationMeta.tt?.accountUserId?.trim().toLowerCase() ?? null;
  const hasDuplicateEbaySeller = !!tppSeller && !!ttSeller && tppSeller === ttSeller;

  const toggleWriteLock = async (id: string) => {
    const platform = CARD_TO_PLATFORM[id];
    if (!platform) return;
    const nextLocked = !writeLocks[id];
    setWriteLocks((prev) => ({ ...prev, [id]: nextLocked }));
    try {
      const res = await fetch(`/api/integrations/${platform}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ writeLocked: nextLocked }),
      });
      if (!res.ok) {
        setWriteLocks((prev) => ({ ...prev, [id]: !nextLocked }));
        setBanner({ type: "error", message: "Failed to update write lock." });
      }
    } catch {
      setWriteLocks((prev) => ({ ...prev, [id]: !nextLocked }));
      setBanner({ type: "error", message: "Failed to update write lock." });
    }
  };

  const testConnection = async (id: string) => {
    const platform = CARD_TO_PLATFORM[id];
    if (!platform) return;

    setTesting((prev) => ({ ...prev, [id]: true }));
    setBanner(null);

    try {
      const res = await fetch(`/api/integrations/${platform}/test`, {
        method: "POST",
      });
      const json = await res.json();
      const ok = !!json.data?.ok;
      const message = typeof json.data?.message === "string"
        ? json.data.message
        : ok
          ? "Connection successful."
          : "Connection failed.";

      if (ok && (platform === "TPP_EBAY" || platform === "TT_EBAY")) {
        const seller = json.data?.seller;
        setIntegrationMeta((prev) => ({
          ...prev,
          [id]: {
            platform,
            connected: true,
            writeLocked: writeLocks[id] ?? true,
            lastSyncAt: prev[id]?.lastSyncAt ?? null,
            accountUserId: typeof seller?.userId === "string" ? seller.userId : prev[id]?.accountUserId ?? null,
            accountStoreName: typeof seller?.storeName === "string" ? seller.storeName : prev[id]?.accountStoreName ?? null,
            accountSellerLevel:
              typeof seller?.sellerLevel === "string" ? seller.sellerLevel : prev[id]?.accountSellerLevel ?? null,
            storeHash: prev[id]?.storeHash ?? null,
            storeDomain: prev[id]?.storeDomain ?? null,
            environment: prev[id]?.environment ?? null,
          },
        }));
      }

      setBanner({
        type: ok ? "success" : "error",
        message: `${integrations.find((item) => item.id === id)?.name ?? "Integration"}: ${message}`,
      });

      if (ok) {
        setConnected((prev) => ({ ...prev, [id]: true }));
      }
    } catch {
      setBanner({
        type: "error",
        message: `${integrations.find((item) => item.id === id)?.name ?? "Integration"}: Connection test failed.`,
      });
    } finally {
      setTesting((prev) => ({ ...prev, [id]: false }));
    }
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6" data-tour="integrations-header">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Integrations
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage marketplace connections, API tokens, and write locks
        </p>
      </div>

      {/* Shopify OAuth success/error banner */}
      {banner && (
        <div
          className={cn(
            "mb-6 rounded-lg border px-4 py-3",
            banner.type === "success"
              ? "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400"
              : "border-destructive/40 bg-destructive/10 text-destructive"
          )}
        >
          {banner.message}
        </div>
      )}

      {/* Summary bar */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Plug
              className="h-5 w-5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="text-sm font-medium text-foreground">
              {connectedCount} of {integrations.length} connected
            </span>
          </div>
          <div className="h-2 w-32 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300 ease-in-out"
              style={{
                width: `${(connectedCount / integrations.length) * 100}%`,
              }}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2" data-tour="integrations-global-lock">
          <Lock className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
          <p className="text-sm text-amber-700 dark:text-amber-400">
            Per-integration write locks block writes only for that store. For a full block, use Global Write Lock in Settings.
          </p>
        </div>
      </div>

      {hasDuplicateEbaySeller && (
        <div className="mb-6 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          TPP eBay and TT eBay are currently connected to the same seller account:{" "}
          <span className="font-semibold">{integrationMeta.tpp?.accountUserId}</span>. Reconnect TT eBay with the real
          Telitetech seller before trusting TT item IDs or UPCs.
        </div>
      )}

      {/* Integration cards grid */}
      <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2" data-tour="integrations-cards">
        {integrations.map((integration) => {
          const theme = themeClasses[integration.theme];
          const isLocked = writeLocks[integration.id];
          const isConnected = connected[integration.id];
          const isTesting = testing[integration.id];
          const isShopify = integration.id === "shpfy";
          const isTppEbay = integration.id === "tpp";
          const isTtEbay = integration.id === "tt";
          const meta = integrationMeta[integration.id];
          const identityRows = isTppEbay || isTtEbay
            ? [
                { label: "Seller ID", value: meta?.accountUserId ?? "Not detected yet" },
                { label: "Store Name", value: meta?.accountStoreName ?? "No eBay Store name returned" },
                { label: "eBay Env", value: meta?.environment ?? "PRODUCTION" },
              ]
            : integration.id === "bc"
              ? [
                  { label: "Store Hash", value: meta?.storeHash ?? "Not configured yet" },
                  { label: "Connection", value: meta?.connected ? "BigCommerce connected" : "Waiting for credentials" },
                ]
              : [
                  { label: "Store Domain", value: meta?.storeDomain ?? "Not configured yet" },
                  { label: "Connection", value: meta?.connected ? "Shopify connected" : "Waiting for credentials" },
                ];

          return (
            <article
              key={integration.id}
              className={cn(
                "flex flex-col rounded-lg border border-border bg-card p-6 transition-colors duration-200",
                "hover:border-border/80 hover:bg-card/95"
              )}
            >
              {/* Card header: logo + store name + badges */}
              <div className="mb-4 flex flex-wrap items-center gap-2">
                {LOGO_MAP[integration.platform] && (
                  <img
                    src={LOGO_MAP[integration.platform]}
                    alt={integration.platform}
                    width={22}
                    height={22}
                    style={{ width: 22, height: 22, minWidth: 22 }}
                    className="shrink-0"
                  />
                )}
                <h3 className="truncate text-base font-semibold text-foreground">
                  {integration.name}
                  {integration.subtitle && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      ({integration.subtitle})
                    </span>
                  )}
                </h3>
                <span
                  className={cn(
                    "shrink-0 rounded border px-2 py-0.5 text-xs font-medium",
                    theme.badge
                  )}
                >
                  {integration.acronym}
                </span>
                {integration.isMaster && (
                  <span
                    className="inline-flex cursor-default shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400"
                    title="Master store"
                  >
                    <Crown className="h-3 w-3" aria-hidden />
                    Master
                  </span>
                )}
              </div>

              {/* Connection status */}
              <div className="mb-4 flex items-center gap-1.5">
                {isConnected ? (
                  <>
                    <CheckCircle
                      className="h-4 w-4 shrink-0 text-green-500"
                      aria-hidden
                    />
                    <span className="text-sm text-muted-foreground">
                      Connected
                    </span>
                  </>
                ) : (
                  <>
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-red-500"
                      aria-hidden
                    />
                    <XCircle
                      className="h-4 w-4 shrink-0 text-red-500"
                      aria-hidden
                    />
                    <span className="text-sm text-muted-foreground">
                      Not Connected
                    </span>
                  </>
                )}
              </div>

              <div className="mb-4 rounded-lg border border-border bg-background/40 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Connection Identity
                </div>
                <div className="space-y-2">
                  {identityRows.map((row) => (
                    <div
                      key={`${integration.id}-${row.label}`}
                      className="flex items-start justify-between gap-3 text-sm"
                    >
                      <span className="shrink-0 text-muted-foreground">{row.label}</span>
                      <span className="text-right font-medium text-foreground">{row.value}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Write Lock toggle */}
              <div className="mb-4 flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground">
                  Write Lock
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isLocked}
                  aria-label={`${isLocked ? "Unlock" : "Lock"} writes for ${integration.name}`}
                  onClick={() => toggleWriteLock(integration.id)}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-200",
                    isLocked
                      ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400"
                      : "border-border bg-muted/50 text-muted-foreground hover:bg-muted"
                  )}
                >
                  {isLocked ? (
                    <>
                      <Lock className="h-4 w-4" aria-hidden />
                      Locked
                    </>
                  ) : (
                    <>
                      <Unlock className="h-4 w-4" aria-hidden />
                      Unlocked
                    </>
                  )}
                </button>
              </div>

              {/* Last Sync */}
              <div className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground">
                <span>Last Sync:</span>
                <span>{formatLastSync(meta?.lastSyncAt ?? null)}</span>
              </div>

              {/* Actions */}
              <div className="mt-auto flex flex-wrap gap-2">
                {isTppEbay && !isConnected && (
                  <a
                    href="/api/ebay/connect?store=tpp"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-2 rounded-md border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground",
                      "transition-colors hover:bg-primary/90",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    )}
                    aria-label="Connect eBay TPP"
                  >
                    <Link2 className="h-4 w-4" aria-hidden />
                    Connect eBay TPP
                  </a>
                )}
                {isTtEbay && !isConnected && (
                  <a
                    href="/api/ebay/connect?store=tt"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-2 rounded-md border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground",
                      "transition-colors hover:bg-primary/90",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    )}
                    aria-label="Connect eBay TT"
                  >
                    <Link2 className="h-4 w-4" aria-hidden />
                    Connect eBay TT
                  </a>
                )}
                {isShopify && !isConnected && (
                  <a
                    href="/api/shopify/connect"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-2 rounded-md border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground",
                      "transition-colors hover:bg-primary/90",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    )}
                    aria-label="Connect Shopify"
                  >
                    <Link2 className="h-4 w-4" aria-hidden />
                    Connect Shopify
                  </a>
                )}
                {isTppEbay ? (
                  <a
                    href="/api/ebay/connect?store=tpp"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground",
                      "transition-colors hover:bg-muted hover:text-foreground",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    )}
                    aria-label={`Configure ${integration.name}`}
                  >
                    <Settings2 className="h-4 w-4" aria-hidden />
                    Configure
                  </a>
                ) : isTtEbay ? (
                  <a
                    href="/api/ebay/connect?store=tt"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground",
                      "transition-colors hover:bg-muted hover:text-foreground",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    )}
                    aria-label={`Configure ${integration.name}`}
                  >
                    <Settings2 className="h-4 w-4" aria-hidden />
                    Configure
                  </a>
                ) : isShopify ? (
                  <a
                    href="/api/shopify/connect"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground",
                      "transition-colors hover:bg-muted hover:text-foreground",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    )}
                    aria-label={`Configure ${integration.name}`}
                  >
                    <Settings2 className="h-4 w-4" aria-hidden />
                    Configure
                  </a>
                ) : (
                  <button
                    type="button"
                    disabled
                    className={cn(
                      "inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-muted-foreground",
                      "cursor-not-allowed opacity-60"
                    )}
                    aria-label={`Configure ${integration.name}`}
                  >
                    <Settings2 className="h-4 w-4" aria-hidden />
                    Configure
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => testConnection(integration.id)}
                  disabled={isTesting}
                  aria-label={`Test connection for ${integration.name}`}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors",
                    isTesting
                      ? "cursor-wait border-border bg-muted text-muted-foreground"
                      : isConnected
                      ? "cursor-pointer bg-background text-foreground hover:bg-muted hover:text-foreground"
                      : "cursor-pointer bg-background text-foreground hover:bg-muted hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none"
                  )}
                >
                  <Zap className="h-4 w-4" aria-hidden />
                  {isTesting ? "Testing..." : "Test Connection"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
      <PageTour page="integrations" steps={PAGE_TOUR_STEPS.integrations} ready />
    </div>
  );
}

export default function IntegrationsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-muted-foreground">Loading…</div>}>
      <IntegrationsContent />
    </Suspense>
  );
}
