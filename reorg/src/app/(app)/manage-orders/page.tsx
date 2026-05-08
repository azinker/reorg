"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, MoreHorizontal, PackageCheck, Search, X } from "lucide-react";
import type {
  ManageOrder,
  ManageOrderActionType,
  ManageOrdersSearchResult,
} from "@/lib/manage-orders/types";
import { cn } from "@/lib/utils";

const STORE_LABELS = {
  ALL: "All eBay Stores",
  TPP_EBAY: "TPP eBay",
  TT_EBAY: "TT eBay",
} as const;

const STATUS_OPTIONS = [
  ["awaiting_shipment", "Awaiting Shipment"],
  ["ship_within_24h", "Awaiting Shipment - ship within 24 hours"],
  ["awaiting_expedited", "Awaiting Expedited Shipment"],
] as const;

const PERIOD_OPTIONS = [
  ["last_90_days", "Last 90 Days"],
  ["last_week", "Last Week"],
  ["last_month", "Last Month"],
] as const;

const SEARCH_BY_OPTIONS = [
  ["order_number", "Order Number"],
  ["buyer_username", "Buyer Username"],
  ["buyer_name", "Buyer Name"],
  ["item_id", "Item ID"],
  ["item_title", "Item Title"],
  ["sku", "SKU"],
] as const;

function money(cents: number | null | undefined, currency = "USD") {
  if (cents == null) return "Unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function pdt(value: string | null | undefined) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function orderHref(order: ManageOrder) {
  return `/manage-orders/orders/${order.store}/${encodeURIComponent(order.orderId)}`;
}

function carrierGuess(tracking: string) {
  if (/^9\d{18,25}$/.test(tracking.trim())) return "USPS";
  if (/^1Z/i.test(tracking.trim())) return "UPS";
  if (/^\d{12,15}$/.test(tracking.trim())) return "FedEx";
  return "USPS";
}

