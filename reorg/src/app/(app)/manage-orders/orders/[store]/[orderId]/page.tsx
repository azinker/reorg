"use client";

import Link from "next/link";
import { type MouseEvent, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  MessageSquare,
  PackageCheck,
  PackagePlus,
  X,
} from "lucide-react";
import { useCurrentUser } from "@/contexts/current-user-context";
import type { ManageOrder } from "@/lib/manage-orders/types";
import { cn } from "@/lib/utils";

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
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export default function ManageOrderDetailsPage({
  params,
}: {
  params: Promise<{ store: string; orderId: string }>;
}) {
  const user = useCurrentUser();
  const [routeParams, setRouteParams] = useState<{ store: string; orderId: string } | null>(null);
  const [order, setOrder] = useState<ManageOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messageOpen, setMessageOpen] = useState(false);

  useEffect(() => {
    void params.then(setRouteParams);
  }, [params]);

  useEffect(() => {
    if (!routeParams) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/manage-orders/orders/${routeParams!.store}/${encodeURIComponent(routeParams!.orderId)}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Failed to load order");
        if (!cancelled) setOrder(json.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load order");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [routeParams]);

  if (loading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (error || !order || !routeParams) {
    return <div className="p-6 text-sm text-destructive">{error ?? "Order not found"}</div>;
  }

  const currency = order.currency ?? "USD";

  return (
    <div className="p-6">
      <Link href="/manage-orders" className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to Manage Orders
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <StoreBadge store={order.store} />
            <CopyButton value={order.orderId} title="Copy order number" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">{order.lines[0]?.title ?? "Order Details"}</h1>
          <p className="text-sm text-muted-foreground">{order.store === "TPP_EBAY" ? "TPP eBay" : "TT eBay"} | Order <span className="font-semibold text-primary">{order.orderId}</span></p>
        </div>
        <a href={`/api/manage-orders/orders/${order.store}/${encodeURIComponent(order.orderId)}/packing-slip`} target="_blank" className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
          <FileText className="h-4 w-4" /> Print Packing Slip
        </a>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Shipping timeline</h2>
            <div className="grid gap-3 md:grid-cols-3">
              <Timeline label="Buyer paid" value={pdt(order.paidTime)} tone="emerald" />
              <Timeline label="Ship by" value={pdt(order.shipBy)} tone={order.shipBy ? "amber" : "muted"} />
              <Timeline label="Delivery estimate" value={`${pdt(order.estimatedDeliveryMin)} - ${pdt(order.estimatedDeliveryMax)}`} tone="violet" />
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Shipping</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="text-sm">
                <div className="font-medium">{order.shippingAddress?.name ?? "Unavailable"}</div>
                <div className="text-muted-foreground">{order.shippingAddress?.street1}</div>
                {order.shippingAddress?.street2 ? <div className="text-muted-foreground">{order.shippingAddress.street2}</div> : null}
                <div className="text-muted-foreground">{[order.shippingAddress?.cityName, order.shippingAddress?.stateOrProvince, order.shippingAddress?.postalCode].filter(Boolean).join(", ")}</div>
                {order.shippingAddress?.phone ? <div className="mt-2 text-muted-foreground">Phone: {order.shippingAddress.phone}</div> : null}
              </div>
              <div className="text-sm">
                <div>Service: <span className="font-medium">{order.shippingService ?? "Unavailable"}</span></div>
                <div className="mt-2">Tracking:</div>
                {order.trackingNumbers.length ? order.trackingNumbers.map((tracking) => (
                  tracking.number ? <div key={tracking.number} className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">{tracking.carrier ?? "Carrier"} | {tracking.number}<CopyButton value={tracking.number} title="Copy tracking number" compact /></div> : null
                )) : <div className="text-muted-foreground">No tracking yet</div>}
                <Link href={`/manage-orders?order=${encodeURIComponent(order.orderId)}`} className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
                  <PackagePlus className="h-4 w-4" /> Add Tracking
                </Link>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Items</h2>
            <div className="space-y-4">
              {order.lines.map((line) => (
                <div key={`${line.itemId}-${line.sku}`} className="flex gap-4 rounded-md border border-border p-3">
                  {line.imageUrl ? <img src={line.imageUrl} alt="" className="h-20 w-20 rounded border border-border object-cover" /> : <div className="flex h-20 w-20 items-center justify-center rounded border border-border bg-muted text-xs text-muted-foreground">No image</div>}
                  <div className="min-w-0 flex-1">
                    {line.listingUrl ? <a href={line.listingUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">{line.title}<ExternalLink className="h-3.5 w-3.5" /></a> : <div className="font-medium">{line.title}</div>}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                      <span className="inline-flex items-center gap-1 rounded border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 font-semibold text-violet-300">SKU {line.sku ?? "N/A"}{line.sku ? <CopyButton value={line.sku} title="Copy SKU" compact /> : null}</span>
                      <span className="text-muted-foreground">Item {line.itemId}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-sm">
                      <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 font-semibold text-emerald-300">Qty {line.quantity}</span>
                      <span className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-sky-300">eBay available {line.availableQuantity ?? "Unavailable"}</span>
                      <span className="rounded border border-border bg-background px-2 py-1">Price {money(line.unitPriceCents, currency)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="space-y-6">
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Order summary</h2>
            <Summary label="Order number" value={order.orderId} />
            <Summary label="Sales record" value={order.salesRecordNumber ?? "Unavailable"} />
            <Summary label="Date sold" value={pdt(order.createdTime)} />
            <Summary label="Date paid" value={pdt(order.paidTime)} />
            <Summary label="Buyer" value={order.buyerName ?? "Unavailable"} />
            <Summary label="Username" value={order.buyerUsername ?? "Unavailable"} />
            <button onClick={() => setMessageOpen(true)} className="mt-4 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent">
              <MessageSquare className="h-4 w-4" /> Message Buyer
            </button>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Payment / finances</h2>
            <Summary label="Subtotal" value={money(order.subtotalCents, currency)} />
            <Summary label="Shipping" value={order.shippingCents ? money(order.shippingCents, currency) : "Free shipping"} />
            <Summary label="Sales tax" value={order.taxCents != null ? money(order.taxCents, currency) : "Unavailable"} />
            <Summary label="Order total" value={money(order.totalCents, currency)} strong />
            <Summary label="Transaction fees" value={order.finance.transactionFeesCents != null ? money(order.finance.transactionFeesCents, currency) : "Unavailable"} />
            <Summary label="Ad fee general" value={order.finance.adFeeCents != null ? money(order.finance.adFeeCents, currency) : "Unavailable"} />
            <Summary label="Other fees" value={order.finance.otherFeesCents != null ? money(order.finance.otherFeesCents, currency) : "Unavailable"} />
            <Summary label="Order earnings" value={order.finance.orderEarningsCents != null ? money(order.finance.orderEarningsCents, currency) : "Unavailable"} strong />
          </section>

          {user?.role === "ADMIN" ? (
            <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-5">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-amber-300">Internal profit / COGS</h2>
              <Summary label="Item cost" value={order.internalProfit.itemCostCents != null ? money(order.internalProfit.itemCostCents, currency) : "Unavailable"} />
              <Summary label="Supplier shipping" value={order.internalProfit.supplierShippingCents != null ? money(order.internalProfit.supplierShippingCents, currency) : "Unavailable"} />
              <Summary label="Outbound shipping" value={order.internalProfit.outboundShippingCents != null ? money(order.internalProfit.outboundShippingCents, currency) : "Unavailable"} />
              <Summary label="Total COGS" value={order.internalProfit.totalCogsCents != null ? money(order.internalProfit.totalCogsCents, currency) : "Unavailable"} strong />
              <Summary label="Estimated profit" value={order.internalProfit.estimatedProfitCents != null ? money(order.internalProfit.estimatedProfitCents, currency) : "Unavailable"} strong />
            </section>
          ) : null}
        </aside>
      </div>
      {messageOpen ? <MessageBuyerModal order={order} onClose={() => setMessageOpen(false)} /> : null}
    </div>
  );
}

function Timeline({ label, value, tone }: { label: string; value: string; tone: "emerald" | "amber" | "violet" | "muted" }) {
  const cls = {
    emerald: "border-emerald-500/30 bg-emerald-500/10",
    amber: "border-amber-500/30 bg-amber-500/10",
    violet: "border-violet-500/30 bg-violet-500/10",
    muted: "border-border bg-background",
  }[tone];
  return <div className={cn("rounded-md border p-3", cls)}><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-sm font-medium">{value}</div></div>;
}

function Summary({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div className="flex justify-between gap-3 border-b border-border py-2 text-sm last:border-b-0"><span className="text-muted-foreground">{label}</span><span className={strong ? "font-semibold" : "font-medium"}>{value}</span></div>;
}

function EbayLogo({ small }: { small?: boolean }) {
  return (
    <span className={cn("inline-flex items-baseline rounded border border-border bg-background font-bold leading-none", small ? "px-1 py-0 text-[10px]" : "px-2 py-1 text-sm")}>
      <span className="text-blue-400">e</span>
      <span className="text-red-400">B</span>
      <span className="text-yellow-300">a</span>
      <span className="text-emerald-400">y</span>
    </span>
  );
}

function StoreBadge({ store }: { store: ManageOrder["store"] }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-bold uppercase tracking-wide",
      store === "TPP_EBAY"
        ? "border-violet-500/40 bg-violet-500/10 text-violet-300"
        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    )}>
      <EbayLogo small /> {store === "TPP_EBAY" ? "TPP" : "TT"}
    </span>
  );
}

function CopyButton({ value, title, compact }: { value: string; title: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  function copy(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 900);
    });
  }
  return (
    <button type="button" onClick={copy} title={copied ? "Copied!" : title} className={cn("inline-flex cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground", compact ? "h-4 w-4" : "h-6 w-6")}>
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function MessageBuyerModal({ order, onClose }: { order: ManageOrder; onClose: () => void }) {
  const [body, setBody] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setPreparing(true);
    fetch("/api/manage-orders/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: order.orderId, store: order.store, actionType: "message_buyer" }),
      signal: controller.signal,
    })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Could not prepare message confirmation");
        setToken(json.data.humanActionToken);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Could not prepare message confirmation");
      })
      .finally(() => setPreparing(false));
    return () => controller.abort();
  }, [order.orderId, order.store]);

  async function send() {
    if (!token) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/manage-orders/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: order.orderId,
          store: order.store,
          actionType: "message_buyer",
          humanActionToken: token,
          messageBody: body,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Message failed");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Message failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Message Buyer</h2>
            <p className="text-sm text-muted-foreground">{order.buyerName ?? order.buyerUsername ?? "Buyer"} | {order.orderId}</p>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>
        <div className="mb-3 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Sending buyer messages remains guarded by Help Desk safety and requires final confirmation.
        </div>
        <textarea value={body} onChange={(event) => setBody(event.target.value)} className="min-h-40 w-full rounded-md border border-input bg-background p-3 text-sm" placeholder="Type the buyer message..." />
        {error ? <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent">Cancel</button>
          <button onClick={() => void send()} disabled={preparing || sending || !token || !body.trim()} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {preparing || sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
            Final Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
