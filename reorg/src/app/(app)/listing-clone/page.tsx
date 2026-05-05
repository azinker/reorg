"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRight,
  CheckCircle2,
  ExternalLink,
  FileSearch,
  ImageOff,
  Loader2,
  Search,
  Send,
  Store,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

type EbayPlatform = "TPP_EBAY" | "TT_EBAY";

const PLATFORM_LABEL: Record<EbayPlatform, string> = {
  TPP_EBAY: "TPP eBay",
  TT_EBAY: "TT eBay",
};

const MAX_BATCH = 12;

const STEPS = [
  { id: 1, label: "Route & source", icon: ArrowLeftRight },
  { id: 2, label: "Verify preview", icon: FileSearch },
  { id: 3, label: "Publish", icon: Send },
  { id: 4, label: "Result", icon: CheckCircle2 },
] as const;

type SearchHit = {
  marketplaceListingId: string;
  masterRowId: string;
  platformItemId: string;
  sku: string;
  title: string | null;
  imageUrl: string | null;
};

type SelectedListing = SearchHit;

type Summary = {
  title: string;
  sourceItemId: string;
  pictureUrlCount: number;
  listingSpecificRowCount: number;
  hasVariations: boolean;
  variationCount: number;
};

type PreviewPayload = {
  ok: boolean;
  ack: string;
  errors: string[];
  fees?: unknown;
  summary: Summary;
};

type PreviewItemRow = {
  sourceItemId: string;
  ok: boolean;
  preview?: PreviewPayload;
  error?: string;
};

