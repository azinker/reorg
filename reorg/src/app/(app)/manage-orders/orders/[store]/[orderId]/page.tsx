"use client";

import Link from "next/link";
import { type MouseEvent, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Info,
  Loader2,
  MessageSquare,
  PackageCheck,
  PackagePlus,
  Plus,
  Printer,
  Trash2,
  Truck,
  X,
} from "lucide-react";
import { useCurrentUser } from "@/contexts/current-user-context";
import type { ManageOrder, ManageOrderActionType } from "@/lib/manage-orders/types";
import { cn } from "@/lib/utils";

function money(cents: number | null | undefined, currency = "USD") {
  if (cents == null) return "Unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function feeMoney(cents: number | null | undefined, currency = "USD") {
  if (cents == null) return "Unavailable";
  return `-${money(Math.abs(cents), currency)}`;
}

function dateOnly(value: string | null | undefined) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function orderStatus(order: ManageOrder) {
  return order.shippedTime || order.trackingNumbers.length ? "Shipped" : "Awaiting shipment";
}

function firstTracking(order: ManageOrder) {
  return order.trackingNumbers.find((tracking) => tracking.number) ?? null;
}

function validTrackings(order: ManageOrder) {
  return order.trackingNumbers.filter((tracking) => tracking.number);
}

function carrierGuess(tracking: string) {
  if (/^9\d{18,25}$/.test(tracking.trim())) return "USPS";
  if (/^1Z/i.test(tracking.trim())) return "UPS";
  if (/^\d{12,15}$/.test(tracking.trim())) return "FedEx";
  return "USPS";
}

