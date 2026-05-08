"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, FileText, Loader2, MessageSquare, PackagePlus } from "lucide-react";
import { useCurrentUser } from "@/contexts/current-user-context";
import type { ManageOrder } from "@/lib/manage-orders/types";

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
          <h1 className="text-2xl font-bold tracking-tight">{order.lines[0]?.title ?? "Order Details"}</h1>
          <p className="text-sm text-muted-foreground">{order.store === "TPP_EBAY" ? "TPP eBay" : "TT eBay"} | Order {order.orderId}</p>
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
              <Timeline label="Buyer paid" value={pdt(order.paidTime)} />
              <Timeline label="Ship by" value={pdt(order.shipBy)} />
              <Timeline label="Delivery estimate" value={`${pdt(order.estimatedDeliveryMin)} - ${pdt(order.estimatedDeliveryMax)}`} />
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
                  <div key={tracking.number} className="text-muted-foreground">{tracking.carrier ?? "Carrier"} | {tracking.number}</div>
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
                    {line.listingUrl ? <a href={line.listingUrl} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">{line.title}</a> : <div className="font-medium">{line.title}</div>}
                    <div className="mt-1 text-sm text-muted-foreground">SKU {line.sku ?? "N/A"} | Item {line.itemId}</div>
                    <div className="mt-1 text-sm">Qty {line.quantity} | eBay available {line.availableQuantity ?? "Unavailable"} | Price {money(line.unitPriceCents, currency)}</div>
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
            <button className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent">
              <MessageSquare className="h-4 w-4" /> Message Buyer
            </button>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Payment / finances</h2>
            <Summary label="Subtotal" value={money(order.subtotalCents, currency)} />
            <Summary label="Shipping" value={order.shippingCents ? money(order.shippingCents, currency) : "Free shipping"} />
            <Summary label="Sales tax" value={order.taxCents != null ? money(order.taxCents, currency) : "Unavailable"} />
            <Summary label="Order total" value={money(order.totalCents, currency)} strong />
            <Summary label="Transaction fees" value="Unavailable" />
            <Summary label="Ad fee general" value="Unavailable" />
            <Summary label="Order earnings" value="Unavailable" />
          </section>

          {user?.role === "ADMIN" ? (
            <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-5">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-amber-300">Internal profit / COGS</h2>
              <p className="text-sm text-muted-foreground">
                Internal COGS/profit details are unavailable for this live eBay order unless matched cost data is present in the catalog.
              </p>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function Timeline({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-border bg-background p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-sm font-medium">{value}</div></div>;
}

function Summary({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div className="flex justify-between gap-3 border-b border-border py-2 text-sm last:border-b-0"><span className="text-muted-foreground">{label}</span><span className={strong ? "font-semibold" : "font-medium"}>{value}</span></div>;
}
