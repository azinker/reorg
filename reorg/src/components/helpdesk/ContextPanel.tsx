"use client";

/**
 * Right-rail Context Panel for the Help Desk.
 *
 * eDesk parity grammar — this is the source of truth for layout decisions:
 *
 *   ┌──────────────────────────────────┐
 *   │ [Details]  [Notes · 0]          │   tabs (no separate "Order info" tab)
 *   ├──────────────────────────────────┤
 *   │ ┌──────────────────────────────┐ │   Customer card
 *   │ │ FullName 🗐                  │ │
 *   │ │ ebHandle  copy               │ │
 *   │ │ Phone:  +1 …                 │ │
 *   │ │ ──────────────────────────── │ │
 *   │ │ Channel:  TPP_EBAY           │ │
 *   │ │ Total Order: $25.90 (1 ord)  │ │
 *   │ │ Customer Since: Apr 5, 2026  │ │
 *   │ └──────────────────────────────┘ │
 *   │                                  │
 *   │ ORDER INFO          ▼  (collapsable)
 *   │ Order No.  19-…-09100 (5149769) MFN  ↗
 *   │ ──────────────────────────────── │
 *   │ Ordered: Apr 5  │ Shipped: Apr 5
 *   │ ──────────────────────────────── │
 *   │ Tracking No.  USPS 940190…       │
 *   │ ──────────────────────────────── │
 *   │ Estimated Delivery   STANDARD    │
 *   │ Sun, 12 Apr – Tue, 14 Apr        │
 *   │ ──────────────────────────────── │
 *   │ Delivery Address  …              │
 *   │ ──────────────────────────────── │
 *   │ PRODUCTS                         │
 *   │  [thumb] title                Qty $25.90
 *   │          SKU AB86_100LED_UV       │
 *   │ ──────────────────────────────── │
 *   │ Total                  $25.90    │
 *   └──────────────────────────────────┘
 *
 * Why one tab instead of two:
 *   - eDesk presents the customer + order on the same scroll surface, so the
 *     agent never has to flip tabs to see who they're talking to vs what
 *     they bought. We mirror that.
 *
 * Dividers everywhere:
 *   - Each row in Order Info is separated by a hairline. This matches the
 *     screenshot the user provided and makes scanning much easier than the
 *     previous space-only stack.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  MapPin,
  Package,
  Phone,
  ShoppingBag,
  StickyNote,
  Truck,
  User as UserIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { HelpdeskTicketDetail } from "@/hooks/use-helpdesk";
import { Avatar, AvatarStack } from "@/components/ui/avatar";

interface ContextPanelProps {
  ticket: HelpdeskTicketDetail | null;
  /**
   * Container width override. Defaults to the classic 320px column used in the
   * split layout. Pass `"flex-1 min-w-0"` (or similar) when rendering inside a
   * resizable split where the parent already controls width.
   */
  widthClassName?: string;
  /** When true, hides the divider on the left side (used in modal/split). */
  flush?: boolean;
}

interface RelatedTicket {
  id: string;
  subject: string | null;
  status: string;
  ebayOrderNumber: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  ebayItemTitle: string | null;
}

interface RelatedResponse {
  data: RelatedTicket[];
  total: number;
  orderCount: number;
  /**
   * ISO timestamp of the buyer's earliest ticket on file. We use this as a
   * proxy for "Customer Since" — the date of their first interaction with us.
   * eDesk uses first-purchase date; we don't have order history yet so the
   * first ticket is the closest signal we can serve quickly.
   */
  earliestTicketAt?: string | null;
}

interface OrderContextLineItem {
  itemId: string;
  title: string;
  sku: string | null;
  quantity: number;
  unitPriceCents: number | null;
  pictureUrl: string | null;
}
interface OrderContextAddress {
  name: string | null;
  street1: string | null;
  street2: string | null;
  cityName: string | null;
  stateOrProvince: string | null;
  postalCode: string | null;
  countryName: string | null;
  phone: string | null;
}
interface OrderContext {
  orderId: string;
  salesRecordNumber: string | null;
  buyerUserId: string;
  buyerName: string;
  buyerEmail: string | null;
  orderStatus: string | null;
  createdTime: string | null;
  paidTime: string | null;
  shippedTime: string | null;
  estimatedDeliveryMin: string | null;
  estimatedDeliveryMax: string | null;
  actualDeliveryTime: string | null;
  shippingService: string | null;
  trackingNumber: string | null;
  trackingCarrier: string | null;
  totalCents: number | null;
  currency: string | null;
  shippingAddress: OrderContextAddress | null;
  lineItems: OrderContextLineItem[];
}
interface OrderContextResponse {
  data: OrderContext | null;
  cached?: boolean;
  reason?: string;
}

