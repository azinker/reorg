"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  PencilLine,
  RefreshCw,
  Save,
  Send,
  X,
} from "lucide-react";
import { PlatformIcon } from "@/components/grid/platform-icon";
import { PushConfirmModal, type PushApiData, type PushItem } from "@/components/push/push-confirm-modal";
import { PLATFORM_COLORS, PLATFORM_FULL, type Platform } from "@/lib/grid-types";
import { cn } from "@/lib/utils";

type ProfitCenterListing = {
  rowId: string;
  sku: string;
  title: string;
  imageUrl: string | null;
  upc: string | null;
  weight: string | null;
  inventory: number | null;
  platform: Platform;
  listingId: string;
  marketplaceListingId: string | null;
  platformVariantId: string | null;
  salePrice: number;
  liveSalePrice: number;
  stagedSalePrice: number | null;
  profit: number;
  marginPercent: number;
  supplierCost: number | null;
  supplierShipping: number | null;
  shippingCost: number | null;
  adRatePercent: number | null;
  liveAdRatePercent: number | null;
  stagedAdRatePercent: number | null;
  feeAmount: number;
  platformFeeRatePercent: number;
};

type ProfitCenterLoserPage = {
  items: ProfitCenterListing[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
};

type Notice = { tone: "success" | "error" | "info"; message: string };

interface ProfitCenterBiggestLosersProps {
  initialItems: ProfitCenterListing[];
  initialPageSize: number;
  initialTotalCount: number;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function formatNullableCurrency(value: number | null) {
  return value == null ? "--" : formatCurrency(value);
}

function valuesMatch(a: number | null, b: number | null) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 0.000001;
}

function toCurrencyDraft(value: number | null) {
  return value == null ? "" : value.toFixed(2);
}

function toPercentDraft(value: number | null) {
  return value == null ? "" : value.toFixed(2);
}

function parseNullableNumber(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as { data?: T; error?: string } | null;
  if (!response.ok || !payload?.data) {
    throw new Error(payload?.error ?? `Request failed with status ${response.status}.`);
  }
  return payload.data;
}

function buildPushItem(
  listing: ProfitCenterListing,
  field: "salePrice" | "adRate",
  newValue: number,
): PushItem {
  return {
    sku: listing.sku,
    title: listing.title,
    platform: listing.platform,
    listingId: listing.listingId,
    masterRowId: listing.rowId.startsWith("child-") ? listing.rowId.replace(/^child-/, "") : listing.rowId,
    marketplaceListingId: listing.marketplaceListingId ?? undefined,
    platformVariantId: listing.platformVariantId ?? undefined,
    field,
    oldValue:
      field === "salePrice"
        ? listing.liveSalePrice
        : listing.liveAdRatePercent != null
          ? listing.liveAdRatePercent / 100
          : null,
    newValue: field === "salePrice" ? newValue : newValue / 100,
  };
}

function NoticeBanner({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  const toneClasses =
    notice.tone === "success"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
      : notice.tone === "error"
        ? "border-red-500/30 bg-red-500/10 text-red-200"
        : "border-sky-500/30 bg-sky-500/10 text-sky-200";

  return <div className={cn("rounded-lg border px-3 py-2 text-sm", toneClasses)}>{notice.message}</div>;
}

function ProfitListingDetailModal(props: {
  marketplaceListingId: string | null;
  open: boolean;
  onClose: () => void;
  onUpdated: () => Promise<void>;
}) {
  const { marketplaceListingId, open, onClose, onUpdated } = props;
  const [detail, setDetail] = useState<ProfitCenterListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [savingCatalog, setSavingCatalog] = useState(false);
  const [savingMarketplace, setSavingMarketplace] = useState(false);
  const [salePriceDraft, setSalePriceDraft] = useState("");
  const [adRateDraft, setAdRateDraft] = useState("");
  const [supplierCostDraft, setSupplierCostDraft] = useState("");
  const [supplierShippingDraft, setSupplierShippingDraft] = useState("");
  const [weightDraft, setWeightDraft] = useState("");
  const [pushItems, setPushItems] = useState<PushItem[]>([]);
  const [pushOpen, setPushOpen] = useState(false);

  const adRateEditable = detail?.platform === "TPP_EBAY" || detail?.platform === "TT_EBAY";

  async function loadDetail() {
    if (!marketplaceListingId) return null;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/profit-center/listing?marketplaceListingId=${encodeURIComponent(marketplaceListingId)}`, {
        cache: "no-store",
      });
      const nextDetail = await parseApiResponse<ProfitCenterListing>(response);
      setDetail(nextDetail);
      setSalePriceDraft(toCurrencyDraft(nextDetail.stagedSalePrice ?? nextDetail.salePrice));
      setAdRateDraft(toPercentDraft(nextDetail.stagedAdRatePercent ?? nextDetail.adRatePercent));
      setSupplierCostDraft(toCurrencyDraft(nextDetail.supplierCost));
      setSupplierShippingDraft(toCurrencyDraft(nextDetail.supplierShipping));
      setWeightDraft(nextDetail.weight ?? "");
      return nextDetail;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load listing details.");
      return null;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open || !marketplaceListingId) return;
    setNotice(null);
    void loadDetail();
  }, [marketplaceListingId, open]);

  if (!open) return null;

  async function saveCatalogInputs() {
    if (!detail) return;
    const nextSupplierCost = parseNullableNumber(supplierCostDraft);
    const nextSupplierShipping = parseNullableNumber(supplierShippingDraft);
    if (Number.isNaN(nextSupplierCost) || Number.isNaN(nextSupplierShipping)) {
      setNotice({ tone: "error", message: "Supplier cost and supplier shipping must be valid numbers." });
      return;
    }
    const nextWeight = weightDraft.trim() || null;
    const operations: Array<Promise<unknown>> = [];
    if (!valuesMatch(detail.supplierCost, nextSupplierCost)) {
      operations.push(fetch("/api/grid/edit", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: detail.sku, field: "supplierCost", value: nextSupplierCost }),
      }).then(parseApiResponse));
    }
    if (!valuesMatch(detail.supplierShipping, nextSupplierShipping)) {
      operations.push(fetch("/api/grid/edit", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: detail.sku, field: "supplierShipping", value: nextSupplierShipping }),
      }).then(parseApiResponse));
    }
    if ((detail.weight ?? null) !== nextWeight) {
      operations.push(fetch("/api/grid/edit", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: detail.sku, field: "weight", value: nextWeight }),
      }).then(parseApiResponse));
    }
    if (operations.length === 0) {
      setNotice({ tone: "info", message: "Catalog inputs already match the current values." });
      return;
    }
    setSavingCatalog(true);
    setNotice(null);
    try {
      await Promise.all(operations);
      await Promise.all([loadDetail(), onUpdated()]);
      setNotice({ tone: "success", message: "Catalog inputs saved. Profit Center has been refreshed." });
    } catch (nextError) {
      setNotice({ tone: "error", message: nextError instanceof Error ? nextError.message : "Failed to save catalog inputs." });
    } finally {
      setSavingCatalog(false);
    }
  }

  async function stageMarketplaceField(currentDetail: ProfitCenterListing, field: "salePrice" | "adRate", newPrice: number) {
    return fetch("/api/grid/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "stage",
        sku: currentDetail.sku,
        platform: currentDetail.platform,
        listingId: currentDetail.listingId,
        newPrice,
        field,
        marketplaceListingId: currentDetail.marketplaceListingId,
      }),
    }).then(parseApiResponse);
  }

  async function discardMarketplaceField(currentDetail: ProfitCenterListing, field: "salePrice" | "adRate") {
    return fetch("/api/grid/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "discard",
        sku: currentDetail.sku,
        platform: currentDetail.platform,
        listingId: currentDetail.listingId,
        field,
        marketplaceListingId: currentDetail.marketplaceListingId,
      }),
    }).then(parseApiResponse);
  }

  async function syncMarketplaceDrafts(openPushReview: boolean) {
    if (!detail) return;
    const desiredSalePrice = parseNullableNumber(salePriceDraft);
    if (desiredSalePrice == null || Number.isNaN(desiredSalePrice)) {
      setNotice({ tone: "error", message: "Sale price must be a valid number." });
      return;
    }
    const desiredAdRatePercent = adRateEditable ? parseNullableNumber(adRateDraft) : null;
    if (adRateEditable && Number.isNaN(desiredAdRatePercent)) {
      setNotice({ tone: "error", message: "Ad rate must be a valid percentage." });
      return;
    }

    setSavingMarketplace(true);
    setNotice(null);
    try {
      const operations: Array<Promise<unknown>> = [];
      const effectiveSalePrice = detail.stagedSalePrice ?? detail.salePrice;
      if (!valuesMatch(desiredSalePrice, effectiveSalePrice)) {
        if (valuesMatch(desiredSalePrice, detail.liveSalePrice) && detail.stagedSalePrice != null) {
          operations.push(discardMarketplaceField(detail, "salePrice"));
        } else {
          operations.push(stageMarketplaceField(detail, "salePrice", desiredSalePrice));
        }
      }

      if (adRateEditable) {
        const desiredAdRateDecimal = desiredAdRatePercent == null ? 0 : desiredAdRatePercent / 100;
        const effectiveAdRateDecimal =
          detail.stagedAdRatePercent != null
            ? detail.stagedAdRatePercent / 100
            : detail.adRatePercent != null
              ? detail.adRatePercent / 100
              : 0;
        if (!valuesMatch(desiredAdRateDecimal, effectiveAdRateDecimal)) {
          const liveAdRateDecimal = detail.liveAdRatePercent != null ? detail.liveAdRatePercent / 100 : 0;
          if (valuesMatch(desiredAdRateDecimal, liveAdRateDecimal) && detail.stagedAdRatePercent != null) {
            operations.push(discardMarketplaceField(detail, "adRate"));
          } else {
            operations.push(stageMarketplaceField(detail, "adRate", desiredAdRateDecimal));
          }
        }
      }

      if (operations.length > 0) {
        await Promise.all(operations);
      }

      const refreshedDetail = await loadDetail();
      await onUpdated();

      if (!openPushReview) {
        setNotice({
          tone: "success",
          message:
            operations.length > 0
              ? "Marketplace edits staged. Use Review Push whenever you are ready."
              : "No marketplace changes were needed. Existing staged values are already current.",
        });
        return;
      }

      if (!refreshedDetail) {
        setNotice({ tone: "error", message: "Marketplace edits were saved, but the refreshed detail could not be loaded." });
        return;
      }

      const nextPushItems: PushItem[] = [];
      if (refreshedDetail.stagedSalePrice != null && !valuesMatch(refreshedDetail.stagedSalePrice, refreshedDetail.liveSalePrice)) {
        nextPushItems.push(buildPushItem(refreshedDetail, "salePrice", refreshedDetail.stagedSalePrice));
      }
      if (
        adRateEditable &&
        refreshedDetail.stagedAdRatePercent != null &&
        !valuesMatch(refreshedDetail.stagedAdRatePercent, refreshedDetail.liveAdRatePercent)
      ) {
        nextPushItems.push(buildPushItem(refreshedDetail, "adRate", refreshedDetail.stagedAdRatePercent));
      }

      if (nextPushItems.length === 0) {
        setNotice({ tone: "info", message: "There are no staged marketplace changes to review for this listing." });
        return;
      }

      setPushItems(nextPushItems);
      setPushOpen(true);
      setNotice({ tone: "success", message: "Marketplace changes are ready. Review the guarded push flow next." });
    } catch (nextError) {
      setNotice({ tone: "error", message: nextError instanceof Error ? nextError.message : "Failed to stage marketplace changes." });
    } finally {
      setSavingMarketplace(false);
    }
  }

  async function handlePushApplied(_: PushApiData) {
    await Promise.all([loadDetail(), onUpdated()]);
    setNotice({ tone: "success", message: "Push applied. Profit Center has been refreshed with the latest marketplace values." });
  }

  return (
    <>
      <div className="fixed inset-0 z-[260] bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-[261] w-[min(900px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 rounded-full border border-sky-500/25 bg-sky-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-200">
              <PencilLine className="h-3.5 w-3.5" />
              Profit Detail Editor
            </div>
            <h2 className="mt-3 text-lg font-semibold text-foreground">
              {detail ? `${detail.sku} | ${PLATFORM_FULL[detail.platform]}` : "Loading listing details"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Edit shared cost inputs here, then stage marketplace changes through the same guarded push flow used by the catalog.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[78vh] space-y-4 overflow-y-auto px-6 py-5">
          <NoticeBanner notice={notice} />
          {loading ? (
            <div className="flex items-center justify-center gap-3 rounded-xl border border-border bg-background/50 px-4 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading the latest SKU and marketplace details...
            </div>
          ) : error ? (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-4 text-sm text-red-200">{error}</div>
          ) : detail ? (
            <>
              <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
                <div className="rounded-xl border border-border bg-background/50 p-4">
                  <div className="flex items-start gap-4">
                    {detail.imageUrl ? (
                      <img src={detail.imageUrl} alt={detail.title} className="h-24 w-24 rounded-xl border border-border object-cover" />
                    ) : (
                      <div className="flex h-24 w-24 items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground">
                        No image
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="inline-flex items-center gap-2">
                        <PlatformIcon platform={detail.platform} size={18} />
                        <span className={cn("rounded-full border px-2.5 py-1 text-xs font-semibold", PLATFORM_COLORS[detail.platform])}>
                          {PLATFORM_FULL[detail.platform]}
                        </span>
                      </div>
                      <h3 className="mt-3 text-lg font-semibold text-foreground">{detail.title}</h3>
                      <div className="mt-2 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                        <div>SKU<div className="font-medium text-foreground">{detail.sku}</div></div>
                        <div>Listing ID<div className="font-medium text-foreground">{detail.listingId}</div></div>
                        <div>UPC<div className="font-medium text-foreground">{detail.upc ?? "--"}</div></div>
                        <div>Inventory<div className="font-medium text-foreground">{detail.inventory == null ? "--" : detail.inventory.toLocaleString()}</div></div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-background/50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Current Economics</div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Profit</div>
                      <div className={cn("mt-1 text-2xl font-semibold", detail.profit < 0 ? "text-red-300" : "text-emerald-300")}>
                        {formatCurrency(detail.profit)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Margin</div>
                      <div className="mt-1 text-2xl font-semibold text-sky-300">{formatPercent(detail.marginPercent)}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Marketplace Fees</div>
                      <div className="mt-1 text-lg font-semibold text-amber-200">{formatCurrency(detail.feeAmount)}</div>
                      <div className="text-xs text-muted-foreground">{formatPercent(detail.platformFeeRatePercent)} fee rate</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Shipping Cost</div>
                      <div className="mt-1 text-lg font-semibold text-foreground">{formatNullableCurrency(detail.shippingCost)}</div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                <section className="rounded-xl border border-border bg-background/50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">Shared Catalog Inputs</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        These save directly to the master row and affect profit math everywhere this SKU appears.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void saveCatalogInputs()}
                      disabled={savingCatalog}
                      className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                    >
                      {savingCatalog ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      Save Catalog Inputs
                    </button>
                  </div>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <label className="space-y-2 text-sm">
                      <span className="text-muted-foreground">Supplier Cost</span>
                      <input
                        value={supplierCostDraft}
                        onChange={(event) => setSupplierCostDraft(event.target.value)}
                        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-foreground outline-none focus:border-sky-500/60"
                        inputMode="decimal"
                        placeholder="0.00"
                      />
                    </label>
                    <label className="space-y-2 text-sm">
                      <span className="text-muted-foreground">Supplier Shipping</span>
                      <input
                        value={supplierShippingDraft}
                        onChange={(event) => setSupplierShippingDraft(event.target.value)}
                        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-foreground outline-none focus:border-sky-500/60"
                        inputMode="decimal"
                        placeholder="0.00"
                      />
                    </label>
                    <label className="space-y-2 text-sm sm:col-span-2">
                      <span className="text-muted-foreground">Weight</span>
                      <input
                        value={weightDraft}
                        onChange={(event) => setWeightDraft(event.target.value)}
                        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-foreground outline-none focus:border-sky-500/60"
                        placeholder="Examples: 5 or 2LBS"
                      />
                    </label>
                  </div>
                </section>
                <section className="rounded-xl border border-border bg-background/50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">Marketplace Edits</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Stage sale price and ad rate here, then use Review Push for the normal dry-run and live push safeguards.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void syncMarketplaceDrafts(false)}
                        disabled={savingMarketplace}
                        className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                      >
                        {savingMarketplace ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        Stage Changes
                      </button>
                      <button
                        type="button"
                        onClick={() => void syncMarketplaceDrafts(true)}
                        disabled={savingMarketplace}
                        className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                      >
                        {savingMarketplace ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                        Review Push
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <label className="space-y-2 text-sm">
                      <span className="text-muted-foreground">Sale Price</span>
                      <input
                        value={salePriceDraft}
                        onChange={(event) => setSalePriceDraft(event.target.value)}
                        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-foreground outline-none focus:border-emerald-500/60"
                        inputMode="decimal"
                        placeholder="0.00"
                      />
                      <div className="text-xs text-muted-foreground">
                        Live {formatCurrency(detail.liveSalePrice)}
                        {detail.stagedSalePrice != null ? ` | Staged ${formatCurrency(detail.stagedSalePrice)}` : ""}
                      </div>
                    </label>
                    <label className="space-y-2 text-sm">
                      <span className="text-muted-foreground">Ad Rate (%)</span>
                      <input
                        value={adRateDraft}
                        onChange={(event) => setAdRateDraft(event.target.value)}
                        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-foreground outline-none focus:border-emerald-500/60 disabled:cursor-not-allowed disabled:opacity-60"
                        inputMode="decimal"
                        placeholder={adRateEditable ? "0.00" : "Not used"}
                        disabled={!adRateEditable}
                      />
                      <div className="text-xs text-muted-foreground">
                        {adRateEditable
                          ? `Live ${detail.liveAdRatePercent == null ? "0.00%" : formatPercent(detail.liveAdRatePercent)}${detail.stagedAdRatePercent != null ? ` | Staged ${formatPercent(detail.stagedAdRatePercent)}` : ""}`
                          : "BigCommerce and Shopify ad rate edits are not used in v1."}
                      </div>
                    </label>
                  </div>
                  <div className="mt-4 rounded-xl border border-border bg-card/70 p-4">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div>
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">Supplier Cost</div>
                        <div className="mt-1 font-medium text-foreground">{formatNullableCurrency(detail.supplierCost)}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">Supplier Shipping</div>
                        <div className="mt-1 font-medium text-foreground">{formatNullableCurrency(detail.supplierShipping)}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">Weight</div>
                        <div className="mt-1 font-medium text-foreground">{detail.weight ?? "--"}</div>
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            </>
          ) : null}
        </div>
      </div>
      <PushConfirmModal
        open={pushOpen}
        onClose={() => setPushOpen(false)}
        items={pushItems}
        onApplied={(result) => void handlePushApplied(result)}
      />
    </>
  );
}

export function ProfitCenterBiggestLosers(props: ProfitCenterBiggestLosersProps) {
  const { initialItems, initialPageSize, initialTotalCount } = props;
  const [items, setItems] = useState(initialItems);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(initialPageSize);
  const [totalCount, setTotalCount] = useState(initialTotalCount);
  const [totalPages, setTotalPages] = useState(Math.max(1, Math.ceil(initialTotalCount / initialPageSize)));
  const [loadingPage, setLoadingPage] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [selectedMarketplaceListingId, setSelectedMarketplaceListingId] = useState<string | null>(null);

  const pageRangeLabel = useMemo(() => {
    if (items.length === 0) return "No listings analyzed yet.";
    const start = (page - 1) * pageSize + 1;
    const end = start + items.length - 1;
    return `Showing ${start.toLocaleString()}-${end.toLocaleString()} of ${totalCount.toLocaleString()} ranked listings`;
  }, [items.length, page, pageSize, totalCount]);

  async function loadPage(nextPage: number) {
    setLoadingPage(true);
    setPageError(null);
    try {
      const response = await fetch(`/api/profit-center/losers?page=${encodeURIComponent(nextPage)}&pageSize=${encodeURIComponent(pageSize)}`, {
        cache: "no-store",
      });
      const data = await parseApiResponse<ProfitCenterLoserPage>(response);
      setItems(data.items);
      setPage(data.page);
      setTotalCount(data.totalCount);
      setTotalPages(data.totalPages);
    } catch (nextError) {
      setPageError(nextError instanceof Error ? nextError.message : "Failed to load the next page of losers.");
    } finally {
      setLoadingPage(false);
    }
  }

  return (
    <>
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              <PencilLine className="h-4 w-4 text-red-300" />
              Biggest Losers
            </div>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              Click any SKU in this ranked list to inspect the exact marketplace row, adjust the cost drivers, and run the
              normal stage-and-push flow without leaving Profit Center.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">{pageRangeLabel}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadPage(page - 1)}
              disabled={loadingPage || page <= 1}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </button>
            <div className="min-w-[96px] text-center text-sm text-muted-foreground">Page {page} of {totalPages}</div>
            <button
              type="button"
              onClick={() => void loadPage(page + 1)}
              disabled={loadingPage || page >= totalPages}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {pageError ? (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{pageError}</div>
        ) : null}

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
              <tr>
                <th className="pb-3 pr-4">SKU / Title</th>
                <th className="pb-3 pr-4">Store</th>
                <th className="pb-3 pr-4">Price</th>
                <th className="pb-3 pr-4">Profit</th>
                <th className="pb-3">Margin</th>
              </tr>
            </thead>
            <tbody>
              {loadingPage ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading the next page of ranked losers...
                    </span>
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    No listings are available in Profit Center yet.
                  </td>
                </tr>
              ) : (
                items.map((entry) => (
                  <tr key={entry.marketplaceListingId ?? `${entry.rowId}-${entry.platform}-${entry.listingId}`} className="border-t border-border/70">
                    <td className="py-3 pr-4">
                      <button
                        type="button"
                        onClick={() => setSelectedMarketplaceListingId(entry.marketplaceListingId)}
                        disabled={!entry.marketplaceListingId}
                        className="group min-w-0 text-left disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                      >
                        <div className="inline-flex items-center gap-2 font-medium text-foreground transition-colors group-hover:text-sky-300">
                          <span>{entry.sku}</span>
                          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-sky-300" />
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{entry.title}</div>
                      </button>
                    </td>
                    <td className="py-3 pr-4">
                      <div className="inline-flex items-center gap-2">
                        <PlatformIcon platform={entry.platform} size={16} />
                        <span className={cn("rounded-full border px-2 py-0.5 text-xs", PLATFORM_COLORS[entry.platform])}>
                          {entry.platform}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-foreground">{formatCurrency(entry.salePrice)}</td>
                    <td className="py-3 pr-4 text-red-300">{formatCurrency(entry.profit)}</td>
                    <td className="py-3 text-amber-300">{formatPercent(entry.marginPercent)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ProfitListingDetailModal
        marketplaceListingId={selectedMarketplaceListingId}
        open={selectedMarketplaceListingId != null}
        onClose={() => setSelectedMarketplaceListingId(null)}
        onUpdated={() => loadPage(page)}
      />
    </>
  );
}