type ExecuteItemRow = {
  sourceItemId: string;
  ok: boolean;
  result?: { newItemId?: string; summary?: Summary; errors?: string[] };
  error?: string;
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

export default function ListingClonePage() {
  const [currentStep, setCurrentStep] = useState(1);
  const [sourcePlatform, setSourcePlatform] = useState<EbayPlatform>("TPP_EBAY");
  const [targetPlatform, setTargetPlatform] = useState<EbayPlatform>("TT_EBAY");
  const [selectedListings, setSelectedListings] = useState<SelectedListing[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);

  const [skipPictureUpload, setSkipPictureUpload] = useState(false);
  const [itemTypeAspect, setItemTypeAspect] = useState("");
  const [policySourceItemId, setPolicySourceItemId] = useState("");
  const [shippingPolicyId, setShippingPolicyId] = useState("");
  const [returnPolicyId, setReturnPolicyId] = useState("");
  const [paymentPolicyId, setPaymentPolicyId] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewItems, setPreviewItems] = useState<PreviewItemRow[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [executeLoading, setExecuteLoading] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [confirmedLive, setConfirmedLive] = useState(false);
  const [executeItems, setExecuteItems] = useState<ExecuteItemRow[] | null>(null);

  const ebayPairsEnabled = true;

  const patchOppositePlatform = useCallback(
    (role: "source" | "target", value: EbayPlatform) => {
      if (role === "source") {
        setSourcePlatform(value);
        setTargetPlatform((prev) => (prev === value ? (value === "TPP_EBAY" ? "TT_EBAY" : "TPP_EBAY") : prev));
      } else {
        setTargetPlatform(value);
        setSourcePlatform((prev) => (prev === value ? (value === "TPP_EBAY" ? "TT_EBAY" : "TPP_EBAY") : prev));
      }
      setSelectedListings([]);
      setSearchQuery("");
      setSearchHits([]);
      setPreviewItems(null);
      setExecuteItems(null);
    },
    [],
  );

  function swapRoute() {
    setSourcePlatform(targetPlatform);
    setTargetPlatform(sourcePlatform);
    setSelectedListings([]);
    setSearchQuery("");
    setSearchHits([]);
    setPreviewItems(null);
    setPreviewError(null);
    setExecuteError(null);
    setExecuteItems(null);
    setConfirmedLive(false);
  }

  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchHits([]);
      setSearchLoading(false);
      return;
    }

    const t = window.setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await fetch(
          `/api/listing-clone/search?q=${encodeURIComponent(q)}&platform=${encodeURIComponent(sourcePlatform)}`,
        );
        const json = await res.json().catch(() => ({ data: [] }));
        setSearchHits(Array.isArray(json.data) ? json.data : []);
      } catch {
        setSearchHits([]);
      } finally {
        setSearchLoading(false);
      }
    }, 320);

    return () => window.clearTimeout(t);
  }, [searchQuery, sourcePlatform]);

  function toggleHit(hit: SearchHit) {
    setSelectedListings((prev) => {
      const exists = prev.some((p) => p.platformItemId === hit.platformItemId);
      if (exists) {
        return prev.filter((p) => p.platformItemId !== hit.platformItemId);
      }
      if (prev.length >= MAX_BATCH) return prev;
      return [...prev, hit];
    });
  }

  function removeSelected(platformItemId: string) {
    setSelectedListings((prev) => prev.filter((p) => p.platformItemId !== platformItemId));
  }

  const publishablePreviewRows = useMemo(
    () => previewItems?.filter((r) => r.ok) ?? [],
    [previewItems],
  );

  async function runPreview() {
    const ids = selectedListings.map((s) => s.platformItemId);
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewItems(null);
    setExecuteError(null);
    setExecuteItems(null);
    setConfirmedLive(false);
    try {
      const res = await fetch("/api/listing-clone/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePlatform,
          targetPlatform,
          sourceItemIds: ids,
          skipPictureUpload,
          itemTypeAspect: itemTypeAspect.trim() || undefined,
          policySourceItemId: policySourceItemId.trim() || undefined,
          shippingPolicyId: shippingPolicyId.trim() || undefined,
          returnPolicyId: returnPolicyId.trim() || undefined,
          paymentPolicyId: paymentPolicyId.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof json.error === "string" ? json.error : "Preview failed.");
      }
      const items = json.data?.items as PreviewItemRow[] | undefined;
      if (!Array.isArray(items)) throw new Error("Invalid preview response.");
      setPreviewItems(items);
      setCurrentStep(2);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Preview failed.");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function runExecute() {
    if (!confirmedLive) return;
    const ids = publishablePreviewRows.map((r) => r.sourceItemId);
    if (ids.length === 0) return;

    setExecuteLoading(true);
    setExecuteError(null);
    setExecuteItems(null);
    try {
      const res = await fetch("/api/listing-clone/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePlatform,
          targetPlatform,
          sourceItemIds: ids,
          confirmedLivePush: true,
          skipPictureUpload,
          itemTypeAspect: itemTypeAspect.trim() || undefined,
          policySourceItemId: policySourceItemId.trim() || undefined,
          shippingPolicyId: shippingPolicyId.trim() || undefined,
          returnPolicyId: returnPolicyId.trim() || undefined,
          paymentPolicyId: paymentPolicyId.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof json.error === "string" ? json.error : "Publish failed.");
      }
      const items = json.data?.items as ExecuteItemRow[] | undefined;
      setExecuteItems(Array.isArray(items) ? items : []);
      setCurrentStep(4);
    } catch (e) {
      setExecuteError(e instanceof Error ? e.message : "Publish failed.");
    } finally {
      setExecuteLoading(false);
    }
  }

  const previewFailCount = previewItems ? previewItems.filter((r) => !r.ok).length : 0;
  const previewOkCount = previewItems ? previewItems.filter((r) => r.ok).length : 0;

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Listing Clone</h1>
        <p className="text-sm text-muted-foreground">
          Clone fixed-price eBay listings between accounts with Trading API verify-first safety.
        </p>
      </div>

      <div
        className="mb-6 rounded-lg border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
        role="status"
      >
        This creates <strong className="font-semibold text-foreground">new listings</strong> on the
        destination account (insertion fees may apply). It never deletes or modifies source listings.
        Batch runs process up to {MAX_BATCH} parent listings sequentially (large batches may take
        several minutes). Publishing respects global and per-store write locks and the same{" "}
        <strong className="font-semibold text-foreground">live push</strong> gate as Catalog.
      </div>

      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-0">
          {STEPS.map((step, index) => {
            const isActive = step.id === currentStep;
            const isCompleted = step.id < currentStep;
            const Icon = step.icon;
            return (
              <div key={step.id} className="flex flex-1 items-center">
                <button
                  type="button"
                  onClick={() => setCurrentStep(step.id)}
                  aria-label={`Go to step ${step.id}: ${step.label}`}
                  aria-current={isActive ? "step" : undefined}
                  className={cn(
                    "group flex flex-1 cursor-pointer flex-col items-center gap-2 rounded py-2",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-full border transition-colors",
                      isActive && "border-primary bg-primary text-primary-foreground",
                      isCompleted && "border-green-500/50 bg-green-500/20 text-green-600 dark:text-green-400",
                      !isActive &&
                        !isCompleted &&
                        "border-border bg-muted/50 text-muted-foreground group-hover:border-muted-foreground/50",
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                  </div>
                  <span
                    className={cn(
                      "text-xs font-medium",
                      isActive ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {step.label}
                  </span>
                </button>
                {index < STEPS.length - 1 && (
                  <div
                    className={cn(
                      "h-0.5 min-w-[20px] flex-1",
                      step.id < currentStep ? "bg-green-500/40" : "bg-border",
                    )}
                    aria-hidden
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <section className="mb-8 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-foreground">Route</h2>
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                From
              </span>
              <select
                value={sourcePlatform}
                onChange={(e) =>
                  patchOppositePlatform("source", e.target.value as EbayPlatform)
                }
                disabled={!ebayPairsEnabled}
                className={cn(
                  "cursor-pointer rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                {(Object.keys(PLATFORM_LABEL) as EbayPlatform[]).map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_LABEL[p]}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={swapRoute}
              className={cn(
                "inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground",
                "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              aria-label="Swap source and destination"
            >
              <ArrowLeftRight className="h-4 w-4" aria-hidden />
              Swap
            </button>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                To
              </span>
              <select
                value={targetPlatform}
                onChange={(e) =>
                  patchOppositePlatform("target", e.target.value as EbayPlatform)
                }
                disabled={!ebayPairsEnabled}
                className={cn(
                  "cursor-pointer rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                {(Object.keys(PLATFORM_LABEL) as EbayPlatform[]).map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_LABEL[p]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">More destinations</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { from: "TT eBay", to: "BigCommerce" },
                { from: "TPP eBay", to: "BigCommerce" },
                { from: "TT eBay", to: "Shopify" },
                { from: "TPP eBay", to: "Shopify" },
              ].map((route) => (
                <div
                  key={`${route.from}-${route.to}`}
                  className="rounded-lg border border-border bg-muted/20 px-4 py-3 opacity-60"
                  aria-disabled="true"
                >
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Store className="h-4 w-4 shrink-0" aria-hidden />
                    <span>
                      {route.from} → {route.to}
                    </span>
                  </div>
                  <p className="mt-1 text-xs font-medium text-muted-foreground/90">
                    Coming soon — same verify → confirm flow when product creates ship.
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {currentStep === 1 && (
          <div className="space-y-6">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="listing-search" className="text-sm font-medium text-foreground">
                  Listing picker — {PLATFORM_LABEL[sourcePlatform]}
                </label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {selectedListings.length} selected · max {MAX_BATCH}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Search SKU, title, or Item ID (multi-word AND). Check rows to queue them for verify.
              </p>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <input
                  id="listing-search"
                  type="search"
                  autoComplete="off"
                  placeholder="Search catalog…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={cn(
                    "w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-3 text-sm text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                />
              </div>

              <div
                className={cn(
                  "min-h-[320px] max-h-[min(520px,55vh)] overflow-auto rounded-xl border border-border bg-muted/15",
                )}
                aria-label="Search results"
              >
                {searchQuery.trim().length < 2 ? (
                  <div className="flex h-[280px] flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
                    <Search className="h-10 w-10 opacity-40" aria-hidden />
                    <p>Type at least 2 characters to load listings from the master store.</p>
                  </div>
                ) : searchLoading ? (
                  <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Searching catalog…
                  </div>
                ) : searchHits.length === 0 ? (
                  <div className="flex h-[280px] flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
                    <ImageOff className="h-10 w-10 opacity-40" aria-hidden />
                    <p>No active parent listings match this search.</p>
                  </div>
                ) : (
                  <ul className="divide-y divide-border">
                    {searchHits.map((hit) => {
                      const selected = selectedListings.some(
                        (s) => s.platformItemId === hit.platformItemId,
                      );
                      const atCap = selectedListings.length >= MAX_BATCH && !selected;
                      return (
                        <li key={hit.marketplaceListingId}>
                          <button
                            type="button"
                            disabled={atCap}
                            onClick={() => toggleHit(hit)}
                            aria-pressed={selected}
                            className={cn(
                              "flex w-full cursor-pointer items-start gap-3 px-3 py-3 text-left transition-colors",
                              "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              selected && "bg-primary/12",
                              atCap && "cursor-not-allowed opacity-50",
                            )}
                          >
                            <span
                              className={cn(
                                "mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 border-border",
                                selected && "border-primary bg-primary text-primary-foreground",
                              )}
                              aria-hidden
                            >
                              {selected ? (
                                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                              ) : null}
                            </span>
                            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md border border-border bg-background">
                              {hit.imageUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={hit.imageUrl}
                                  alt=""
                                  className="h-full w-full object-cover"
                                  loading="lazy"
                                />
                              ) : (
                                <div className="flex h-full w-full items-center justify-center bg-muted/40">
                                  <ImageOff className="h-6 w-6 text-muted-foreground/50" aria-hidden />
                                </div>
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
                                {hit.title ?? "(no title)"}
                              </p>
                              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                                SKU <span className="text-foreground/90">{hit.sku}</span>
                                {" · "}
                                Item <span className="text-foreground/90">{hit.platformItemId}</span>
                              </p>
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {selectedListings.length > 0 ? (
                <div className="rounded-lg border border-border bg-muted/25 px-3 py-2">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Selected for clone
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {selectedListings.map((s) => (
                      <span
                        key={s.platformItemId}
                        className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground"
                      >
                        <span className="truncate font-mono" title={`${s.sku} · ${s.title ?? ""}`}>
                          {s.sku}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeSelected(s.platformItemId)}
                          className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                          aria-label={`Remove ${s.sku}`}
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={skipPictureUpload}
                onChange={(e) => setSkipPictureUpload(e.target.checked)}
                className="cursor-pointer rounded border-border"
              />
              Skip picture re-upload (only if Verify succeeds without EPS — uncommon)
            </label>

            <div className="rounded-lg border border-border bg-muted/20">
              <button
                type="button"
                onClick={() => setAdvancedOpen((o) => !o)}
                className={cn(
                  "flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left text-sm font-medium text-foreground",
                  "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                )}
              >
                Advanced options
                <span className="text-muted-foreground">{advancedOpen ? "−" : "+"}</span>
              </button>
              {advancedOpen && (
                <div className="space-y-4 border-t border-border px-4 py-4">
                  <div>
                    <label htmlFor="item-type" className="text-xs font-medium text-muted-foreground">
                      Item specifics “Type” override (optional)
                    </label>
                    <input
                      id="item-type"
                      type="text"
                      value={itemTypeAspect}
                      onChange={(e) => setItemTypeAspect(e.target.value)}
                      className={cn(
                        "mt-1 w-full max-w-md rounded-md border border-border bg-background px-3 py-2 text-sm",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      )}
                      placeholder="Exact aspect value if Verify requires listing-level Type"
                    />
                  </div>
                  <div>
                    <label htmlFor="policy-source" className="text-xs font-medium text-muted-foreground">
                      Policy source Item ID on{" "}
                      <strong>{PLATFORM_LABEL[targetPlatform]}</strong> (optional)
                    </label>
                    <input
                      id="policy-source"
                      type="text"
                      inputMode="numeric"
                      value={policySourceItemId}
                      onChange={(e) => setPolicySourceItemId(e.target.value.replace(/\D/g, ""))}
                      className={cn(
                        "mt-1 w-full max-w-md rounded-md border border-border bg-background px-3 py-2 text-sm",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      )}
                      placeholder="Existing listing to copy SellerProfiles from"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <label htmlFor="ship-pol" className="text-xs text-muted-foreground">
                        Shipping policy ID
                      </label>
                      <input
                        id="ship-pol"
                        type="text"
                        value={shippingPolicyId}
                        onChange={(e) => setShippingPolicyId(e.target.value)}
                        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label htmlFor="ret-pol" className="text-xs text-muted-foreground">
                        Return policy ID
                      </label>
                      <input
                        id="ret-pol"
                        type="text"
                        value={returnPolicyId}
                        onChange={(e) => setReturnPolicyId(e.target.value)}
                        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label htmlFor="pay-pol" className="text-xs text-muted-foreground">
                        Payment policy ID
                      </label>
                      <input
                        id="pay-pol"
                        type="text"
                        value={paymentPolicyId}
                        onChange={(e) => setPaymentPolicyId(e.target.value)}
                        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {previewError && (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {previewError}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={previewLoading || selectedListings.length === 0}
                onClick={() => void runPreview()}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground",
                  "hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  (previewLoading || selectedListings.length === 0) &&
                    "cursor-not-allowed opacity-50",
                )}
              >
                {previewLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Running verify ({selectedListings.length})…
                  </>
                ) : (
                  <>
                    <FileSearch className="h-4 w-4" aria-hidden />
                    Run verify preview ({selectedListings.length})
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {currentStep === 2 && (
          <div className="space-y-4">
            {!previewItems ? (
              <p className="text-sm text-muted-foreground">
                No preview yet. Go back to step 1 and run verify.
              </p>
            ) : (
              <>
                <div
                  className={cn(
                    "rounded-lg border px-4 py-3 text-sm",
                    previewFailCount === 0
                      ? "border-green-500/30 bg-green-500/10 text-green-100"
                      : "border-amber-500/35 bg-amber-500/10 text-amber-100",
                  )}
                >
                  {previewOkCount} passed
                  {previewFailCount > 0 ? ` · ${previewFailCount} failed` : ""}.
                  {previewFailCount > 0 &&
                    " Only listings that passed verify can be published; adjust selection and re-run preview if needed."}
                </div>

                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">Item ID</th>
                        <th className="px-3 py-2 font-medium">Title</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Ack</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewItems.map((row) => (
                        <tr key={row.sourceItemId} className="border-b border-border last:border-b-0">
                          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                            {row.sourceItemId}
                          </td>
                          <td className="max-w-[240px] px-3 py-2 text-muted-foreground">
                            {truncate(row.preview?.summary.title ?? "—", 64)}
                          </td>
                          <td className="px-3 py-2">
                            {row.ok ? (
                              <span className="text-green-600 dark:text-green-400">OK</span>
                            ) : (
                              <span className="text-red-400">Failed</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {row.ok ? row.preview?.ack : row.error ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div className="flex flex-wrap gap-3 pt-4">
              <button
                type="button"
                onClick={() => setCurrentStep(1)}
                className={cn(
                  "cursor-pointer rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                Back
              </button>
              <button
                type="button"
                disabled={!previewItems || publishablePreviewRows.length === 0}
                onClick={() => setCurrentStep(3)}
                className={cn(
                  "cursor-pointer rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  (!previewItems || publishablePreviewRows.length === 0) &&
                    "cursor-not-allowed opacity-50",
                )}
              >
                Continue to publish ({publishablePreviewRows.length})
              </button>
            </div>
          </div>
        )}

        {currentStep === 3 && (
          <div className="space-y-6">
            {!previewItems || publishablePreviewRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No verified listings to publish. Go back and fix preview failures or pick different
                listings.
              </p>
            ) : (
              <>
                <div className="rounded-lg border border-border bg-muted/30 px-4 py-4 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">Summary</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>
                      Publish{" "}
                      <strong className="text-foreground">{publishablePreviewRows.length}</strong>{" "}
                      listing(s) from{" "}
                      <strong className="text-foreground">{PLATFORM_LABEL[sourcePlatform]}</strong>{" "}
                      →{" "}
                      <strong className="text-foreground">{PLATFORM_LABEL[targetPlatform]}</strong>
                    </li>
                    {previewFailCount > 0 && (
                      <li className="text-amber-200">
                        Skipping {previewFailCount} listing(s) that did not pass verify.
                      </li>
                    )}
                  </ul>
                </div>

                <label className="flex cursor-pointer items-start gap-3 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={confirmedLive}
                    onChange={(e) => setConfirmedLive(e.target.checked)}
                    className="mt-1 cursor-pointer rounded border-border"
                  />
                  <span>
                    I confirm I want to create these <strong>{publishablePreviewRows.length}</strong>{" "}
                    listing(s) live on <strong>{PLATFORM_LABEL[targetPlatform]}</strong>. I understand
                    insertion fees may apply, and that this uses the same live-push approval gate as
                    Catalog changes.
                  </span>
                </label>

                {executeError && (
                  <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                    {executeError}
                  </div>
                )}

                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => setCurrentStep(2)}
                    className={cn(
                      "cursor-pointer rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={
                      executeLoading || !confirmedLive || publishablePreviewRows.length === 0
                    }
                    onClick={() => void runExecute()}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground",
                      "hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      (executeLoading ||
                        !confirmedLive ||
                        publishablePreviewRows.length === 0) &&
                        "cursor-not-allowed opacity-50",
                    )}
                  >
                    {executeLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        Publishing…
                      </>
                    ) : (
                      <>
                        <Send className="h-4 w-4" aria-hidden />
                        Publish {publishablePreviewRows.length} listing(s)
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {currentStep === 4 && executeItems && (
          <div className="space-y-4">
            <div className="rounded-lg border border-green-500/35 bg-green-500/10 px-4 py-4 text-sm text-green-100">
              Batch publish finished:{" "}
              <strong className="text-foreground">
                {executeItems.filter((i) => i.ok).length}
              </strong>{" "}
              succeeded
              {executeItems.some((i) => !i.ok) && (
                <>
                  ,{" "}
                  <strong className="text-foreground">
                    {executeItems.filter((i) => !i.ok).length}
                  </strong>{" "}
                  failed
                </>
              )}
              .
            </div>

            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Source Item ID</th>
                    <th className="px-3 py-2 font-medium">
                      New listing ({PLATFORM_LABEL[targetPlatform]})
                    </th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {executeItems.map((row) => (
                    <tr key={row.sourceItemId} className="border-b border-border last:border-b-0">
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                        {row.sourceItemId}
                      </td>
                      <td className="px-3 py-2">
                        {row.ok && row.result?.newItemId ? (
                          <a
                            href={`https://www.ebay.com/itm/${row.result.newItemId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex cursor-pointer items-center gap-1 font-mono text-xs text-primary underline-offset-4 hover:underline"
                          >
                            {row.result.newItemId}
                            <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {row.error ?? "—"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {row.ok ? (
                          <span className="text-green-600 dark:text-green-400">OK</span>
                        ) : (
                          <span className="text-red-400">Failed</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-sm text-muted-foreground">
              Run <strong className="text-foreground">Sync</strong> for{" "}
              {PLATFORM_LABEL[targetPlatform]} when you want these listings in the main catalog grid.
            </p>
            <button
              type="button"
              onClick={() => {
                setCurrentStep(1);
                setPreviewItems(null);
                setPreviewError(null);
                setExecuteError(null);
                setExecuteItems(null);
                setConfirmedLive(false);
                setSelectedListings([]);
                setSearchQuery("");
                setSearchHits([]);
              }}
              className={cn(
                "cursor-pointer rounded-lg bg-muted px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/80",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              Clone another batch
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