function trackingUrl(carrier: string | null | undefined, trackingNumber: string) {
  const normalizedCarrier = (carrier ?? carrierGuess(trackingNumber)).toUpperCase();
  const encoded = encodeURIComponent(trackingNumber);
  if (normalizedCarrier.includes("UPS")) return `https://www.ups.com/track?tracknum=${encoded}`;
  if (normalizedCarrier.includes("FEDEX")) return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
  return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encoded}`;
}

function variationText(line: ManageOrder["lines"][number]) {
  return line.variationSelections.map((selection) => `${selection.name}: ${selection.value}`).join("   ");
}

function labelCreatedDate(order: ManageOrder) {
  return firstTracking(order)?.shippedTime ?? order.shippedTime;
}

function fundsStatusLabel(status: string | null | undefined) {
  if (!status) return "Unavailable";
  const normalized = status.replace(/_/g, " ").toLowerCase();
  if (normalized.includes("processing")) return "Processing";
  if (normalized.includes("hold")) return "On hold";
  if (normalized.includes("available")) return "Available";
  if (normalized.includes("payout")) return "Paid out";
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function feedbackToneClasses(order: ManageOrder) {
  const first = order.feedback.items[0];
  if (first?.isAutomated) return "border-sky-500/30 bg-sky-500/10 text-sky-200";
  if (first?.kind === "POSITIVE") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (first?.kind === "NEGATIVE") return "border-red-500/35 bg-red-500/10 text-red-200";
  if (first?.kind === "NEUTRAL") return "border-amber-500/35 bg-amber-500/10 text-amber-200";
  if (order.feedback.state === "NOT_LEFT") return "border-zinc-500/30 bg-zinc-500/10 text-zinc-200";
  return "border-muted-foreground/25 bg-muted/40 text-muted-foreground";
}

function feedbackSummaryText(order: ManageOrder) {
  const first = order.feedback.items[0];
  if (first?.isAutomated) return "Automated positive feedback";
  if (first) return `${first.kind.toLowerCase()} feedback left`;
  if (order.feedback.state === "NOT_LEFT") return "No feedback left";
  return "Feedback not checked";
}

function feedbackDetailText(order: ManageOrder) {
  const first = order.feedback.items[0];
  if (first?.comment) return first.comment;
  if (first) return `Left ${dateOnly(first.leftAt)}`;
  if (order.feedback.leaveBy) return `Buyer can leave feedback until ${dateOnly(order.feedback.leaveBy)}`;
  return order.feedback.reason ?? null;
}

function caseToneClasses(order: ManageOrder) {
  if (order.cases.openCount > 0) return "border-red-500/40 bg-red-500/15 text-red-100";
  return "border-amber-500/35 bg-amber-500/10 text-amber-100";
}

function EbayLogoImage({ compact }: { compact?: boolean }) {
  return (
    <img
      src="https://upload.wikimedia.org/wikipedia/commons/1/1b/EBay_logo.svg"
      alt="eBay"
      className={cn("block object-contain", compact ? "h-3.5 w-9" : "h-5 w-14")}
    />
  );
}

const SELECT_CLASS =
  "reorg-themed-select cursor-pointer rounded-md border border-input bg-background text-foreground outline-none [color-scheme:dark] focus:border-primary";

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
  const [trackingOpen, setTrackingOpen] = useState(false);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"mark_shipped" | "cancel_order" | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

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
        const contentType = res.headers.get("content-type") ?? "";
        const json = contentType.includes("application/json") ? await res.json() : null;
        if (!res.ok) throw new Error(json.error ?? "Failed to load order");
        if (!json?.data) throw new Error("Order details returned an unexpected response. Please try again.");
        if (!cancelled) setOrder(json.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load order");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [routeParams, reloadNonce]);

  const currency = order?.currency ?? "USD";
  const primaryLine = order?.lines[0] ?? null;
  const buyerPaidTotal = useMemo(() => {
    if (!order) return null;
    if (order.totalCents != null) return order.totalCents;
    if (order.subtotalCents == null) return null;
    return order.subtotalCents + (order.shippingCents ?? 0) + (order.taxCents ?? 0);
  }, [order]);

  if (loading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (error || !order || !routeParams) {
    return <div className="p-6 text-sm text-destructive">{error ?? "Order not found"}</div>;
  }

  const tracking = firstTracking(order);
  const trackings = validTrackings(order);

  return (
    <div className="p-6">
      <Link href="/manage-orders" className="mb-4 inline-flex cursor-pointer items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to Manage Orders
      </Link>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="mb-3 flex items-center gap-2">
            <StoreBadge store={order.store} />
            <CopyButton value={order.orderId} title="Copy order number" compact />
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Order details</h1>
        </div>
        <a href={`/api/manage-orders/orders/${order.store}/${encodeURIComponent(order.orderId)}/packing-slip`} target="_blank" className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
          <Printer className="h-4 w-4" /> Print packing slip
        </a>
      </div>

      <div className="mb-5 flex items-center gap-4">
        {primaryLine?.imageUrl ? <img src={primaryLine.imageUrl} alt="" className="h-16 w-16 rounded-md border border-border object-cover" /> : <div className="flex h-16 w-16 items-center justify-center rounded-md border border-border bg-muted text-xs text-muted-foreground">No image</div>}
        <div className="min-w-0">
          {primaryLine?.listingUrl ? (
            <a href={primaryLine.listingUrl} target="_blank" rel="noreferrer" className="line-clamp-2 inline-flex items-center gap-1 text-xl font-semibold text-foreground hover:text-primary hover:underline">
              {primaryLine.title}<ExternalLink className="h-4 w-4 shrink-0" />
            </a>
          ) : (
            <div className="text-xl font-semibold">{primaryLine?.title ?? "Order details"}</div>
          )}
          <div className="mt-1 text-sm text-muted-foreground">{order.store === "TPP_EBAY" ? "TPP eBay" : "TT eBay"} | Order <span className="font-semibold text-primary">{order.orderId}</span></div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_390px]">
        <main className="space-y-5">
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold">{orderStatus(order)}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {labelCreatedDate(order) ? `Label created ${dateOnly(labelCreatedDate(order))}. ` : null}
                  {order.shipBy ? `Ship by ${dateOnly(order.shipBy)}. ` : null}
                  {order.estimatedDeliveryMin || order.estimatedDeliveryMax ? `Estimated delivery ${dateOnly(order.estimatedDeliveryMin)} - ${dateOnly(order.estimatedDeliveryMax)}.` : null}
                </p>
              </div>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMoreActionsOpen((open) => !open)}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-primary/50 px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/10"
                  aria-haspopup="menu"
                  aria-expanded={moreActionsOpen}
                >
                  More actions <ChevronDown className="h-4 w-4" />
                </button>
                {moreActionsOpen ? (
                  <div className="absolute right-0 top-11 z-20 w-56 rounded-md border border-border bg-popover p-1 shadow-lg">
                    <button
                      type="button"
                      onClick={() => {
                        setMoreActionsOpen(false);
                        setTrackingOpen(true);
                      }}
                      className="block w-full cursor-pointer rounded px-3 py-2 text-left text-sm hover:bg-accent"
                    >
                      Add Tracking Number
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreActionsOpen(false);
                        setConfirmAction("mark_shipped");
                      }}
                      className="block w-full cursor-pointer rounded px-3 py-2 text-left text-sm hover:bg-accent"
                    >
                      Mark As Shipped
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreActionsOpen(false);
                        setConfirmAction("cancel_order");
                      }}
                      className="block w-full cursor-pointer rounded px-3 py-2 text-left text-sm hover:bg-accent"
                    >
                      Cancel Order
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreActionsOpen(false);
                        setMessageOpen(true);
                      }}
                      className="block w-full cursor-pointer rounded px-3 py-2 text-left text-sm hover:bg-accent"
                    >
                      Message Buyer
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="relative mt-8 grid grid-cols-3 gap-4">
              <div className="absolute left-8 right-8 top-3 h-1 rounded-full bg-muted" />
              <div className={cn("absolute left-8 top-3 h-1 rounded-full bg-primary", orderStatus(order) === "Shipped" ? "right-[calc(33.333%+2rem)]" : "right-[calc(66.666%+2rem)]")} />
              <TimelineDot label="Buyer paid" value={dateOnly(order.paidTime)} active />
              <TimelineDot label={orderStatus(order)} value={labelCreatedDate(order) ? `Label created ${dateOnly(labelCreatedDate(order))}` : dateOnly(order.shipBy)} active={orderStatus(order) === "Shipped"} />
              <TimelineDot label="Delivery" value={`${dateOnly(order.estimatedDeliveryMin)} - ${dateOnly(order.estimatedDeliveryMax)}`} active={false} />
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-4 text-xl font-bold">Shipping</h2>
            <div className="mb-4 flex items-center justify-between rounded-lg border border-border bg-muted/40 px-4 py-3">
              <div className="inline-flex items-center gap-2 font-semibold"><Truck className="h-4 w-4" /> Shipping instructions</div>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="grid gap-5 md:grid-cols-[1fr_1.2fr]">
              <div className="text-sm">
                <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Ship to</div>
                <div className="inline-flex items-center gap-1 font-semibold">
                  {order.shippingAddress?.name ?? "Unavailable"}
                  {order.shippingAddress?.name ? <CopyButton value={order.shippingAddress.name} title="Copy ship-to name" compact /> : null}
                </div>
                <div className="mt-2 text-muted-foreground">{order.shippingAddress?.street1}</div>
                {order.shippingAddress?.street2 ? <div className="text-muted-foreground">{order.shippingAddress.street2}</div> : null}
                <div className="text-muted-foreground">{[order.shippingAddress?.cityName, order.shippingAddress?.stateOrProvince, order.shippingAddress?.postalCode].filter(Boolean).join(", ")}</div>
                <div className="text-muted-foreground">{order.shippingAddress?.countryName}</div>
                {order.shippingAddress?.phone ? <div className="mt-4"><div className="text-xs text-muted-foreground">Phone</div><div>{order.shippingAddress.phone}</div></div> : null}
              </div>
              <div className="grid gap-4 text-sm md:grid-cols-2">
                <div>
                  <div className="text-xs text-muted-foreground">Buyer selected shipping service</div>
                  <div className="mt-1 font-semibold">{order.shippingService ?? "Unavailable"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Tracking</div>
                  {trackings.length ? (
                    <div className="mt-2 flex flex-col gap-2">
                      {trackings.map((trackingRow) => (
                        <div key={`${trackingRow.carrier}-${trackingRow.number}`} className="inline-flex w-fit max-w-full items-center gap-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 font-medium text-emerald-300">
                          <a href={trackingUrl(trackingRow.carrier, trackingRow.number!)} target="_blank" rel="noreferrer" className="truncate hover:underline">
                            {trackingRow.carrier ?? "Carrier"} | {trackingRow.number}
                          </a>
                          <CopyButton value={trackingRow.number!} title="Copy tracking number" compact />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-1 text-muted-foreground">No tracking yet</div>
                  )}
                  <button type="button" onClick={() => setTrackingOpen(true)} className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-md border border-primary/45 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10">
                    <Plus className="h-4 w-4" /> Add tracking
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-4 text-xl font-bold">Item</h2>
            <div className="space-y-4">
              {order.lines.map((line) => (
                <div key={`${line.itemId}-${line.sku}`} className="grid gap-4 rounded-lg border border-border p-4 md:grid-cols-[96px_minmax(260px,1fr)_120px_130px_130px]">
                  {line.imageUrl ? <img src={line.imageUrl} alt="" className="h-24 w-24 rounded-md border border-border object-cover" /> : <div className="flex h-24 w-24 items-center justify-center rounded-md border border-border bg-muted text-xs text-muted-foreground">No image</div>}
                  <div className="min-w-0 text-sm">
                    {line.listingUrl ? <a href={line.listingUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">{line.title}<ExternalLink className="h-3.5 w-3.5" /></a> : <div className="font-medium">{line.title}</div>}
                    {line.variationSelections.length ? <div className="mt-1 font-medium text-foreground">{variationText(line)}</div> : null}
                    <div className="mt-1 text-muted-foreground">Item ID: {line.itemId}</div>
                    <div className="mt-1 inline-flex items-center gap-1 text-muted-foreground">
                      Custom label (SKU): <span className="font-semibold text-foreground">{line.sku ?? "N/A"}</span>
                      {line.sku ? <CopyButton value={line.sku} title="Copy SKU" compact /> : null}
                    </div>
                    {line.adRate != null && line.adRate > 0 ? <div className="mt-1 text-emerald-300">Sold via Promoted Listings</div> : null}
                    {tracking?.number ? (
                      <div className="mt-1 text-muted-foreground">
                        Tracking{" "}
                        <a href={trackingUrl(tracking.carrier, tracking.number)} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                          {tracking.number}
                        </a>
                      </div>
                    ) : null}
                  </div>
                  <ItemMetric label="Quantity" value={`${line.quantity}`} hint={`(${line.availableQuantity ?? "?"} available)`} />
                  <ItemMetric label="Item price" value={money(line.unitPriceCents, currency)} />
                  <ItemMetric label="Item total" value={money((line.unitPriceCents ?? 0) * line.quantity, currency)} />
                </div>
              ))}
            </div>
          </section>
        </main>

        <aside className="space-y-5">
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-4 text-xl font-bold">Order</h2>
            <Summary label="Order" value={order.orderId} copyValue={order.orderId} />
            <Summary label="Sales record no." value={order.salesRecordNumber ?? "Unavailable"} />
            <Summary label="Sold" value={dateOnly(order.createdTime)} />
            <Summary label="Buyer paid" value={dateOnly(order.paidTime)} />
            <Summary label="Buyer" value={order.buyerName ?? "Unavailable"} />
            <Summary label="Username" value={order.buyerUsername ?? "Unavailable"} />
            <button onClick={() => setMessageOpen(true)} className="mt-4 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-full border border-primary/50 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10">
              <MessageSquare className="h-4 w-4" /> Message buyer
            </button>
          </section>

          {order.cases.hasCases ? (
            <section className="rounded-xl border border-red-500/30 bg-red-500/5 p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-xl font-bold">eBay Cases</h2>
                <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", caseToneClasses(order))}>
                  {order.cases.openCount > 0
                    ? `${order.cases.openCount} Open`
                    : "History"}
                </span>
              </div>
              <div className="space-y-2">
                {order.cases.items.map((item) => {
                  const body = (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-semibold">{item.label}</span>
                        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", item.isOpen ? "bg-red-500/20 text-red-100" : "bg-amber-500/15 text-amber-100")}>
                          {item.statusLabel}
                        </span>
                      </div>
                      <div className="mt-1 font-mono text-xs">#{item.externalId}</div>
                      {item.reason ? <div className="mt-1 text-xs text-muted-foreground">{item.reason}</div> : null}
                      <div className="mt-1 text-xs text-muted-foreground">
                        Opened {dateOnly(item.openedAt)}
                        {item.closedAt ? ` | Closed ${dateOnly(item.closedAt)}` : null}
                      </div>
                    </>
                  );
                  return item.manageUrl ? (
                    <a
                      key={item.id}
                      href={item.manageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block cursor-pointer rounded-lg border border-red-500/25 bg-red-500/10 p-3 hover:bg-red-500/15"
                      title={`Open ${item.label} on eBay`}
                    >
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                        <div className="min-w-0 flex-1">{body}</div>
                        <ExternalLink className="h-4 w-4 shrink-0 text-red-200" />
                      </div>
                    </a>
                  ) : (
                    <div key={item.id} className="rounded-lg border border-red-500/25 bg-red-500/10 p-3">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                        <div className="min-w-0 flex-1">{body}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-4 text-xl font-bold">Feedback</h2>
            <div className={cn("rounded-lg border px-3 py-2 text-sm", feedbackToneClasses(order))}>
              <div className="font-semibold capitalize">{feedbackSummaryText(order)}</div>
              {feedbackDetailText(order) ? <div className="mt-1 text-xs opacity-85">{feedbackDetailText(order)}</div> : null}
              {order.feedback.items[0]?.isAutomated && order.feedback.leaveBy ? (
                <div className="mt-1 text-xs opacity-85">
                  Buyer can leave feedback until {dateOnly(order.feedback.leaveBy)}
                </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-4 text-xl font-bold">Payment</h2>
            <div className="mb-4 flex gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              The buyer has paid for this order. Finance values are pulled from eBay when available.
            </div>
            <div className="mb-4 flex items-start justify-between gap-4 text-sm">
              <span className="text-muted-foreground">Funds status</span>
              <span className="text-right">
                <span className="font-medium text-foreground">{fundsStatusLabel(order.finance.fundsStatus)}</span>
                {order.finance.fundsStatusDetail ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">{order.finance.fundsStatusDetail}</span>
                ) : null}
              </span>
            </div>
            <div className="rounded-lg bg-muted/35 p-4">
              <h3 className="mb-3 font-semibold">What your buyer paid</h3>
              <Summary label="Subtotal" value={money(order.subtotalCents, currency)} soft />
              <Summary label="Shipping" value={order.shippingCents ? money(order.shippingCents, currency) : "$0.00"} soft />
              {order.taxCents != null && order.taxCents > 0 ? <Summary label="Sales tax" value={money(order.taxCents, currency)} soft /> : null}
              <Summary label="Order total" value={money(buyerPaidTotal, currency)} strong soft />
            </div>
            <div className="mt-4 rounded-lg bg-muted/35 p-4">
              <h3 className="mb-3 font-semibold">What you earned</h3>
              <Summary label="Order total" value={money(buyerPaidTotal, currency)} soft />
              {order.taxCents != null && order.taxCents > 0 ? (
                <>
                  <div className="mt-3 text-sm font-semibold">eBay collected from buyer</div>
                  <Summary label="Sales tax" value={feeMoney(order.taxCents, currency)} soft />
                </>
              ) : null}
              <div className="mt-3 text-sm font-semibold">Selling costs</div>
              <Summary label="Transaction fees" value={order.finance.transactionFeesCents != null ? feeMoney(order.finance.transactionFeesCents, currency) : "Unavailable"} soft />
              <Summary label="Ad Fee General" value={order.finance.adFeeCents != null ? feeMoney(order.finance.adFeeCents, currency) : "Unavailable"} soft />
              <Summary label="Shipping label" value={order.finance.shippingLabelCents != null ? feeMoney(order.finance.shippingLabelCents, currency) : "Unavailable"} soft />
              <Summary label="Other fees" value={order.finance.otherFeesCents != null ? feeMoney(order.finance.otherFeesCents, currency) : "Unavailable"} soft />
              <Summary label="Order earnings" value={order.finance.orderEarningsCents != null ? money(order.finance.orderEarningsCents, currency) : "Unavailable"} strong soft />
            </div>
          </section>

          {user?.role === "ADMIN" ? (
            <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
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
      {trackingOpen ? (
        <AddTrackingModal
          order={order}
          onClose={() => setTrackingOpen(false)}
          onUpdated={() => {
            setTrackingOpen(false);
            setReloadNonce((value) => value + 1);
          }}
        />
      ) : null}
      {confirmAction ? (
        <OrderConfirmationModal
          order={order}
          action={confirmAction}
          onClose={() => setConfirmAction(null)}
          onUpdated={() => {
            setConfirmAction(null);
            setReloadNonce((value) => value + 1);
          }}
        />
      ) : null}
    </div>
  );
}

function TimelineDot({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <div className="relative z-10 text-center">
      <div className={cn("mx-auto h-7 w-7 rounded-full border-2", active ? "border-primary bg-primary" : "border-muted-foreground bg-card")} />
      <div className="mt-3 font-semibold">{label}</div>
      <div className="text-sm text-muted-foreground">{value}</div>
    </div>
  );
}

function ItemMetric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="text-sm">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-semibold">{value}</div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function Summary({ label, value, strong, copyValue, soft }: { label: string; value: string; strong?: boolean; copyValue?: string; soft?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-3 border-b py-2 text-sm last:border-b-0", soft ? "border-border/70" : "border-border")}>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("inline-flex min-w-0 items-center gap-1 text-right", strong ? "font-bold text-foreground" : "font-medium text-foreground")}>
        {value}
        {copyValue ? <CopyButton value={copyValue} title={`Copy ${label}`} compact /> : null}
      </span>
    </div>
  );
}

function StoreBadge({ store }: { store: ManageOrder["store"] }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-bold uppercase tracking-wide",
      store === "TPP_EBAY"
        ? "border-blue-500/40 bg-blue-500/10 text-blue-300"
        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    )}>
      <EbayLogoImage compact /> {store === "TPP_EBAY" ? "TPP" : "TT"}
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

type TrackingDraft = {
  carrier: "USPS" | "UPS" | "FedEx";
  trackingNumber: string;
};

function AddTrackingModal({ order, onClose, onUpdated }: { order: ManageOrder; onClose: () => void; onUpdated: () => void }) {
  const [rows, setRows] = useState<TrackingDraft[]>([{ carrier: "USPS", trackingNumber: "" }]);
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
      body: JSON.stringify({ orderId: order.orderId, store: order.store, actionType: "add_tracking" }),
      signal: controller.signal,
    })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Could not prepare tracking confirmation");
        setToken(json.data.humanActionToken);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Could not prepare tracking confirmation");
      })
      .finally(() => setPreparing(false));
    return () => controller.abort();
  }, [order.orderId, order.store]);

  function updateRow(index: number, patch: Partial<TrackingDraft>) {
    setRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((current) => [...current, { carrier: "USPS", trackingNumber: "" }]);
  }

  function removeRow(index: number) {
    setRows((current) => current.filter((_, rowIndex) => rowIndex !== index));
  }

  async function send() {
    if (!token) return;
    const trackingNumbers = rows
      .map((row) => ({ carrier: row.carrier, trackingNumber: row.trackingNumber.trim() }))
      .filter((row) => row.trackingNumber.length >= 4);
    if (!trackingNumbers.length) {
      setError("Enter at least one tracking number.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/manage-orders/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: order.orderId,
          store: order.store,
          actionType: "add_tracking",
          humanActionToken: token,
          trackingNumbers,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Tracking update failed");
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tracking update failed");
    } finally {
      setSending(false);
    }
  }

  const canSubmit = rows.some((row) => row.trackingNumber.trim().length >= 4);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Add tracking</h2>
            <p className="text-sm text-muted-foreground">{order.orderId}</p>
          </div>
          <button onClick={onClose} className="cursor-pointer rounded p-1 hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>
        <div className="mb-3 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Adding tracking is a live eBay order action and requires final confirmation.
        </div>
        <div className="space-y-3">
          {rows.map((row, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[130px_1fr_36px]">
              <select value={row.carrier} onChange={(event) => updateRow(index, { carrier: event.target.value as TrackingDraft["carrier"] })} className={cn(SELECT_CLASS, "h-10 px-3 text-sm")}>
                <option value="USPS">USPS</option>
                <option value="UPS">UPS</option>
                <option value="FedEx">FedEx</option>
              </select>
              <input value={row.trackingNumber} onChange={(event) => updateRow(index, { trackingNumber: event.target.value })} className="h-10 rounded-md border border-input bg-background px-3 text-sm" placeholder="Tracking number" />
              <button type="button" onClick={() => removeRow(index)} disabled={rows.length === 1} title="Remove tracking row" className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        <button type="button" onClick={addRow} className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-md border border-primary/45 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10">
          <Plus className="h-4 w-4" /> Add another tracking
        </button>
        {error ? <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="cursor-pointer rounded-md border border-border px-4 py-2 text-sm hover:bg-accent">Cancel</button>
          <button onClick={() => void send()} disabled={preparing || sending || !token || !canSubmit} className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">
            {preparing || sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />}
            Final Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

function Warning({ text }: { text: string }) {
  return (
    <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      {text}
    </div>
  );
}

function OrderConfirmationModal({
  order,
  action,
  onClose,
  onUpdated,
}: {
  order: ManageOrder;
  action: Extract<ManageOrderActionType, "mark_shipped" | "cancel_order">;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendAutoResponder, setSendAutoResponder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setPreparing(true);
    setToken(null);
    setError(null);
    fetch("/api/manage-orders/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: order.orderId, store: order.store, actionType: action }),
      signal: controller.signal,
    })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Could not prepare confirmation");
        setToken(json.data.humanActionToken);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Could not prepare confirmation");
      })
      .finally(() => setPreparing(false));
    return () => controller.abort();
  }, [action, order.orderId, order.store]);

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
          actionType: action,
          humanActionToken: token,
          sendAutoResponder: action === "mark_shipped" ? sendAutoResponder : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Action failed");
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setSending(false);
    }
  }

  const title = action === "mark_shipped" ? "Mark As Shipped" : "Cancel Order";
  const warning =
    action === "mark_shipped"
      ? "This will mark the live eBay order as shipped without adding tracking. This may affect seller metrics and buyer visibility. Continue?"
      : "This will attempt to cancel the live eBay order after final confirmation. Cancellation is currently blocked unless live eBay order actions are enabled and implemented.";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="text-sm text-muted-foreground">{order.store === "TPP_EBAY" ? "TPP eBay" : "TT eBay"} | {order.orderId}</p>
          </div>
          <button onClick={onClose} className="cursor-pointer rounded p-1 hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>
        <Warning text={warning} />
        {action === "mark_shipped" ? (
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sendAutoResponder} onChange={(event) => setSendAutoResponder(event.target.checked)} />
            Send shipped auto-message if enabled
          </label>
        ) : null}
        {error ? <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="cursor-pointer rounded-md border border-border px-4 py-2 text-sm hover:bg-accent">Cancel</button>
          <button onClick={() => void send()} disabled={preparing || sending || !token} className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">
            {preparing || sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
            Final Confirm
          </button>
        </div>
      </div>
    </div>
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
          <button onClick={onClose} className="cursor-pointer rounded p-1 hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>
        <div className="mb-3 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Sending buyer messages remains guarded by Help Desk safety and requires final confirmation.
        </div>
        <textarea value={body} onChange={(event) => setBody(event.target.value)} className="min-h-40 w-full rounded-md border border-input bg-background p-3 text-sm" placeholder="Type the buyer message..." />
        {error ? <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="cursor-pointer rounded-md border border-border px-4 py-2 text-sm hover:bg-accent">Cancel</button>
          <button onClick={() => void send()} disabled={preparing || sending || !token || !body.trim()} className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">
            {preparing || sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
            Final Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