export default function ManageOrdersPage() {
  const [store, setStore] = useState<"ALL" | "TPP_EBAY" | "TT_EBAY">("ALL");
  const [status, setStatus] = useState("awaiting_shipment");
  const [period, setPeriod] = useState("last_90_days");
  const [searchBy, setSearchBy] = useState("order_number");
  const [searchTerm, setSearchTerm] = useState("");
  const [result, setResult] = useState<ManageOrdersSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<{ order: ManageOrder; action: ManageOrderActionType } | null>(null);

  async function runSearch(page = 1) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/manage-orders/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ store, status, period, searchBy, searchTerm, page }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Search failed");
      setResult(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  const summary = useMemo(() => {
    if (!result) return "No search run yet";
    if (result.totalCount === 0) return "Results: 0";
    const start = (result.page - 1) * result.pageSize + 1;
    const end = Math.min(result.page * result.pageSize, result.totalCount);
    return `Results: ${start}-${end} of ${result.totalCount}`;
  }, [result]);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Manage Orders</h1>
        <p className="text-sm text-muted-foreground">
          eBay order search and human-confirmed order actions for TPP and TT.
        </p>
      </div>

      <section className="mb-4 rounded-lg border border-border bg-card p-4 shadow-sm">
        <div className="grid gap-3 lg:grid-cols-[180px_260px_160px_180px_1fr_auto]">
          <select value={store} onChange={(e) => setStore(e.target.value as typeof store)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            {Object.entries(STORE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            {STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select value={period} onChange={(e) => setPeriod(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            {PERIOD_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select value={searchBy} onChange={(e) => setSearchBy(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            {SEARCH_BY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
            placeholder="Search orders"
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          />
          <button onClick={() => void runSearch()} disabled={loading} className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Search
          </button>
        </div>
      </section>

      <div className="mb-3 flex items-center justify-between text-sm">
        <span className="font-medium">{summary}</span>
        <span className="text-muted-foreground">Total: {money(result?.totalCents ?? null)}</span>
      </div>

      {error ? <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}

      <section className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="grid grid-cols-[44px_150px_1fr_150px_160px_150px_150px_150px] border-b border-border bg-muted/40 px-3 py-2 text-xs font-semibold text-muted-foreground">
          <div />
          <div>Actions</div>
          <div>Order</div>
          <div>Quantity</div>
          <div>Subtotal</div>
          <div>Total</div>
          <div>Date Sold</div>
          <div>Date Paid</div>
        </div>
        {loading ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-md bg-muted" />)}
          </div>
        ) : result && result.orders.length > 0 ? (
          result.orders.map((order) => (
            <div key={`${order.store}-${order.orderId}`} className="grid grid-cols-[44px_150px_1fr_150px_160px_150px_150px_150px] gap-3 border-b border-border px-3 py-4 text-sm last:border-b-0">
              <div><input type="checkbox" aria-label={`Select ${order.orderId}`} /></div>
              <div className="relative">
                <div className="mb-2 text-xs font-semibold text-emerald-500">{order.shipBy ? `Ship by ${pdt(order.shipBy)}` : "Ready to ship"}</div>
                <button onClick={() => setOpenMenu(openMenu === order.orderId ? null : order.orderId)} className="rounded-md border border-border p-1.5 hover:bg-accent">
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {openMenu === order.orderId ? (
                  <div className="absolute left-0 top-12 z-20 w-52 rounded-md border border-border bg-popover p-1 shadow-lg">
                    {[
                      ["add_tracking", "Add Tracking Number"],
                      ["mark_shipped", "Mark As Shipped"],
                      ["cancel_order", "Cancel Order"],
                      ["message_buyer", "Message Buyer"],
                    ].map(([action, label]) => (
                      <button key={action} onClick={() => { setActiveAction({ order, action: action as ManageOrderActionType }); setOpenMenu(null); }} className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent">{label}</button>
                    ))}
                    <Link href={orderHref(order)} className="block rounded px-2 py-1.5 text-sm hover:bg-accent">View Order Details</Link>
                  </div>
                ) : null}
              </div>
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <Link href={orderHref(order)} className="font-semibold text-primary hover:underline">{order.orderId}</Link>
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", order.store === "TPP_EBAY" ? "bg-blue-500/15 text-blue-400" : "bg-purple-500/15 text-purple-400")}>{order.store === "TPP_EBAY" ? "TPP" : "TT"}</span>
                </div>
                <div className="mb-2 text-xs text-muted-foreground">{order.buyerName ?? "Unknown buyer"} | {order.buyerUsername ?? "no username"} | ZIP {order.shippingPostalCode ?? "N/A"}</div>
                <div className="space-y-3">
                  {order.lines.map((line) => (
                    <div key={`${line.itemId}-${line.sku}`} className="flex gap-3">
                      {line.imageUrl ? <img src={line.imageUrl} alt="" className="h-14 w-14 rounded border border-border object-cover" /> : <div className="flex h-14 w-14 items-center justify-center rounded border border-border bg-muted text-xs text-muted-foreground">No image</div>}
                      <div>
                        {line.listingUrl ? <a href={line.listingUrl} target="_blank" rel="noreferrer" className="line-clamp-1 text-primary hover:underline">{line.title}</a> : <span>{line.title}</span>}
                        <div className="text-xs text-muted-foreground">Item {line.itemId}</div>
                        <div className="text-xs font-medium">SKU {line.sku ?? "N/A"}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <button onClick={() => setActiveAction({ order, action: "add_tracking" })} className="mt-3 text-xs font-semibold text-primary hover:underline">+ Add Tracking</button>
              </div>
              <div>
                <div className="font-medium">Total quantity: {order.lines.reduce((sum, line) => sum + line.quantity, 0)}</div>
                {order.lines.map((line) => <div key={line.sku ?? line.itemId} className="text-xs text-muted-foreground">{line.sku ?? "SKU"}: {line.quantity} ({line.availableQuantity ?? "?"} available)</div>)}
              </div>
              <div>
                <div>{money(order.subtotalCents, order.currency ?? "USD")}</div>
                <div className="text-xs text-muted-foreground">{order.shippingCents ? `Shipping ${money(order.shippingCents, order.currency ?? "USD")}` : "Free shipping"}</div>
              </div>
              <div className="font-medium">{money(order.totalCents, order.currency ?? "USD")}</div>
              <div>{pdt(order.createdTime)}</div>
              <div>{pdt(order.paidTime)}</div>
            </div>
          ))
        ) : (
          <div className="p-10 text-center text-sm text-muted-foreground">
            {result ? "No matching orders found. Try a different search term, status, or period." : "Choose filters, then press Search to fetch fresh eBay order data."}
          </div>
        )}
      </section>

      {activeAction ? <ActionModal active={activeAction} onClose={() => setActiveAction(null)} onDone={() => { setActiveAction(null); void runSearch(result?.page ?? 1); }} /> : null}
    </div>
  );
}

function ActionModal({ active, onClose, onDone }: { active: { order: ManageOrder; action: ManageOrderActionType }; onClose: () => void; onDone: () => void }) {
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState<"USPS" | "UPS" | "FedEx">("USPS");
  const [confirming, setConfirming] = useState(false);
  const [humanActionToken, setHumanActionToken] = useState<string | null>(null);
  const [preparingToken, setPreparingToken] = useState(true);
  const [message, setMessage] = useState("");
  const [sendAutoResponder, setSendAutoResponder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setPreparingToken(true);
    setHumanActionToken(null);
    setError(null);
    fetch("/api/manage-orders/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: active.order.orderId, store: active.order.store, actionType: active.action }),
      signal: controller.signal,
    })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Could not prepare confirmation");
        setHumanActionToken(json.data.humanActionToken);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Could not prepare confirmation");
      })
      .finally(() => setPreparingToken(false));
    return () => controller.abort();
  }, [active.action, active.order.orderId, active.order.store]);

  function onTrackingChange(value: string) {
    setTracking(value);
    setCarrier(carrierGuess(value) as "USPS" | "UPS" | "FedEx");
  }

  async function confirm() {
    setConfirming(true);
    setError(null);
    try {
      if (!humanActionToken) throw new Error("Final confirmation token is not ready. Please reopen the modal.");
      const res = await fetch("/api/manage-orders/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: active.order.orderId,
          store: active.order.store,
          actionType: active.action,
          humanActionToken,
          trackingNumbers: active.action === "add_tracking" ? [{ carrier, trackingNumber: tracking }] : undefined,
          messageBody: active.action === "message_buyer" ? message : undefined,
          sendAutoResponder,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Action failed");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setConfirming(false);
    }
  }

  const title = {
    add_tracking: "Add Tracking Number",
    mark_shipped: "Mark As Shipped",
    cancel_order: "Cancel Order",
    message_buyer: "Message Buyer",
  }[active.action];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="text-sm text-muted-foreground">{active.order.store === "TPP_EBAY" ? "TPP eBay" : "TT eBay"} | {active.order.orderId}</p>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>
        {active.action === "add_tracking" ? (
          <div className="space-y-3">
            <input value={tracking} onChange={(e) => onTrackingChange(e.target.value)} placeholder="Tracking number" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" />
            <select value={carrier} onChange={(e) => setCarrier(e.target.value as typeof carrier)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option>USPS</option><option>UPS</option><option>FedEx</option>
            </select>
            <Warning text="This will add tracking to the live eBay order and mark it as shipped." />
          </div>
        ) : active.action === "mark_shipped" ? (
          <Warning text="This will mark the live eBay order as shipped without adding tracking. This may affect seller metrics and buyer visibility. Continue?" />
        ) : active.action === "cancel_order" ? (
          <Warning text="This will attempt to cancel the live eBay order after final confirmation. Cancellation is currently blocked unless live eBay order actions are enabled and implemented." />
        ) : (
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message body" className="min-h-32 w-full rounded-md border border-input bg-background p-3 text-sm" />
        )}
        {(active.action === "add_tracking" || active.action === "mark_shipped") ? (
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sendAutoResponder} onChange={(e) => setSendAutoResponder(e.target.checked)} />
            Send shipped auto-message if enabled
          </label>
        ) : null}
        {error ? <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent">Cancel</button>
          <button onClick={() => void confirm()} disabled={confirming || preparingToken || !humanActionToken || (active.action === "add_tracking" && !tracking.trim())} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {confirming || preparingToken ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
            Final Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

function Warning({ text }: { text: string }) {
  return <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{text}</div>;
}
