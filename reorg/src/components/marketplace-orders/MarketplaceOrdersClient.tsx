"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  PackageCheck,
  RefreshCw,
  Truck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  LABEL_FORMATTER_RESHIP_ZIP_FILENAME,
  type LabelFormatterRow,
} from "@/lib/label-formatter/types";
import type { MarketplaceOrderRow } from "@/lib/marketplace-orders/types";
import {
  ShipOrdersModal,
  type ShipOrdersFormValues,
} from "@/components/label-formatter/ShipOrdersModal";

type TabKey = "newegg" | "etsy";

type Banner = {
  type: "success" | "warning" | "error" | "info";
  message: string;
};

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function toLabelFormatterRow(row: MarketplaceOrderRow): LabelFormatterRow {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    sourceStore: row.store,
    buyerName: row.buyerName,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    state: row.state,
    zipCode: row.zipCode,
    lineItems: row.lineItems.map((item) => ({
      sku: item.sku,
      quantity: item.quantity,
    })),
  };
}

function bannerClass(type: Banner["type"]) {
  switch (type) {
    case "success":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "warning":
      return "border-amber-500/30 bg-amber-500/10 text-amber-200";
    case "error":
      return "border-red-500/30 bg-red-500/10 text-red-300";
    default:
      return "border-blue-500/30 bg-blue-500/10 text-blue-200";
  }
}