export function ContextPanel({
  ticket,
  widthClassName,
  flush = false,
}: ContextPanelProps) {
  const containerWidth = widthClassName ?? "w-80 shrink-0";
  const dividerCls = flush ? "" : "border-l border-hairline";

  if (!ticket) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-card px-4 text-center text-xs text-muted-foreground",
          containerWidth,
          dividerCls,
        )}
      >
        Select a ticket to see context.
      </div>
    );
  }

  return (
    <ContextPanelInner
      ticket={ticket}
      containerWidth={containerWidth}
      dividerCls={dividerCls}
    />
  );
}

/**
 * Tabs are now {Details, Notes}. eDesk does not have a separate "Order Info"
 * tab — order info lives directly under the customer card on the Details tab,
 * which is what we mirror here. Notes still get their own tab so the agent
 * can find / focus internal context without the order section pushing it off
 * screen.
 */
type ContextTab = "details" | "notes";

interface InnerProps {
  ticket: HelpdeskTicketDetail;
  containerWidth: string;
  dividerCls: string;
}

function ContextPanelInner({ ticket, containerWidth, dividerCls }: InnerProps) {
  const [tab, setTab] = useState<ContextTab>("details");
  const noteCount = ticket.notes.length;

  // We always land on Details when a new ticket is opened. The Notes tab has
  // its own "no notes" empty state, so there's no value in auto-jumping to it
  // even when the ticket has notes — agents work with details first, notes second.
  useEffect(() => {
    setTab("details");
  }, [ticket.id]);

  // Order context + related tickets both live at the panel level so that:
  //   • CustomerCard can read buyer phone off the order shipping address.
  //   • CustomerCard and RelatedSection share the SAME related-tickets response
  //     instead of firing two requests against the same endpoint with
  //     different `limit` values (the previous code did exactly that).
  const order = useOrderContext(ticket);
  const related = useRelatedTickets(ticket);

  return (
    <div className={cn("flex flex-col bg-card", containerWidth, dividerCls)}>
      <div
        role="tablist"
        aria-label="Ticket context tabs"
        className="flex items-stretch border-b border-hairline bg-card text-[11px]"
      >
        <ContextTabButton
          active={tab === "details"}
          onClick={() => setTab("details")}
          label="Details"
        />
        <ContextTabButton
          active={tab === "notes"}
          onClick={() => setTab("notes")}
          label={`Notes${noteCount > 0 ? ` · ${noteCount}` : ""}`}
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === "details" && (
          <>
            <CustomerCard ticket={ticket} order={order.data} related={related.summary} />
            {ticket.kind === "POST_SALES" || !!ticket.ebayOrderNumber ? (
              <OrderInfoSection ticket={ticket} order={order} />
            ) : null}
            <RelatedSection ticket={ticket} related={related} />
          </>
        )}
        {tab === "notes" && <NotesTab ticket={ticket} />}
      </div>
    </div>
  );
}

