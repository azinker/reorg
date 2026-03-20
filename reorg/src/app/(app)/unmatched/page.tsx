"use client";

import { useState, useMemo, useEffect } from "react";
import { Unlink, Filter, Search, Info, ExternalLink, Link2Off, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";

const STORE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "tpp", label: "TPP eBay" },
  { value: "tt", label: "Telitetech (eBay)" },
  { value: "bc", label: "BigCommerce" },
  { value: "shpfy", label: "Shopify" },
] as const;

type PlatformKey = "TPP_EBAY" | "TT_EBAY" | "BIGCOMMERCE" | "SHOPIFY";

interface UnmatchedListing {
  id: string;
  externalItemId: string;
  externalTitle: string;
  externalSku: string | null;
  platform: PlatformKey;
  storeName: string;
  storeFilterValue: string;
  price: number;
  reason: string;
  discoveredAt: string;
}

const PLATFORM_LOGO: Record<string, string> = {
  TPP_EBAY: "/logos/ebay.svg",
  TT_EBAY: "/logos/ebay.svg",
  BIGCOMMERCE: "/logos/bigcommerce.svg",
  SHOPIFY: "/logos/shopify.svg",
};

const PLATFORM_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  TPP_EBAY: { label: "eBay (TPP)", bg: "bg-blue-500/15 dark:bg-blue-500/20", text: "text-blue-600 dark:text-blue-400" },
  TT_EBAY: { label: "eBay (TT)", bg: "bg-emerald-500/15 dark:bg-emerald-500/20", text: "text-emerald-600 dark:text-emerald-400" },
  BIGCOMMERCE: { label: "BigCommerce", bg: "bg-orange-500/15 dark:bg-orange-500/20", text: "text-orange-600 dark:text-orange-400" },
  SHOPIFY: { label: "Shopify", bg: "bg-green-500/15 dark:bg-green-500/20", text: "text-green-600 dark:text-green-400" },
};

function PlatformIcon({ platform }: { platform: string }) {
  const c = PLATFORM_BADGE[platform] ?? { label: platform, bg: "bg-muted", text: "text-muted-foreground" };
  const logo = PLATFORM_LOGO[platform];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold", c.bg, c.text)}>
      {logo && <img src={logo} alt={c.label} width={14} height={14} style={{ width: 14, height: 14, minWidth: 14 }} />}
      {c.label}
    </span>
  );
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  });
}

function formatPrice(price: number) {
  return `$${price.toFixed(2)}`;
}

function mapApiToUi(row: {
  id: string;
  platformItemId: string;
  sku: string | null;
  title: string | null;
  platform: string;
  storeName: string;
  storeFilterValue: string;
  lastSyncedAt: string;
  rawData: Record<string, unknown>;
}): UnmatchedListing {
  const price = typeof row.rawData?.salePrice === "number" ? row.rawData.salePrice : 0;
  const skuDisplay = row.sku ?? "No SKU on listing";
  return {
    id: row.id,
    externalItemId: row.platformItemId,
    externalTitle: row.title ?? "Untitled",
    externalSku: row.sku,
    platform: row.platform as PlatformKey,
    storeName: row.storeName,
    storeFilterValue: row.storeFilterValue,
    price,
    reason: `No matching master SKU for ${skuDisplay}. Link to an existing master SKU or create a new one.`,
    discoveredAt: row.lastSyncedAt,
  };
}