export function MarketplaceOrdersClient() {
  const [tab, setTab] = useState<TabKey>("newegg");
  const [neweggOrders, setNeweggOrders] = useState<MarketplaceOrderRow[]>([]);
  const [neweggConfigured, setNeweggConfigured] = useState<boolean | null>(null);
  const [neweggMessage, setNeweggMessage] = useState<string | null>(null);
  const [etsyMessage, setEtsyMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shipLoading, setShipLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("0");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [shipModalOpen, setShipModalOpen] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);

  const loadNewegg = useCallback(async () => {
    setLoading(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/marketplace-orders/newegg?status=${encodeURIComponent(statusFilter)}`, {
        cache: "no-store",
      });
      const json = await res.json() as {
        configured?: boolean;
        orders?: MarketplaceOrderRow[];
        message?: string;
        error?: string;
        count?: number;
      };
      if (!res.ok) throw new Error(json.error ?? "Failed to load Newegg orders.");
      setNeweggConfigured(json.configured ?? false);
      setNeweggMessage(json.message ?? null);
      setNeweggOrders(json.orders ?? []);
    } catch (error) {
      setNeweggOrders([]);
      setNeweggConfigured(false);
      setBanner({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to load Newegg orders.",
      });
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  const loadEtsy = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/marketplace-orders/etsy", { cache: "no-store" });
      const json = await res.json() as { message?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to load Etsy status.");
      setEtsyMessage(json.message ?? null);
    } catch (error) {
      setEtsyMessage(error instanceof Error ? error.message : "Failed to load Etsy status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "newegg") void loadNewegg();
    else void loadEtsy();
  }, [tab, loadNewegg, loadEtsy]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [tab, neweggOrders]);

  const selectedRows = useMemo(
    () => neweggOrders.filter((row) => selectedIds.has(row.id) && row.canShip),
    [neweggOrders, selectedIds],
  );

  const selectableRows = useMemo(
    () => neweggOrders.filter((row) => row.canShip),
    [neweggOrders],
  );

  const allSelected = selectableRows.length > 0
    && selectableRows.every((row) => selectedIds.has(row.id));

  function toggleRow(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(selectableRows.map((row) => row.id)));
  }

  async function handleShip(values: ShipOrdersFormValues, options?: { pushMarketplaceTracking?: boolean }) {
    if (selectedRows.length === 0) return;
    setShipLoading(true);
    setBanner(null);
    try {
      const payload = {
        rows: selectedRows.map((row) => ({
          ...toLabelFormatterRow(row),
          shipService: row.shipService ?? undefined,
          lineItems: row.lineItems.map((item) => ({
            sku: item.sku,
            quantity: item.quantity,
            sellerPartNumber: item.sellerPartNumber,
            neweggItemNumber: item.neweggItemNumber,
          })),
        })),
        serviceClass: values.serviceClass,
        providerKey: values.providerKey,
        seriesCode: values.seriesCode,
        fromAddress: values.fromAddress,
        confirmMarketplaceTracking: options?.pushMarketplaceTracking === true,
      };

      const res = await fetch("/api/marketplace-orders/newegg/ship", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const contentType = res.headers.get("Content-Type") ?? "";
      if (contentType.includes("application/zip")) {
        const blob = await res.blob();
        triggerDownload(blob, LABEL_FORMATTER_RESHIP_ZIP_FILENAME);

        const successCount = Number(res.headers.get("X-Label-Formatter-Reship-Success") ?? 0);
        const failedCount = Number(res.headers.get("X-Label-Formatter-Reship-Failed") ?? 0);
        const trackingPushed = Number(res.headers.get("X-Marketplace-Tracking-Pushed") ?? 0);
        const trackingFailed = Number(res.headers.get("X-Marketplace-Tracking-Failed") ?? 0);
        const firstError = res.headers.get("X-Label-Formatter-Reship-First-Error");

        if (successCount === 0) {
          setBanner({
            type: "error",
            message: firstError ?? "No labels were created.",
          });
        } else {
          const parts = [
            `Created ${successCount} label${successCount === 1 ? "" : "s"}.`,
            trackingPushed > 0 ? `Pushed tracking for ${trackingPushed} order${trackingPushed === 1 ? "" : "s"} on Newegg.` : null,
            trackingFailed > 0 ? `${trackingFailed} Newegg tracking push${trackingFailed === 1 ? "" : "es"} failed — check Engine Room audit logs.` : null,
            options?.pushMarketplaceTracking && trackingPushed === 0 && trackingFailed === 0 && successCount > 0
              ? "Labels were created but Newegg was not updated — verify the tracking checkbox was enabled."
              : null,
            failedCount > 0 ? `${failedCount} label${failedCount === 1 ? "" : "s"} failed.` : null,
            firstError ? firstError : null,
          ].filter(Boolean);
          setBanner({
            type: failedCount > 0 || trackingFailed > 0 ? "warning" : "success",
            message: parts.join(" "),
          });
          setShipModalOpen(false);
          setSelectedIds(new Set());
          await loadNewegg();
        }
        return;
      }

      const json = await res.json().catch(() => ({})) as { error?: string; hint?: string };
      setBanner({
        type: "error",
        message: [json.error, json.hint].filter(Boolean).join(" "),
      });
    } catch (error) {
      setBanner({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to ship orders.",
      });
    } finally {
      setShipLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <PackageCheck className="h-6 w-6 text-white/60 shrink-0" />
          <div>
            <h1 className="text-xl font-semibold text-white">Newegg &amp; Etsy Orders</h1>
            <p className="text-sm text-white/50 mt-0.5 max-w-3xl">
              Load marketplace orders, create LabelCrow shipping labels, and push USPS tracking back to Newegg.
              Etsy sync is stubbed until API keys are approved.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => (tab === "newegg" ? void loadNewegg() : void loadEtsy())}
          disabled={loading}
          className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-border px-4 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </button>
      </div>

      {banner ? (
        <p className={cn("rounded-md border px-4 py-3 text-sm", bannerClass(banner.type))}>
          {banner.message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
        {(["newegg", "etsy"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              "cursor-pointer rounded-md px-4 py-2 text-sm font-medium transition-colors",
              tab === key
                ? "bg-primary text-primary-foreground"
                : "text-white/60 hover:bg-accent hover:text-white",
            )}
          >
            {key === "newegg" ? "Newegg" : "Etsy"}
          </button>
        ))}
      </div>

      {tab === "newegg" ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-white/70">
                Status
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  className="h-9 cursor-pointer rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="0">Unshipped</option>
                  <option value="1">Partially shipped</option>
                  <option value="5">Ready to pick up</option>
                  <option value="2">Shipped</option>
                  <option value="all">All statuses</option>
                </select>
              </label>
              <span className="text-sm text-white/50">
                {loading ? "Loading…" : `${neweggOrders.length} order${neweggOrders.length === 1 ? "" : "s"}`}
              </span>
            </div>
            <button
              type="button"
              disabled={selectedRows.length === 0 || shipLoading || neweggConfigured === false}
              onClick={() => setShipModalOpen(true)}
              className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {shipLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
              Ship Orders ({selectedRows.length})
            </button>
          </div>

          {neweggConfigured === false ? (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              {neweggMessage ?? "Newegg credentials are not configured. Add NEWEGG_SELLER_ID, NEWEGG_API_KEY, and NEWEGG_SECRET_KEY in Vercel."}
            </p>
          ) : null}

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="min-w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-white/50">
                <tr>
                  <th className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      disabled={selectableRows.length === 0}
                      className="cursor-pointer"
                      aria-label="Select all shippable orders"
                    />
                  </th>
                  <th className="px-4 py-3">Order</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Buyer</th>
                  <th className="px-4 py-3">Ship To</th>
                  <th className="px-4 py-3">SKUs</th>
                  <th className="px-4 py-3">Tracking</th>
                </tr>
              </thead>
              <tbody>
                {loading && neweggOrders.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-white/50">
                      <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                    </td>
                  </tr>
                ) : null}
                {!loading && neweggOrders.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-white/50">
                      No orders found for this filter.
                    </td>
                  </tr>
                ) : null}
                {neweggOrders.map((row) => {
                  const skuSummary = row.lineItems
                    .map((item) => `${item.sku} × ${item.quantity}`)
                    .join(", ");
                  const address = [row.city, row.state, row.zipCode].filter(Boolean).join(", ");
                  return (
                    <tr key={row.id} className="border-t border-border/60 hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(row.id)}
                          onChange={() => toggleRow(row.id)}
                          disabled={!row.canShip}
                          className="cursor-pointer disabled:cursor-not-allowed"
                          aria-label={`Select order ${row.orderNumber}`}
                        />
                      </td>
                      <td className="px-4 py-3 font-medium text-white">{row.orderNumber}</td>
                      <td className="px-4 py-3 text-white/70">{row.orderDate || "—"}</td>
                      <td className="px-4 py-3 text-white/70">{row.orderStatus}</td>
                      <td className="px-4 py-3 text-white/70">{row.buyerName}</td>
                      <td className="px-4 py-3 text-white/70">
                        <div>{row.addressLine1}</div>
                        {row.addressLine2 ? <div>{row.addressLine2}</div> : null}
                        <div>{address}</div>
                      </td>
                      <td className="px-4 py-3 text-xs text-white/70">{skuSummary}</td>
                      <td className="px-4 py-3 text-xs text-white/70">
                        {row.trackingNumbers.length ? row.trackingNumbers.join(", ") : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-border bg-muted/20 px-6 py-10 text-center">
          <p className="text-sm text-white/70">
            {etsyMessage ?? "Etsy order sync is not enabled in v1. API keys are pending approval."}
          </p>
        </div>
      )}

      {shipModalOpen ? (
        <ShipOrdersModal
          rows={selectedRows.map(toLabelFormatterRow)}
          loading={shipLoading}
          onClose={() => setShipModalOpen(false)}
          onConfirm={(values, options) => void handleShip(values, options)}
          marketplacePushTracking={{
            label: "Push USPS tracking to Newegg after labels are created",
            defaultChecked: true,
            confirmHint: "This writes tracking numbers to Newegg for successfully labeled orders.",
          }}
        />
      ) : null}
    </div>
  );
}