interface ContextTabButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
}
function ContextTabButton({ active, onClick, label }: ContextTabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex-1 border-b-2 px-3 py-2 font-medium transition-colors cursor-pointer",
        active
          ? "border-brand text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/**
 * Notes tab body. Replaces the old NotesSection — when there are zero notes
 * we now render a friendly empty state instead of hiding the section, so
 * agents know the tab exists and how to use it.
 */
function NotesTab({ ticket }: { ticket: HelpdeskTicketDetail }) {
  if (ticket.notes.length === 0) {
    return (
      <section className="px-4 py-6 text-center">
        <StickyNote className="mx-auto h-6 w-6 text-muted-foreground/40" />
        <p className="mt-2 text-xs text-muted-foreground">
          No internal notes yet.
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          Switch the composer to "Note" to leave a private message visible
          only to your team.
        </p>
      </section>
    );
  }
  return (
    <section className="px-4 py-4">
      <div className="space-y-2">
        {ticket.notes.map((n) => (
          <div
            key={n.id}
            className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2"
          >
            <p className="mb-1 text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-300">
              {n.author.name ?? n.author.email}
            </p>
            <p className="whitespace-pre-wrap text-xs text-foreground">
              {n.bodyText}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Order context hook (shared between CustomerCard and OrderInfoSection) ──

interface UseOrderContextResult {
  data: OrderContext | null;
  loading: boolean;
  error: string | null;
}

/**
 * Module-level cache for the auxiliary context-panel fetches. Keyed by ticket
 * id so re-opening a ticket renders the panel instantly with whatever we last
 * saw — the useEffect still fires a silent refresh in the background. This
 * matches the "render cached, refresh after" pattern used by `inbox-cache`
 * for tickets/counts/sync-status.
 */
const orderContextCache = new Map<string, OrderContext | null>();
const relatedCache = new Map<string, RelatedResponse>();

/**
 * Fetches the live eBay order context once per ticket and exposes it to
 * children of ContextPanel. Lives at the panel level so the CustomerCard and
 * OrderInfoSection share the same network request — we used to fire two.
 */
function useOrderContext(ticket: HelpdeskTicketDetail): UseOrderContextResult {
  // Hydrate synchronously from cache so re-opens paint with the previous
  // order context instantly.
  const initial = orderContextCache.has(ticket.id) ? orderContextCache.get(ticket.id) ?? null : null;
  const [data, setData] = useState<OrderContext | null>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticket.ebayOrderNumber) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const cached = orderContextCache.has(ticket.id)
      ? orderContextCache.get(ticket.id) ?? null
      : null;
    if (cached) setData(cached);
    // Always refresh, but don't show the spinner if we already have something
    // on screen — feels "snappy" rather than "loading".
    if (!cached) setLoading(true);
    setError(null);
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/helpdesk/tickets/${ticket.id}/order-context`,
          { cache: "no-store", signal: ac.signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as OrderContextResponse;
        if (ac.signal.aborted) return;
        setData(j.data);
        orderContextCache.set(ticket.id, j.data);
        if (!j.data && j.reason) setError(j.reason);
      } catch (err) {
        if (ac.signal.aborted) return;
        // Fetch was aborted by navigation — treat as benign.
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      ac.abort();
    };
  }, [ticket.id, ticket.ebayOrderNumber]);

  return { data, loading, error };
}

// ── Related-tickets hook (shared between CustomerCard + RelatedSection) ────

interface UseRelatedResult {
  /** Compact summary for the customer card (orderCount + earliestTicketAt). */
  summary: RelatedResponse | null;
  /** Full list (up to 10) for the RelatedSection table. */
  list: RelatedTicket[];
  loading: boolean;
}

/**
 * Single source of truth for the buyer's other tickets. Replaces the two
 * prior `/api/helpdesk/tickets/related` calls (one with `limit=1`, one with
 * `limit=10`) with a single `limit=10` request whose payload powers both
 * the customer-card summary and the RelatedSection list.
 */
function useRelatedTickets(ticket: HelpdeskTicketDetail): UseRelatedResult {
  const cacheKey = `${ticket.id}|${ticket.buyerUserId ?? ""}`;
  const cached = relatedCache.get(cacheKey) ?? null;
  const [summary, setSummary] = useState<RelatedResponse | null>(cached);
  const [list, setList] = useState<RelatedTicket[]>(cached?.data ?? []);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!ticket.buyerUserId) {
      setSummary(null);
      setList([]);
      setLoading(false);
      return;
    }
    const buyer = ticket.buyerUserId;
    const exclude = ticket.id;
    const cached = relatedCache.get(cacheKey);
    if (cached) {
      setSummary(cached);
      setList(cached.data);
    } else {
      setLoading(true);
    }
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/helpdesk/tickets/related?buyer=${encodeURIComponent(buyer)}&exclude=${encodeURIComponent(exclude)}&limit=10`,
          { cache: "no-store", signal: ac.signal },
        );
        if (!res.ok) return;
        const j = (await res.json()) as RelatedResponse;
        if (ac.signal.aborted) return;
        setSummary(j);
        setList(j.data ?? []);
        relatedCache.set(cacheKey, j);
      } catch {
        // best-effort
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      ac.abort();
    };
  }, [ticket.id, ticket.buyerUserId, cacheKey]);

  return { summary, list, loading };
}

// ── Customer card ──────────────────────────────────────────────────────────

function CustomerCard({
  ticket,
  order,
  related,
}: {
  ticket: HelpdeskTicketDetail;
  order: OrderContext | null;
  /**
   * Summary of the buyer's other tickets, computed once at the panel level
   * and shared with `RelatedSection`. Powers two derived UI bits here:
   *   1. orderCount → "Total Order: $X (N orders)" hint
   *   2. earliestTicketAt → "Customer Since: <date>" date.
   */
  related: RelatedResponse | null;
}) {

  // Customer-since: prefer the earliest ticket we have on file (true first
  // contact). Fall back to this ticket's createdAt when the related summary
  // hasn't returned yet.
  const customerSince = related?.earliestTicketAt ?? ticket.createdAt;
  const orderCount = related?.orderCount ?? (ticket.ebayOrderNumber ? 1 : 0);
  const isNewCustomer = orderCount <= 1;

  // Prefer the eBay-side full name from the order (which is "FirstName LastName")
  // over the ticket's stored buyerName, which can sometimes be just the eBay
  // handle. Falling back through the chain keeps unknown buyers readable.
  const fullName =
    (order?.buyerName && order.buyerName.trim()) ||
    ticket.buyerName ||
    ticket.buyerUserId ||
    "Unknown buyer";
  const phone = order?.shippingAddress?.phone ?? null;

  // Total Order value renders eDesk-style: "$25.90 (1 order)". When we don't
  // have a total yet (pre-order tickets or while loading), fall back to just
  // the order count so the row is still useful.
  const totalLabel = (() => {
    if (order?.totalCents != null) {
      const money = formatMoney(order.totalCents, order.currency);
      const orders = orderCount > 0 ? orderCount : 1;
      return `${money} (${orders} order${orders === 1 ? "" : "s"})`;
    }
    if (orderCount > 0) {
      return `${orderCount} order${orderCount === 1 ? "" : "s"}`;
    }
    return "—";
  })();

  return (
    <section className="border-b border-hairline px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <UserIcon className="h-3.5 w-3.5 text-brand" />
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Customer
        </h3>
      </div>
      <div className="flex items-start gap-3">
        <Avatar
          user={{
            id: ticket.buyerUserId ?? "buyer",
            name: fullName,
            email: ticket.buyerEmail,
            avatarUrl: null,
            handle: ticket.buyerUserId,
          }}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-semibold text-foreground">
              {fullName}
            </p>
            <CopyButton value={fullName} title="Copy buyer name" />
          </div>
          {ticket.buyerUserId ? (
            <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 rounded bg-surface-2 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                eb
              </span>
              <a
                href={`https://www.ebay.com/usr/${ticket.buyerUserId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand hover:underline"
              >
                {ticket.buyerUserId}
              </a>
            </p>
          ) : null}
          {phone ? (
            <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-foreground">
              <Phone className="h-3 w-3 text-muted-foreground" />
              <a
                href={`tel:${phone.replace(/\s+/g, "")}`}
                className="text-foreground hover:underline"
              >
                {phone}
              </a>
              <CopyButton value={phone} title="Copy phone number" />
            </p>
          ) : null}
        </div>
      </div>

      {/* Divider before key/value rows — eDesk renders this as a hairline
       * between the buyer identity block and the channel/total block. */}
      <div className="my-3 border-t border-hairline" />

      <dl className="space-y-2.5 text-xs">
        <Row label="Channel">
          <div className="flex items-center justify-end gap-1.5">
            <span className="inline-flex items-center gap-1 rounded bg-surface-2 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              eb
            </span>
            <span className="text-foreground">{ticket.integrationLabel}</span>
            {ticket.buyerUserId ? (
              <CopyButton
                value={ticket.buyerUserId}
                title="Copy buyer userId"
              />
            ) : null}
          </div>
        </Row>
        <Row label="Total Order value">
          <span className="text-foreground">
            {order?.totalCents != null ? (
              <>
                <span className="font-semibold">
                  {formatMoney(order.totalCents, order.currency)}
                </span>
                <span className="ml-1 text-muted-foreground">
                  ({orderCount > 0 ? orderCount : 1} order
                  {orderCount === 1 || orderCount === 0 ? "" : "s"})
                </span>
              </>
            ) : (
              totalLabel
            )}
          </span>
        </Row>
        <Row label="Segments">
          <div className="flex flex-wrap justify-end gap-1">
            {isNewCustomer ? (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                New Customer
              </span>
            ) : (
              <span className="rounded-full bg-brand-muted px-2 py-0.5 text-[10px] font-semibold text-brand">
                Returning
              </span>
            )}
            {/* "VIP" is reserved for repeat buyers (3+ orders). This mirrors
             * eDesk's segmentation chips and gives the agent a quick visual
             * cue for who is a high-value customer. */}
            {orderCount >= 3 ? (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                VIP
              </span>
            ) : null}
            {ticket.tags.length > 0
              ? ticket.tags.map((t) => (
                  <span
                    key={t.id}
                    className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-foreground"
                    style={t.color ? { color: t.color } : undefined}
                  >
                    {t.name}
                  </span>
                ))
              : null}
          </div>
        </Row>
        <Row label="Customer Since">
          <span className="text-foreground">
            {new Date(customerSince).toLocaleDateString(undefined, {
              weekday: "short",
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </span>
        </Row>
        <Row label="Assignee">
          <div className="flex items-center justify-end gap-2">
            <Avatar
              user={ticket.primaryAssignee}
              size="sm"
              unassigned={!ticket.primaryAssignee}
            />
            <span className="text-foreground">
              {ticket.primaryAssignee
                ? ticket.primaryAssignee.name ?? ticket.primaryAssignee.email
                : "Unassigned"}
            </span>
          </div>
        </Row>
        {ticket.additionalAssignees && ticket.additionalAssignees.length > 0 ? (
          <Row label="Watchers">
            <AvatarStack
              size="sm"
              users={ticket.additionalAssignees.map((a) => a.user)}
            />
          </Row>
        ) : null}
      </dl>
    </section>
  );
}

// ── Order info ─────────────────────────────────────────────────────────────

function OrderInfoSection({
  ticket,
  order,
}: {
  ticket: HelpdeskTicketDetail;
  order: UseOrderContextResult;
}) {
  /**
   * Order Info card — fully eDesk-aligned now:
   *   - Order No. is a clickable link to eBay (no 3-dot menu).
   *   - Sales Record Number rendered inline in parentheses when available.
   *   - Every field gets its own row separated by a hairline so the agent
   *     can scan visually instead of parsing whitespace.
   *   - Tracking number renders "USPS 9401…" as one inline link to the
   *     carrier's tracking page; carriers other than USPS/UPS/FedEx fall
   *     back to a Google search.
   *   - Delivery address is a clickable Google Maps link (multi-line so the
   *     full address is visible without truncation).
   *   - Products list mirrors eDesk's compact stack: thumbnail + title + SKU
   *     on the left, qty × unit price on the right.
   */
  const [open, setOpen] = useState(true);
  const { data: ctx, loading, error } = order;

  if (!ticket.ebayOrderNumber && ticket.kind !== "POST_SALES") {
    // Pre-sales inquiry with no order — hide the section entirely.
    return null;
  }

  // MFN/FBA badge: eBay sellers use MFN for "Merchant Fulfilled". We default
  // to MFN; the SDK doesn't expose Amazon-style FBA so this is informational.
  const fulfillmentBadge = "MFN";
  const trackingCarrier = ctx?.trackingCarrier ?? "USPS";

  return (
    <section className="border-b border-hairline">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-surface-2/40 cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <ShoppingBag className="h-3.5 w-3.5 text-brand" />
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Order Info
          </h3>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
        />
      </button>

      {open ? (
        <div className="px-4 pb-4">
          {/* Order No. row — link, sales-record number, MFN badge, copy button.
           * Replaces the old 3-dot menu (it had no actions wired up). */}
          <div className="mb-3">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Order No.
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {ticket.ebayOrderNumber ? (
                <a
                  href={`https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(ticket.ebayOrderNumber)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 break-all font-mono text-xs text-brand hover:underline"
                  title="Open this order on eBay (new tab)"
                >
                  {ticket.ebayOrderNumber}
                  <ExternalLink className="h-3 w-3 shrink-0 opacity-70" />
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
              {ctx?.salesRecordNumber ? (
                <span
                  className="font-mono text-[11px] text-muted-foreground"
                  title="eBay Selling Manager Sales Record Number"
                >
                  ({ctx.salesRecordNumber})
                </span>
              ) : null}
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
                {fulfillmentBadge}
              </span>
              {ticket.ebayOrderNumber ? (
                <CopyButton
                  value={ticket.ebayOrderNumber}
                  title="Copy order number"
                />
              ) : null}
            </div>
          </div>

          {/* Status messages while we load */}
          {loading ? (
            <p className="mb-3 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading live order
              details from eBay…
            </p>
          ) : null}
          {error && !ctx ? (
            <p className="mb-3 text-[11px] text-amber-700 dark:text-amber-300">
              {error}
            </p>
          ) : null}

          {/* Body rows — every field gets its own block separated by a hairline
           * divider, so the eye doesn't have to count whitespace to find the
           * next field. This is the layout from the user's screenshot. */}
          <div className="divide-y divide-hairline rounded-md border border-hairline">
            {/* Ordered + Shipped on a single row, side-by-side, mirrors eDesk. */}
            <div className="grid grid-cols-2 gap-2 px-3 py-2 text-xs">
              <div>
                <p className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Ordered
                </p>
                <p className="text-foreground">
                  {formatShortDate(
                    ctx?.createdTime ?? ctx?.paidTime ?? ticket.createdAt,
                  )}
                </p>
              </div>
              <div>
                <p className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Shipped
                </p>
                <p className="text-foreground">
                  {ctx?.shippedTime ? formatShortDate(ctx.shippedTime) : "—"}
                </p>
              </div>
            </div>

            <div className="px-3 py-2 text-xs">
              <p className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Tracking No.
              </p>
              {ctx?.trackingNumber ? (
                <a
                  href={trackingUrl(trackingCarrier, ctx.trackingNumber)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 break-all text-brand hover:underline"
                  title={`Track ${ctx.trackingNumber} on ${trackingCarrier}`}
                >
                  <Truck className="h-3 w-3 shrink-0" />
                  <span className="font-medium">{trackingCarrier}</span>
                  <span className="font-mono text-foreground">
                    {ctx.trackingNumber}
                  </span>
                  <ExternalLink className="h-3 w-3 shrink-0 opacity-70" />
                </a>
              ) : (
                <span className="text-muted-foreground">
                  {ctx?.shippedTime
                    ? "Awaiting tracking upload"
                    : "Not yet shipped"}
                </span>
              )}
            </div>

            <div className="px-3 py-2 text-xs">
              <div className="mb-0.5 flex items-center justify-between gap-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {ctx?.actualDeliveryTime ? "Delivered" : "Estimated Delivery"}
                </p>
                {ctx?.shippingService ? (
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-foreground">
                    {shortService(ctx.shippingService)}
                  </span>
                ) : null}
              </div>
              {ctx?.actualDeliveryTime ? (
                // eBay confirmed delivery — show that prominently with a green
                // dot and the actual delivery date. The estimated window
                // becomes irrelevant once the carrier has scanned "delivered".
                <p className="flex items-center gap-1.5 text-foreground">
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500"
                    aria-hidden
                  />
                  <span className="font-medium text-emerald-700 dark:text-emerald-300">
                    {formatLongDate(ctx.actualDeliveryTime)}
                  </span>
                </p>
              ) : (
                <p className="text-foreground">
                  {formatEstimatedDelivery(
                    ctx?.estimatedDeliveryMin,
                    ctx?.estimatedDeliveryMax,
                  )}
                </p>
              )}
            </div>

            <div className="px-3 py-2 text-xs">
              <p className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Delivery Address
              </p>
              {ctx?.shippingAddress ? (
                <a
                  href={mapUrl(ctx.shippingAddress)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-start gap-1 text-brand hover:underline"
                  title="Open in Google Maps"
                >
                  <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="whitespace-pre-line text-xs leading-snug text-foreground">
                    {formatAddressMultiline(ctx.shippingAddress)}
                  </span>
                </a>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>
          </div>

          {/* Products — separated with a strong divider so it reads as a
           * distinct section, the way eDesk visually breaks Order Info from
           * the line items. Each row shows thumbnail, title, SKU, qty + price. */}
          <div className="mt-4">
            <p className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              Products
            </p>
            <div className="space-y-2">
              {(ctx?.lineItems && ctx.lineItems.length > 0
                ? ctx.lineItems
                : ticket.ebayItemId
                  ? [
                      {
                        itemId: ticket.ebayItemId,
                        title: ticket.ebayItemTitle ?? ticket.ebayItemId,
                        sku: null,
                        quantity: 1,
                        unitPriceCents: null,
                        pictureUrl: null,
                      } satisfies OrderContextLineItem,
                    ]
                  : []
              ).map((item) => (
                <a
                  key={item.itemId}
                  href={`https://www.ebay.com/itm/${item.itemId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-2 rounded-md border border-hairline bg-surface p-2 transition-colors hover:bg-surface-2"
                >
                  {item.pictureUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={item.pictureUrl}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded border border-hairline object-cover"
                    />
                  ) : (
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-hairline bg-surface-2 text-muted-foreground">
                      <Package className="h-4 w-4" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-xs text-brand">
                      {item.title}
                    </p>
                    {item.sku ? (
                      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                        SKU {item.sku}
                      </p>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right text-[11px]">
                    <p className="font-semibold text-foreground">
                      {item.unitPriceCents != null && item.quantity != null
                        ? formatMoney(
                            item.unitPriceCents * item.quantity,
                            ctx?.currency,
                          )
                        : "—"}
                    </p>
                    <p className="text-muted-foreground">Qty {item.quantity}</p>
                  </div>
                </a>
              ))}
              {(!ctx?.lineItems || ctx.lineItems.length === 0) &&
              !ticket.ebayItemId ? (
                <p className="text-[11px] text-muted-foreground">
                  No products on this ticket.
                </p>
              ) : null}
            </div>

            {ctx?.totalCents != null ? (
              <div className="mt-3 flex items-center justify-between border-t border-hairline pt-2 text-xs">
                <span className="font-semibold text-foreground">Total</span>
                <span className="font-semibold text-foreground">
                  {formatMoney(ctx.totalCents, ctx.currency)}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ── Related tickets ────────────────────────────────────────────────────────

function RelatedSection({
  ticket,
  related: relatedHook,
}: {
  ticket: HelpdeskTicketDetail;
  related: UseRelatedResult;
}) {
  const related = relatedHook.list;
  const loading = relatedHook.loading;

  if (!ticket.buyerUserId) return null;

  return (
    <section className="px-4 py-4">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Other Tickets from this Buyer
      </h3>
      {loading ? (
        <p className="text-[11px] text-muted-foreground">Loading…</p>
      ) : related.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No other tickets on file.
        </p>
      ) : (
        <ul className="space-y-1">
          {related.map((t) => (
            <li key={t.id}>
              <Link
                href={`/help-desk?ticket=${t.id}`}
                className="block rounded-md border border-hairline bg-surface px-2 py-1.5 transition-colors hover:bg-surface-2"
              >
                <p className="line-clamp-1 text-xs text-foreground">
                  {t.subject ?? t.ebayItemTitle ?? "Untitled"}
                </p>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{t.status.replace("_", " ").toLowerCase()}</span>
                  {t.ebayOrderNumber ? (
                    <span className="font-mono">{t.ebayOrderNumber}</span>
                  ) : null}
                  {t.lastMessageAt ? (
                    <span>{relativeTime(t.lastMessageAt)}</span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-[11px] font-medium text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-right text-xs">{children}</dd>
    </div>
  );
}

function CopyButton({ value, title }: { value: string; title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          // clipboard blocked — silent
        }
      }}
      className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
      title={title}
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

/**
 * Compact "Apr 5" date used in the Ordered/Shipped grid. eDesk uses month-day
 * with no year because the agent already has the order open and the year is
 * implicit; this saves a ton of horizontal space in the right rail.
 */
function formatShortDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

/**
 * "Mon, Mar 2" used by the Delivered confirmation row. Slightly longer than
 * `formatShortDate` because it includes the weekday — buyers and agents both
 * think about "did it land before Monday" so the weekday earns its width.
 */
function formatLongDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function formatEstimatedDelivery(min: string | null | undefined, max: string | null | undefined): string {
  // eDesk shows the EDD as a "weekday, day month" range like
  // "Sun, 12 Apr – Tue, 14 Apr", which is much easier to scan than
  // bare dates because customers ask in weekday terms ("did it arrive
  // by Friday?"). We mirror that format.
  const minDate = min ? new Date(min) : null;
  const maxDate = max ? new Date(max) : null;
  const fmt = (d: Date | null) =>
    d
      ? d.toLocaleDateString(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
        })
      : null;
  const a = fmt(minDate);
  const b = fmt(maxDate);
  if (a && b && a !== b) return `${a} – ${b}`;
  return a ?? b ?? "—";
}

function shortService(service: string): string {
  // eBay shipping service codes come in many flavors:
  //   - Carrier-prefixed:  "USPSGround", "USPSPriority", "FedExHomeDelivery"
  //   - Method-prefixed:   "ShippingMethodStandard", "ShippingMethodExpedited"
  //   - Bare descriptor:   "Standard", "Expedited", "Priority"
  //
  // We normalize to one of the three short labels eDesk uses (PRIORITY,
  // EXPRESS, STANDARD) so the chip stays compact next to the date range.
  // Unrecognized inputs fall back to a 12-char uppercase slice — better than
  // dumping a fragment like "SHIPPINGMETH" next to the delivery window.
  const cleaned = service
    .replace(/^USPS|^UPS|^FedEx|^DHL/i, "")
    .replace(/^ShippingMethod/i, "")
    .trim();
  if (!cleaned) return "STANDARD";
  if (/priority/i.test(cleaned)) return "PRIORITY";
  if (/express|expedited|overnight|next.?day/i.test(cleaned)) return "EXPRESS";
  if (/ground|advantage|economy|standard|home.?delivery|first.?class|media/i.test(cleaned))
    return "STANDARD";
  return cleaned.toUpperCase().slice(0, 12);
}

function trackingUrl(carrier: string, trackingNumber: string): string {
  const c = carrier.toUpperCase();
  if (c.includes("USPS")) {
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`;
  }
  if (c.includes("UPS")) {
    return `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}`;
  }
  if (c.includes("FEDEX")) {
    return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`;
  }
  // Fallback: Google search the tracking number with the carrier name.
  return `https://www.google.com/search?q=${encodeURIComponent(`${carrier} ${trackingNumber}`)}`;
}

/**
 * Multi-line address renderer. eDesk shows the address on three lines
 * (name → street → city/state/zip → country) which is way easier to scan
 * than the previous middot-joined single line, especially for international
 * orders with long country names.
 */
function formatAddressMultiline(addr: OrderContextAddress): string {
  const parts: string[] = [];
  if (addr.name) parts.push(addr.name);
  if (addr.street1) parts.push(addr.street1);
  if (addr.street2) parts.push(addr.street2);
  const cityStateZip = [addr.cityName, addr.stateOrProvince]
    .filter(Boolean)
    .join(", ");
  const cszLine = [cityStateZip, addr.postalCode].filter(Boolean).join(" ");
  if (cszLine) parts.push(cszLine);
  if (addr.countryName) parts.push(addr.countryName);
  return parts.join("\n");
}

function mapUrl(addr: OrderContextAddress): string {
  const q = [
    addr.street1,
    addr.street2,
    addr.cityName,
    addr.stateOrProvince,
    addr.postalCode,
    addr.countryName,
  ]
    .filter(Boolean)
    .join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function formatMoney(cents: number, currency: string | null | undefined): string {
  const code = currency ?? "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function relativeTime(value: string): string {
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}