export default function UnmatchedPage() {
  const [selectedStore, setSelectedStore] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [listings, setListings] = useState<UnmatchedListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [linkSku, setLinkSku] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/unmatched")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to load"))))
      .then((json) => {
        const rows = (json.data ?? []).map(mapApiToUi);
        setListings(rows);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let results = listings;
    if (selectedStore !== "all") {
      results = results.filter((l) => l.storeFilterValue === selectedStore);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      results = results.filter(
        (l) =>
          l.externalTitle.toLowerCase().includes(q) ||
          l.externalItemId.toLowerCase().includes(q) ||
          (l.externalSku && l.externalSku.toLowerCase().includes(q))
      );
    }
    return results;
  }, [listings, selectedStore, searchQuery]);

  const handleIgnore = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await fetch("/api/unmatched/ignore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) setListings((prev) => prev.filter((l) => l.id !== id));
      else setError("Failed to ignore listing");
    } finally {
      setActionLoading(null);
    }
  };

  const handleLink = async (id: string, masterSku: string) => {
    if (!masterSku.trim()) return;
    setActionLoading(id);
    try {
      const res = await fetch("/api/unmatched/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unmatchedId: id, masterSku: masterSku.trim() }),
      });
      if (res.ok) {
        setListings((prev) => prev.filter((l) => l.id !== id));
        setLinkingId(null);
        setLinkSku("");
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to link listing");
      }
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6" data-tour="unmatched-header">
        <div className="flex items-center gap-2">
          <Unlink
            className="h-7 w-7 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Unmatched External Listings
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          External listings with no matching master-store SKU
        </p>
      </div>

      {/* Info banner */}
      <div className="mb-6 flex gap-3 rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 dark:bg-blue-500/10">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" aria-hidden />
        <p className="text-sm text-foreground/90">
          These listings were found on external marketplaces during sync but could not be
          automatically matched to any SKU in your master store (TPP eBay). They may be
          unique to that marketplace or have a different SKU format.
        </p>
      </div>

      {/* Filter row */}
      <div className="mb-6 flex flex-wrap items-center gap-4" data-tour="unmatched-filters">
        <div className="flex items-center gap-2">
          <Filter
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <label htmlFor="store-filter" className="text-sm font-medium text-foreground">
            Store
          </label>
          <select
            id="store-filter"
            value={selectedStore}
            onChange={(e) => setSelectedStore(e.target.value)}
            className={cn(
              "cursor-pointer rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            )}
            aria-label="Filter by store"
          >
            {STORE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-1 items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 max-w-xs">
          <Search
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            placeholder="Search unmatched listings..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            aria-label="Search unmatched listings"
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {filtered.length} listing{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Listings */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          Loading unmatched listings…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 py-16 px-6">
          <Unlink
            className="mb-4 h-12 w-12 shrink-0 text-muted-foreground/50"
            aria-hidden
          />
          <h2 className="mb-2 text-base font-medium text-foreground">
            No unmatched listings found
          </h2>
          <p className="max-w-md text-center text-sm text-muted-foreground">
            {searchQuery || selectedStore !== "all"
              ? "No listings match your current filters. Try adjusting your search or store filter."
              : "No unmatched listings in the database. This list is filled after syncs when listings can’t be matched to a master SKU."}
          </p>
        </div>
      ) : (
        <div className="space-y-3" data-tour="unmatched-list">
          {filtered.map((listing) => (
            <div
              key={listing.id}
              className="rounded-lg border border-border bg-card p-4 shadow-sm transition-colors hover:bg-accent/30"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                {/* Left side: main info */}
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <PlatformIcon platform={listing.platform} />
                    <span className="text-xs text-muted-foreground">{listing.storeName}</span>
                    <span className="text-xs text-muted-foreground">·</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      ID: {listing.externalItemId}
                    </span>
                  </div>

                  <h3 className="text-sm font-medium text-foreground leading-snug">
                    {listing.externalTitle}
                  </h3>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {listing.externalSku ? (
                      <span>
                        SKU: <span className="font-mono font-medium text-foreground">{listing.externalSku}</span>
                      </span>
                    ) : (
                      <span className="italic text-amber-500 dark:text-amber-400">No SKU on listing</span>
                    )}
                    <span>
                      Price: <span className="font-medium text-foreground">{formatPrice(listing.price)}</span>
                    </span>
                    <span>Discovered: {formatDate(listing.discoveredAt)}</span>
                  </div>

                  {/* Reason */}
                  <div className="flex gap-2 rounded-md bg-amber-500/5 border border-amber-500/20 p-2.5 dark:bg-amber-500/10">
                    <Link2Off className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
                    <p className="text-xs text-foreground/80 leading-relaxed">
                      {listing.reason}
                    </p>
                  </div>

                  {/* Inline link form */}
                  {linkingId === listing.id && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-2">
                      <label htmlFor={`link-sku-${listing.id}`} className="text-xs font-medium">Master SKU to link:</label>
                      <input
                        id={`link-sku-${listing.id}`}
                        type="text"
                        value={linkSku}
                        onChange={(e) => setLinkSku(e.target.value)}
                        placeholder="e.g. TPP-BRK-4421"
                        className="h-8 flex-1 min-w-[120px] rounded border border-input bg-background px-2 text-sm"
                      />
                      <button
                        type="button"
                        disabled={!linkSku.trim() || actionLoading === listing.id}
                        onClick={() => handleLink(listing.id, linkSku)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-primary bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        {actionLoading === listing.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                        Link
                      </button>
                      <button
                        type="button"
                        onClick={() => { setLinkingId(null); setLinkSku(""); }}
                        className="inline-flex items-center rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>

                {/* Right side: actions */}
                <div className="flex shrink-0 items-start gap-2 sm:ml-4">
                  {linkingId !== listing.id && (
                    <button
                      type="button"
                      disabled={!!actionLoading}
                      onClick={() => { setLinkingId(listing.id); setLinkSku(listing.externalSku ?? ""); }}
                      className="inline-flex items-center gap-1.5 rounded-md border border-primary bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-primary/10"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Match Manually
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!!actionLoading}
                    onClick={() => handleIgnore(listing.id)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                    title="Remove from list (may reappear after next sync if still unmatched)"
                  >
                    {actionLoading === listing.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                    Ignore
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <PageTour page="unmatched" steps={PAGE_TOUR_STEPS.unmatched} ready />
    </div>
  );
}
