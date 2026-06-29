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
  AlertTriangle,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  FileWarning,
  FileText,
  Loader2,
  MapPin,
  Package,
  PackageMinus,
  Phone,
  ReceiptText,
  ShieldCheck,
  ShoppingBag,
  Star,
  StickyNote,
  Truck,
  User as UserIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { HelpdeskTicketDetail } from "@/hooks/use-helpdesk";
import { useHelpdeskTimelineEvents } from "@/hooks/use-helpdesk-timeline-events";
import {
  buildCaseStatusSummary,
  formatHelpdeskDate,
  type HelpdeskTimelineEvent,
} from "@/lib/helpdesk/conversation-summary";
import { Avatar, AvatarStack } from "@/components/ui/avatar";
import { fetchOrderContextShared } from "@/components/helpdesk/order-context-client";
import { useCurrentUser } from "@/contexts/current-user-context";
import { canUseHelpdeskOrderActionsPermission } from "@/lib/helpdesk/order-actions-permission";
import {
  labelFormatterActionNoteSuffix,
  resolveLabelFormatterActionNote,
} from "@/lib/helpdesk/label-formatter-action";
import {
  formatOrderLineWeightLbs,
  formatOrderLineWeightOz,
  totalWeightOzFromCatalogLabel,
} from "@/lib/services/calculation";

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
  type: string;
  systemMessageType: string | null;
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
  orderLineItemId: string | null;
  transactionId: string | null;
  title: string;
  sku: string | null;
  currentInventory: number | null;
  /** Catalog MasterRow weight, same formatting as grid. */
  catalogWeight: string | null;
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
interface OrderContextTracking {
  number: string;
  carrier: string | null;
  shippedTime: string | null;
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
  trackingNumbers?: OrderContextTracking[];
  totalCents: number | null;
  /** Shipping fee in cents; null = free shipping or unavailable. */
  shippingCents: number | null;
  refundCents: number | null;
  refundStatus: string | null;
  buyerNetCents: number | null;
  currency: string | null;
  shippingAddress: OrderContextAddress | null;
  lineItems: OrderContextLineItem[];
}
interface OrderContextResponse {
  data: OrderContext | null;
  cached?: boolean;
  reason?: string;
}

type FeedbackSummaryState = "LEFT" | "NOT_LEFT" | "UNKNOWN";

interface FeedbackSummaryItem {
  id: string;
  externalId: string;
  kind: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
  starRating: number | null;
  comment: string | null;
  sellerResponse: string | null;
  ebayOrderNumber: string | null;
  ebayItemId: string | null;
  buyerUserId: string | null;
  leftAt: string;
  source: "mirror" | "live";
  isAutomated: boolean;
  /** Set when this feedback was later removed from eBay. */
  removedAt?: string | null;
}

interface FeedbackSummaryResponse {
  data: {
    state: FeedbackSummaryState;
    items: FeedbackSummaryItem[];
    checkedLive: boolean;
    /** "Feedback Removal Approved" notifications found for this order. */
    removals?: { at: string }[];
    reason?: string;
  };
}

interface LabelFormatterActionResponse {
  data?: {
    orderNumber: string;
    labelFormatter: {
      rowId: string;
      created: boolean;
      previouslyAdded: boolean;
      totalRows: number;
      note: string;
    };
    lineItems: Array<{ sku: string; quantity: number }>;
    skuvault: {
      deducted: Array<{
        sku: string;
        quantityChanged: number;
        quantityOnHand: number;
        warehouse: string;
        location: string;
      }>;
      alreadyDeducted: boolean;
    };
    status: LabelFormatterActionStatus;
  };
  error?: string;
}

interface LabelFormatterActionStatus {
  labelFormatter: {
    added: boolean;
    addedAt: string | null;
    lastDetails: unknown;
    currentWorkingRow: boolean;
    currentWorkingRowId: string | null;
    exported: boolean;
    exportedAt: string | null;
    exportBatchId: string | null;
  };
  skuvault: {
    deducted: boolean;
    deductedAt: string | null;
    skuCount: number;
    rows: Array<{ sku: string; deductedAt: string; details: unknown }>;
  };
}

interface LabelFormatterActionStatusResponse {
  data?: {
    orderNumber: string | null;
    status: LabelFormatterActionStatus;
  };
  error?: string;
}

interface ReturnLabelSummary {
  id: string;
  orderNumber: string;
  trackingNumber: string;
  carrier: string;
  serviceClass: string;
  providerKey: string;
  seriesCode: string;
  weightLbs: number;
  createdAt: string;
  openUrl: string;
  downloadUrl: string;
}

interface ReturnLabelsResponse {
  data?: {
    labels: ReturnLabelSummary[];
  };
  error?: string;
  code?: string;
}

interface GenerateReturnLabelResponse {
  data?: {
    label: ReturnLabelSummary;
    labels: ReturnLabelSummary[];
  };
  error?: string;
  code?: string;
}

interface UseFeedbackSummaryResult {
  data: FeedbackSummaryResponse["data"] | null;
  loading: boolean;
  error: string | null;
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
          "flex flex-col items-center justify-center gap-3 bg-card px-4 text-center text-sm text-muted-foreground",
          containerWidth,
          dividerCls,
        )}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-md border border-hairline bg-surface">
          <UserIcon className="h-5 w-5 opacity-70" />
        </div>
        <div>
          <p className="font-medium text-foreground">No ticket selected</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Buyer, order, and related ticket details will show here.
          </p>
        </div>
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
  const feedback = useFeedbackSummary(ticket);
  const timeline = useHelpdeskTimelineEvents(ticket.id);

  return (
    // h-full + min-h-0 so flex-1 inside us actually scrolls instead of growing
    // past the parent height. Without min-h-0 a child with overflow-y-auto in
    // a column flex layout will overflow the panel and the agent can't reach
    // "Other Tickets from this Buyer" at the bottom (split-mode bug repro).
    <div className={cn("flex h-full min-h-0 flex-col bg-card/95", containerWidth, dividerCls)}>
      <div
        role="tablist"
        aria-label="Ticket context tabs"
        className="flex shrink-0 items-stretch border-b border-hairline bg-card/90 text-xs backdrop-blur-sm"
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "details" && (
          <>
            <CustomerCard ticket={ticket} order={order.data} related={related.summary} />
            <CaseStatusSection
              events={timeline.data}
              loading={timeline.loading}
              error={timeline.error}
              ticket={ticket}
            />
            {ticket.kind === "POST_SALES" || !!ticket.ebayOrderNumber ? (
              <OrderInfoSection
                ticket={ticket}
                order={order}
                events={timeline.data}
              />
            ) : ticket.listingInfo ? (
              // Pre-sales (no order yet) but the buyer is messaging from a
              // specific listing — show a "Product Inquiry" card so the
              // agent immediately knows WHAT the buyer is asking about.
              // No qty / price (there's no order); just title + SKU +
              // thumbnail + a deep link to the eBay listing.
              <ProductInquirySection listing={ticket.listingInfo} />
            ) : null}
            <FeedbackSection
              ticket={ticket}
              order={order.data}
              feedback={feedback}
            />
            <ReturnLabelSection ticket={ticket} />
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
        "flex-1 border-b-2 px-3 py-2.5 font-medium transition-colors cursor-pointer",
        active
          ? "border-brand bg-surface/50 text-foreground"
          : "border-transparent text-muted-foreground hover:bg-surface/40 hover:text-foreground",
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
        <p className="mt-2 text-sm text-muted-foreground">
          No internal notes yet.
        </p>
        <p className="mt-1 text-xs text-muted-foreground/70">
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
            <p className="whitespace-pre-wrap text-sm text-foreground">
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
const feedbackSummaryCache = new Map<string, FeedbackSummaryResponse["data"]>();
const returnLabelCache = new Map<string, ReturnLabelSummary[]>();

function orderContextCacheKey(ticket: HelpdeskTicketDetail): string {
  return `${ticket.id}|${ticket.ebayOrderNumber ?? ""}`;
}

/**
 * Fetches the live eBay order context once per ticket and exposes it to
 * children of ContextPanel. Lives at the panel level so the CustomerCard and
 * OrderInfoSection share the same network request — we used to fire two.
 */
function useOrderContext(ticket: HelpdeskTicketDetail): UseOrderContextResult {
  // Hydrate synchronously from cache so re-opens paint with the previous
  // order context for this exact ticket/order instantly. The key in state
  // prevents a ticket switch from showing the prior ticket's line items while
  // React waits for this effect to run.
  const cacheKey = orderContextCacheKey(ticket);
  const cachedForCurrent = orderContextCache.get(cacheKey) ?? null;
  const [state, setState] = useState<{
    cacheKey: string;
    data: OrderContext | null;
  }>(() => ({ cacheKey, data: cachedForCurrent }));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = state.cacheKey === cacheKey ? state.data : cachedForCurrent;

  useEffect(() => {
    const nextCacheKey = orderContextCacheKey(ticket);
    if (!ticket.ebayOrderNumber) {
      setState({ cacheKey: nextCacheKey, data: null });
      setError(null);
      setLoading(false);
      return;
    }
    const cached = orderContextCache.get(nextCacheKey) ?? null;
    setState({ cacheKey: nextCacheKey, data: cached });
    // Always refresh, but don't show the spinner if we already have something
    // on screen — feels "snappy" rather than "loading". The fetch goes
    // through the shared deduped client so the Composer's parallel request
    // for the same ticket rides this network call instead of duplicating it.
    setLoading(!cached);
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const j = (await fetchOrderContextShared(ticket.id)) as OrderContextResponse;
        if (cancelled) return;
        setState({ cacheKey: nextCacheKey, data: j.data });
        orderContextCache.set(nextCacheKey, j.data);
        if (!j.data && j.reason) setError(j.reason);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ticket.id, ticket.ebayOrderNumber]);

  return { data, loading, error };
}

function useFeedbackSummary(
  ticket: HelpdeskTicketDetail,
): UseFeedbackSummaryResult {
  const isEbay = ticket.channel === "TPP_EBAY" || ticket.channel === "TT_EBAY";
  const shouldFetch = isEbay && Boolean(ticket.ebayOrderNumber);
  const cached = feedbackSummaryCache.get(ticket.id) ?? null;
  const [data, setData] = useState<FeedbackSummaryResponse["data"] | null>(cached);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shouldFetch) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const cachedForTicket = feedbackSummaryCache.get(ticket.id) ?? null;
    setData(cachedForTicket);
    if (cachedForTicket) {
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/helpdesk/tickets/${ticket.id}/feedback`,
          { cache: "no-store", signal: ac.signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as FeedbackSummaryResponse;
        if (ac.signal.aborted) return;
        setData(json.data);
        feedbackSummaryCache.set(ticket.id, json.data);
      } catch (err) {
        if (ac.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [shouldFetch, ticket.id]);

  return { data, loading, error };
}

// ── Related-tickets hook (shared between CustomerCard + RelatedSection) ────

function returnLabelCacheKey(ticket: HelpdeskTicketDetail): string {
  return `${ticket.id}|${ticket.ebayOrderNumber ?? ""}`;
}

function useReturnLabels(ticket: HelpdeskTicketDetail, enabled: boolean) {
  const cacheKey = returnLabelCacheKey(ticket);
  const cached = returnLabelCache.get(cacheKey) ?? [];
  const [labels, setLabels] = useState<ReturnLabelSummary[]>(cached);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !ticket.ebayOrderNumber) {
      setLabels([]);
      setLoading(false);
      setError(null);
      return;
    }
    const nextCacheKey = returnLabelCacheKey(ticket);
    const cachedForTicket = returnLabelCache.get(nextCacheKey) ?? [];
    setLabels(cachedForTicket);
    setLoading(cachedForTicket.length === 0);
    setError(null);
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/api/helpdesk/tickets/${ticket.id}/return-labels`, {
          cache: "no-store",
          signal: ac.signal,
        });
        const json = (await res.json().catch(() => ({}))) as ReturnLabelsResponse;
        if (!res.ok || !json.data) {
          throw new Error(json.error ?? "Could not load return labels.");
        }
        if (ac.signal.aborted) return;
        setLabels(json.data.labels);
        returnLabelCache.set(nextCacheKey, json.data.labels);
      } catch (err) {
        if (ac.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Could not load return labels.");
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [cacheKey, enabled, ticket.ebayOrderNumber, ticket.id]);

  async function generate(force: boolean): Promise<ReturnLabelSummary> {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/helpdesk/tickets/${ticket.id}/return-labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const json = (await res.json().catch(() => ({}))) as GenerateReturnLabelResponse;
      if (!res.ok || !json.data) {
        throw new Error(json.error ?? "Return label generation failed.");
      }
      setLabels(json.data.labels);
      returnLabelCache.set(returnLabelCacheKey(ticket), json.data.labels);
      return json.data.label;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Return label generation failed.";
      setError(message);
      throw new Error(message);
    } finally {
      setGenerating(false);
    }
  }

  return { labels, loading, generating, error, generate };
}

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

  // Customer-since: for post-order tickets, prefer the real order/purchase
  // timestamp from eBay. Do not fall back to the Help Desk ticket's createdAt
  // for order-linked tickets; that makes old orders look like new purchases
  // when eBay context is still loading or unavailable.
  const customerSince =
    order?.createdTime ??
    order?.paidTime ??
    (!ticket.ebayOrderNumber ? related?.earliestTicketAt ?? ticket.createdAt : null);
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

  const openRelatedCount =
    related?.data?.filter(
      (t) => t.status !== "RESOLVED" && t.status !== "ARCHIVED",
    ).length ?? 0;
  const attentionLevel =
    ticket.type === "ITEM_NOT_RECEIVED" ||
    ticket.type === "RETURN_REQUEST" ||
    ticket.type === "NEGATIVE_FEEDBACK" ||
    ticket.type === "CANCELLATION" ||
    ticket.unreadCount > 0
      ? "high"
      : openRelatedCount > 0 || ticket.status === "WAITING"
        ? "medium"
        : "normal";
  const attentionText =
    attentionLevel === "high"
      ? ticket.unreadCount > 0
        ? "Buyer is waiting on a reply"
        : "Escalated issue type"
      : attentionLevel === "medium"
        ? openRelatedCount > 0
          ? `${openRelatedCount} other open ticket${openRelatedCount === 1 ? "" : "s"}`
          : "Waiting on Buyer"
        : "No special risk signals";

  return (
    <section className="border-b border-hairline bg-card/60 px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <UserIcon className="h-3.5 w-3.5 text-brand" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
            <p className="truncate text-base font-semibold text-foreground">
              {fullName}
            </p>
            <CopyButton value={fullName} title="Copy buyer name" />
          </div>
          {ticket.buyerUserId ? (
            <p className="mt-0.5 flex items-center gap-1 truncate text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1 rounded bg-surface-2 px-1 py-px text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
              <CopyButton
                value={ticket.buyerUserId}
                title="Copy eBay username"
              />
            </p>
          ) : null}
          {phone ? (
            <p className="mt-0.5 flex items-center gap-1 truncate text-sm text-foreground">
              <Phone className="h-3.5 w-3.5 text-muted-foreground" />
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

      <dl className="space-y-3 rounded-md border border-hairline bg-surface/35 p-3 text-sm">
        <div
          className={cn(
            "flex items-start gap-2 rounded-md border px-2.5 py-2",
            attentionLevel === "high"
              ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
              : attentionLevel === "medium"
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
          )}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider">
              Work signal
            </p>
            <p className="truncate text-xs text-foreground">{attentionText}</p>
          </div>
        </div>
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
          <div className="flex flex-col items-end gap-1 text-right">
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
            {order?.refundCents != null && order.refundCents > 0 ? (
              <div className="max-w-[240px] space-y-0.5 text-[11px] leading-snug">
                <p>
                  <span className="text-muted-foreground">Refunded </span>
                  <span className="font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                    {formatMoney(order.refundCents, order.currency)}
                  </span>
                  {order.refundStatus ? (
                    <span
                      className="ml-1 text-[10px] font-medium text-muted-foreground"
                      title="eBay refund status"
                    >
                      ({order.refundStatus})
                    </span>
                  ) : null}
                </p>
                {order.buyerNetCents != null ? (
                  <p>
                    <span className="text-muted-foreground">Buyer net </span>
                    <span className="font-semibold tabular-nums text-foreground">
                      {formatMoney(order.buyerNetCents, order.currency)}
                    </span>
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
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
            {customerSince
              ? new Date(customerSince).toLocaleDateString(undefined, {
                  weekday: "short",
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })
              : "—"}
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
          <Row label="Additional assignees">
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

// ── Product inquiry (pre-sales) ────────────────────────────────────────────

/**
 * Pre-sales counterpart to OrderInfoSection. Renders only when the buyer is
 * asking about a specific eBay listing but no order exists yet (typical
 * "Ask seller a question" flow). Mirrors the products card visually so the
 * right rail feels consistent across pre/post-sales — but deliberately omits
 * fields that don't exist before an order:
 *
 *   - No quantity, no price, no shipping, no totals
 *   - No tracking, no delivery date, no address
 *   - No "Order No." link
 *
 * Includes a short "inquiry into the product" caption so a new agent
 * scanning the rail understands at a glance: this isn't a hidden order, the
 * buyer is just asking pre-purchase questions.
 */
function ProductInquirySection({
  listing,
}: {
  listing: NonNullable<HelpdeskTicketDetail["listingInfo"]>;
}) {
  const ebayUrl = `https://www.ebay.com/itm/${listing.itemId}`;
  return (
    <section className="border-b border-hairline px-4 py-4">
      <div className="mb-2 flex items-center gap-2">
        <ShoppingBag className="h-3.5 w-3.5 text-brand" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Product Inquiry
        </h3>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Buyer is asking a pre-purchase question about this listing.
      </p>
      <div className="flex items-start gap-2 rounded-md border border-hairline bg-surface p-2 shadow-sm">
        <a
          href={ebayUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
        >
          {listing.imageUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={listing.imageUrl}
              alt=""
              className="h-12 w-12 rounded border border-hairline object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded border border-hairline bg-surface-2 text-muted-foreground">
              <Package className="h-4 w-4" />
            </div>
          )}
        </a>
        <div className="min-w-0 flex-1">
          <a
            href={ebayUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="line-clamp-3 text-sm text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
          >
            {listing.title ?? listing.itemId}
          </a>
          {listing.sku ? (
            <SkuInventoryLine
              sku={listing.sku}
              currentInventory={listing.currentInventory}
            />
          ) : null}
          {listing.catalogWeight ? (
            <CatalogWeightBlurb weight={listing.catalogWeight} />
          ) : null}
          <a
            href={ebayUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 truncate font-mono text-[11px] text-muted-foreground hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
          >
            Item #{listing.itemId}
            <ExternalLink className="h-3 w-3 shrink-0 opacity-70" />
          </a>
        </div>
      </div>
    </section>
  );
}

// ── Order info ─────────────────────────────────────────────────────────────

function CaseStatusSection({
  ticket,
  events,
  loading,
  error,
}: {
  ticket: HelpdeskTicketDetail;
  events: HelpdeskTimelineEvent[];
  loading: boolean;
  error: string | null;
}) {
  const summary = buildCaseStatusSummary(events, ticket.messages);
  const likelyCaseTicket =
    /RETURN|ITEM_NOT_RECEIVED|REFUND|CANCELLATION|SYSTEM/.test(ticket.type) ||
    /case|claim|return|refund|cancel|item not received|INR/i.test(
      `${ticket.subject ?? ""} ${ticket.latestPreview ?? ""}`,
    );

  if (!summary && !error && (!loading || !likelyCaseTicket)) return null;
  const isReturnCase = summary?.title === "Return Case";
  const statusLabel =
    summary?.status === "Refunded" ? "Closed - Refunded" : summary?.status;
  const isTerminalCase =
    summary?.status === "Refunded" || summary?.status === "Closed";

  return (
    <section className="border-b border-hairline bg-card/40 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileWarning className="h-3.5 w-3.5 text-amber-600 dark:text-amber-300" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Case Status
          </h3>
        </div>
        {loading ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Checking
          </span>
        ) : summary ? (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
              summary.tone === "sky" &&
                "bg-sky-500/15 text-sky-700 dark:text-sky-300",
              summary.tone === "amber" &&
                "bg-amber-500/15 text-amber-700 dark:text-amber-300",
              summary.tone === "emerald" &&
                "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
              summary.tone === "neutral" &&
                "bg-surface-2 text-muted-foreground",
            )}
          >
            {statusLabel}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Case lookup unavailable.
        </p>
      ) : summary ? (
        <div className="space-y-2">
          <div className="rounded-md border border-hairline bg-surface/50 p-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs font-semibold text-foreground">
              <span>{summary.title}</span>
              {summary.caseId ? (
                summary.caseUrl ? (
                  <a
                    href={summary.caseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-w-0 items-center gap-1 rounded border border-amber-500/35 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] text-amber-700 underline-offset-2 transition-colors hover:border-amber-500/60 hover:bg-amber-500/15 hover:text-amber-800 hover:underline dark:text-amber-200 dark:hover:text-amber-100 cursor-pointer"
                    title="Open this eBay case in a new tab"
                  >
                    Case #{summary.caseId}
                    <ExternalLink className="h-3 w-3 shrink-0 opacity-70" />
                  </a>
                ) : (
                  <span className="rounded border border-hairline bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    Case #{summary.caseId}
                  </span>
                )
              ) : null}
              {/* Return cases also have an in-app reorG page — distinct
                  blue button (vs. the amber eBay pill) opens it in a new tab. */}
              {isReturnCase && summary.caseId ? (
                <a
                  href={`/help-desk/returns/${encodeURIComponent(summary.caseId)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-w-0 items-center gap-1 rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-medium text-sky-700 underline-offset-2 transition-colors hover:border-sky-500/60 hover:bg-sky-500/15 hover:text-sky-800 hover:underline dark:text-sky-200 dark:hover:text-sky-100 cursor-pointer"
                  title="Open this return case in the Help Desk Returns area in a new tab"
                >
                  <Package className="h-3 w-3 shrink-0 opacity-80" />
                  Open in Returns Area
                </a>
              ) : null}
            </div>
            {isReturnCase ? (
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                <CaseStatusDatum
                  label="Return Started"
                  value={formatHelpdeskDate(summary.openedAt)}
                />
                <CaseStatusDatum
                  label="Buyer Shipped"
                  value={formatCaseDateOrState(summary.returnShippedAt, "Not shipped")}
                />
                <CaseStatusDatum
                  label="Item Returned"
                  value={formatCaseDateOrState(summary.returnDeliveredAt, "Not returned")}
                />
                <CaseStatusDatum
                  label={summary.status === "Refunded" ? "Refunded" : "Refund Due"}
                  value={formatCaseDateOrState(
                    summary.status === "Refunded" ? summary.closedAt : summary.refundDueAt,
                    summary.status === "Refunded" ? "Refund date unknown" : "Not due yet",
                  )}
                />
                {summary.closedAt && summary.status !== "Refunded" ? (
                  <CaseStatusDatum label="Closed" value={formatHelpdeskDate(summary.closedAt)} />
                ) : null}
              </dl>
            ) : (
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                <CaseStatusDatum label="Opened" value={formatHelpdeskDate(summary.openedAt)} />
                <CaseStatusDatum
                  label="Escalated"
                  value={formatCaseDateOrState(summary.escalatedAt, "Not escalated")}
                />
                <CaseStatusDatum
                  label="Hold Started"
                  value={formatCaseDateOrState(summary.holdAt, "No hold")}
                />
                <CaseStatusDatum
                  label="Hold Expires"
                  value={summary.holdUntil ?? "No hold expiry"}
                />
                {summary.closedAt ? (
                  <CaseStatusDatum label="Closed" value={formatHelpdeskDate(summary.closedAt)} />
                ) : null}
              </dl>
            )}
            {summary.latestEventText ? (
              <CaseStatusLatestLine summary={summary} />
            ) : null}
            <CaseStatusInlineNote summary={summary} />
          </div>
          {!isTerminalCase ? <CaseStatusOuterNote summary={summary} /> : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Checking case timeline...</p>
      )}
    </section>
  );
}

function CaseStatusLatestLine({
  summary,
}: {
  summary: NonNullable<ReturnType<typeof buildCaseStatusSummary>>;
}) {
  if (summary.status === "Refunded") {
    const requestName =
      summary.title === "Item Not Received Case"
        ? "INR request"
        : summary.title.toLowerCase();
    return (
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Latest:{" "}
        <span className="font-semibold text-emerald-700 dark:text-emerald-300">
          Closed - Refunded
        </span>{" "}
        by eBay after the buyer received the refund for this {requestName}.
      </p>
    );
  }

  return (
    <p className="mt-2 line-clamp-2 text-[11px] text-muted-foreground">
      Latest: {summary.latestEventText}
    </p>
  );
}

function CaseStatusInlineNote({
  summary,
}: {
  summary: NonNullable<ReturnType<typeof buildCaseStatusSummary>>;
}) {
  if (summary.status !== "Refunded" && summary.status !== "Closed") return null;
  return (
    <p
      className={cn(
        "mt-2 rounded-md px-2 py-1.5 text-[11px] leading-relaxed",
        summary.status === "Refunded"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
          : "bg-surface-2 text-muted-foreground",
      )}
    >
      {summary.agentNote}
    </p>
  );
}

function CaseStatusOuterNote({
  summary,
}: {
  summary: NonNullable<ReturnType<typeof buildCaseStatusSummary>>;
}) {
  return (
    <p
      className={cn(
        "flex gap-2 rounded-md border px-2 py-1.5 text-[11px] leading-relaxed",
        summary.status === "On Hold"
          ? "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-200"
          : "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-200",
      )}
    >
      <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{summary.agentNote}</span>
    </p>
  );
}

function formatCaseDateOrState(
  value: string | null | undefined,
  fallback: string,
): string {
  return value ? formatHelpdeskDate(value) : fallback;
}

function CaseStatusDatum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 font-medium text-foreground">{value}</dd>
    </div>
  );
}

function OrderInfoSection({
  ticket,
  order,
  events,
}: {
  ticket: HelpdeskTicketDetail;
  order: UseOrderContextResult;
  events: HelpdeskTimelineEvent[];
}) {
  /**
   * Order Info card — fully eDesk-aligned now:
   *   - Order No. is a clickable link to eBay (no 3-dot menu).
   *   - Sales Record Number rendered inline in parentheses when available.
   *   - Every field gets its own row separated by a hairline so the agent
   *     can scan visually instead of parsing whitespace.
   *   - Tracking numbers render as copyable rows so replacement shipments
   *     uploaded directly on eBay are visible without opening the order.
   *   - Delivery address is a clickable Google Maps link (multi-line so the
   *     full address is visible without truncation).
   *   - Products list mirrors eDesk's compact stack: thumbnail + title + SKU
   *     on the left, qty × unit price on the right.
  */
  const [open, setOpen] = useState(true);
  const [inrChecked, setInrChecked] = useState(false);
  const [postageIssueChecked, setPostageIssueChecked] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionBanner, setActionBanner] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [actionStatus, setActionStatus] = useState<LabelFormatterActionStatus | null>(null);
  const [actionStatusLoading, setActionStatusLoading] = useState(false);
  const currentUser = useCurrentUser();
  const canRunOrderActions = canUseHelpdeskOrderActionsPermission(currentUser ?? {});
  const { data: ctx, loading, error } = order;

  useEffect(() => {
    if (!canRunOrderActions || !ticket.ebayOrderNumber) {
      setActionStatus(null);
      return;
    }
    const controller = new AbortController();
    setActionStatusLoading(true);
    fetch(`/api/helpdesk/tickets/${ticket.id}/label-formatter-action`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as LabelFormatterActionStatusResponse;
        if (!res.ok || !json.data) throw new Error(json.error ?? "Could not load order action status.");
        setActionStatus(json.data.status);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
      })
      .finally(() => {
        if (!controller.signal.aborted) setActionStatusLoading(false);
      });
    return () => controller.abort();
  }, [canRunOrderActions, ticket.ebayOrderNumber, ticket.id]);

  if (!ticket.ebayOrderNumber && ticket.kind !== "POST_SALES") {
    // Pre-sales inquiry with no order — hide the section entirely.
    return null;
  }

  // MFN/FBA badge: eBay sellers use MFN for "Merchant Fulfilled". We default
  // to MFN; the SDK doesn't expose Amazon-style FBA so this is informational.
  const fulfillmentBadge = "MFN";
  const trackingCarrier = ctx?.trackingCarrier ?? "USPS";
  const trackingEntries: OrderContextTracking[] =
    ctx?.trackingNumbers && ctx.trackingNumbers.length > 0
      ? ctx.trackingNumbers
      : ctx?.trackingNumber
        ? [
            {
              number: ctx.trackingNumber,
              carrier: ctx.trackingCarrier,
              shippedTime: ctx.shippedTime,
            },
          ]
        : [];
  const deliveryAddressText = ctx?.shippingAddress
    ? formatAddressMultiline(ctx.shippingAddress)
    : null;
  const buyerPhone = ctx?.shippingAddress?.phone?.trim() || null;

  // ── Refund derivation ────────────────────────────────────────────────────
  // Three shapes the agent can hit:
  //   1. eBay reports a refund on the order (MonetaryDetails) — direct
  //      seller refunds, partial or full. `ctx.refundCents` is set.
  //   2. The order was refunded through a return/INAD case — eBay zeroes
  //      AmountPaid so the order context says Total $0.00 with NO refund
  //      amount. We reconstruct the original from the line items so the
  //      agent isn't staring at a confusing bare "$0.00".
  //   3. No refund at all — render the plain total.
  // The case attribution ("via Return Case") comes from the same timeline
  // events the Case Status section uses.
  const caseSummary = buildCaseStatusSummary(events, ticket.messages);
  const caseRefundSource =
    caseSummary && caseSummary.status === "Refunded" ? caseSummary.title : null;
  const lineItemsSubtotalCents = (() => {
    const lines = ctx?.lineItems ?? [];
    if (lines.length === 0) return null;
    let sum = 0;
    for (const line of lines) {
      if (line.unitPriceCents == null || line.quantity == null) return null;
      sum += line.unitPriceCents * line.quantity;
    }
    return sum > 0 ? sum : null;
  })();
  const reportedRefundCents =
    ctx?.refundCents != null && ctx.refundCents > 0 ? ctx.refundCents : null;
  // Inferred full refund: eBay says $0 collected but the items weren't free.
  const zeroTotalWithValue =
    ctx?.totalCents === 0 &&
    reportedRefundCents == null &&
    lineItemsSubtotalCents != null;
  const inferredCaseRefund = zeroTotalWithValue && caseRefundSource != null;
  const inferredOriginalCents = zeroTotalWithValue
    ? lineItemsSubtotalCents! + (ctx?.shippingCents ?? 0)
    : null;
  // What the Total row shows: the reconstructed original when we inferred a
  // case refund, otherwise eBay's own number.
  const displayTotalCents = inferredCaseRefund
    ? inferredOriginalCents
    : ctx?.totalCents ?? null;
  const displayRefundCents = reportedRefundCents ?? (inferredCaseRefund ? inferredOriginalCents : null);
  const displayNetCents =
    reportedRefundCents != null
      ? ctx?.buyerNetCents ?? null
      : inferredCaseRefund
        ? 0
        : null;
  const refundIsFull =
    displayRefundCents != null &&
    displayTotalCents != null &&
    displayRefundCents >= displayTotalCents;
  const fallbackListing =
    ticket.listingInfo && ticket.ebayItemId === ticket.listingInfo.itemId
      ? ticket.listingInfo
      : null;
  const productItems: OrderContextLineItem[] =
    ctx?.lineItems && ctx.lineItems.length > 0
        ? ctx.lineItems.map((item) => {
          const listing =
            ticket.listingInfo && ticket.listingInfo.itemId === item.itemId
              ? ticket.listingInfo
              : null;
          return {
            ...item,
            title:
              item.title?.trim() ||
              ticket.ebayItemTitle ||
              listing?.title ||
              item.itemId,
            sku: item.sku ?? listing?.sku ?? null,
            pictureUrl: item.pictureUrl ?? listing?.imageUrl ?? null,
            currentInventory:
              item.currentInventory ?? listing?.currentInventory ?? null,
            catalogWeight:
              item.catalogWeight ?? listing?.catalogWeight ?? null,
          };
        })
      : ticket.ebayItemId
        ? [
            {
              itemId: ticket.ebayItemId,
              orderLineItemId: null,
              transactionId: null,
              title:
                ticket.ebayItemTitle ??
                fallbackListing?.title ??
                ticket.ebayItemId,
              sku: fallbackListing?.sku ?? null,
              currentInventory: fallbackListing?.currentInventory ?? null,
              catalogWeight: fallbackListing?.catalogWeight ?? null,
              quantity: 1,
              unitPriceCents: null,
              pictureUrl: fallbackListing?.imageUrl ?? null,
            } satisfies OrderContextLineItem,
          ]
        : [];
  async function runLabelFormatterAction() {
    setActionLoading(true);
    setActionBanner(null);
    try {
      const res = await fetch(`/api/helpdesk/tickets/${ticket.id}/label-formatter-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inr: inrChecked, postageIssue: postageIssueChecked }),
      });
      const json = (await res.json().catch(() => ({}))) as LabelFormatterActionResponse;
      if (!res.ok || !json.data) {
        throw new Error(json.error ?? "Order action failed.");
      }
      setActionStatus(json.data.status);

      const lines = json.data.lineItems
        .map((line) => `${line.sku} x${line.quantity}`)
        .join(", ");
      const labelPart = json.data.labelFormatter.previouslyAdded
        ? `Order ${json.data.orderNumber} was already added to the Label Formatter list`
        : json.data.labelFormatter.created
        ? `Added order ${json.data.orderNumber} to Label Formatter`
        : `Updated the existing Label Formatter row for ${json.data.orderNumber}`;
      const deductedLines = json.data.skuvault.deducted
        .map((line) => `${line.sku} x${line.quantityChanged}`)
        .join(", ");
      const skuvaultPart = deductedLines
        ? `Deducted ${deductedLines} from SkuVault.`
        : json.data.skuvault.alreadyDeducted || json.data.status.skuvault.deducted
          ? "SkuVault was already deducted for this ticket, so it was not deducted again."
          : "SkuVault deduction is still not recorded for this ticket.";
      const note = resolveLabelFormatterActionNote({
        inr: inrChecked,
        postageIssue: postageIssueChecked,
      });
      const notePart = note ? ` Added ${note} note.` : "";
      setActionBanner({
        type: "success",
        message: `${labelPart} (${lines}). ${skuvaultPart}${notePart} Label Formatter now has ${json.data.labelFormatter.totalRows} working rows.`,
      });
    } catch (err) {
      setActionBanner({
        type: "error",
        message: err instanceof Error ? err.message : "Order action failed.",
      });
    } finally {
      setActionLoading(false);
    }
  }

  const labelFormatterNoteOptions = {
    inr: inrChecked,
    postageIssue: postageIssueChecked,
  };
  const labelFormatterNoteSuffix = labelFormatterActionNoteSuffix(labelFormatterNoteOptions);

  return (
    <section className="border-b border-hairline bg-card/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-surface-2/40 cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <ShoppingBag className="h-3.5 w-3.5 text-brand" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
            <p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
              Order No.
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {ticket.ebayOrderNumber ? (
                <a
                  href={`https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(ticket.ebayOrderNumber)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-6 max-w-full items-center gap-1 truncate rounded-md border border-emerald-500/45 bg-emerald-500/10 px-2 font-mono text-[12px] font-bold text-emerald-700 shadow-sm transition-colors hover:border-emerald-400 hover:bg-emerald-500/15 hover:text-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30 dark:text-emerald-300 dark:hover:text-emerald-200 cursor-pointer"
                  title="Open this order on eBay (new tab)"
                >
                  {ticket.ebayOrderNumber}
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-70" />
                </a>
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
              {ctx?.salesRecordNumber ? (
                <span
                  className="font-mono text-xs text-muted-foreground"
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
            <p className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading live order
              details from eBay…
            </p>
          ) : null}
          {error && !ctx ? (
            <p className="mb-3 text-xs text-amber-700 dark:text-amber-300">
              {error}
            </p>
          ) : null}

          {/* Body rows — every field gets its own block separated by a hairline
           * divider, so the eye doesn't have to count whitespace to find the
           * next field. This is the layout from the user's screenshot. */}
          {canRunOrderActions ? (
            <div className="mb-3 rounded-md border border-emerald-500/25 bg-emerald-500/10 p-2.5">
              <div className="mb-2 flex items-start gap-2">
                <PackageMinus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-700 dark:text-emerald-300" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground">
                    Label Formatter action
                  </p>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Adds this order to Label Formatter and deducts the order SKUs from SkuVault. Optional notes: INR CASE or COUNTERFEIT (Postage Issue).
                  </p>
                </div>
              </div>
              {actionStatusLoading ? (
                <p className="mb-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Checking prior action status...
                </p>
              ) : actionStatus?.labelFormatter.added ? (
                <div
                  className={cn(
                    "mb-2 rounded border px-2 py-1.5 text-[11px] leading-snug",
                    actionStatus.labelFormatter.currentWorkingRow || actionStatus.labelFormatter.exported
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100",
                  )}
                >
                  {actionStatus.labelFormatter.currentWorkingRow
                    ? "Already added to Label Formatter"
                    : actionStatus.labelFormatter.exported
                      ? "Already exported from Label Formatter"
                      : "Previously added, but not currently in the Label Formatter working table"}
                  {actionStatus.labelFormatter.addedAt
                    ? ` on ${formatShortDate(actionStatus.labelFormatter.addedAt)}`
                    : ""}
                  .
                  {!actionStatus.labelFormatter.currentWorkingRow && !actionStatus.labelFormatter.exported ? (
                    <span className="mt-1 block">
                      Click Restore below to put it back without deducting SkuVault again.
                    </span>
                  ) : (
                    <span className="mt-1 block">
                      This stays recorded here even if the row is later removed from Label Formatter.
                    </span>
                  )}
                  {actionStatus.skuvault.deducted ? (
                    <span className="mt-1 block">
                      SkuVault deducted for {actionStatus.skuvault.skuCount} SKU{actionStatus.skuvault.skuCount === 1 ? "" : "s"}.
                    </span>
                  ) : (
                    <span className="mt-1 block text-amber-800 dark:text-amber-200">
                      SkuVault has not been deducted yet. Run the action to remove the order quantities.
                    </span>
                  )}
                </div>
              ) : null}
              <label className="mb-2 flex cursor-pointer items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={inrChecked}
                  onChange={(event) => setInrChecked(event.target.checked)}
                  disabled={actionLoading}
                />
                Add INR CASE note
              </label>
              <label className="mb-2 flex cursor-pointer items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={postageIssueChecked}
                  onChange={(event) => setPostageIssueChecked(event.target.checked)}
                  disabled={actionLoading}
                />
                Postage Issue note
              </label>
              <button
                type="button"
                onClick={() => void runLabelFormatterAction()}
                disabled={actionLoading || loading || !ctx || productItems.length === 0}
                className="inline-flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {actionLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {actionStatus?.labelFormatter.added && !actionStatus.labelFormatter.currentWorkingRow && !actionStatus.labelFormatter.exported
                  ? labelFormatterNoteSuffix
                    ? `Restore${labelFormatterNoteSuffix}`
                    : "Restore to Label Formatter"
                  : actionStatus?.labelFormatter.added
                  ? labelFormatterNoteSuffix
                    ? `Already Added${labelFormatterNoteSuffix}`
                    : "Already Added To List"
                  : actionStatus?.skuvault.deducted
                    ? labelFormatterNoteSuffix
                      ? `Re-add${labelFormatterNoteSuffix}`
                      : "Re-add to Label Formatter"
                    : labelFormatterNoteSuffix
                      ? `Add + Deduct${labelFormatterNoteSuffix}`
                      : "Add + Deduct SkuVault"}
              </button>
              {actionBanner ? (
                <p
                  className={cn(
                    "mt-2 rounded border px-2 py-1.5 text-[11px] leading-snug",
                    actionBanner.type === "success"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                      : "border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-200",
                  )}
                >
                  {actionBanner.message}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="divide-y divide-hairline rounded-md border border-hairline bg-surface/25 shadow-sm">
            {/* Ordered + Shipped on a single row, side-by-side, mirrors eDesk. */}
            <div className="grid grid-cols-2 gap-2 px-3 py-2.5 text-sm">
              <div>
                <p className="mb-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Ordered
                </p>
                <p className="text-foreground">
                  {formatShortDate(ctx?.createdTime ?? ctx?.paidTime)}
                </p>
              </div>
              <div>
                <p className="mb-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Shipped
                </p>
                <p className="text-foreground">
                  {ctx?.shippedTime ? formatShortDate(ctx.shippedTime) : "—"}
                </p>
              </div>
            </div>

            <div className="px-3 py-2.5 text-sm">
              <p className="mb-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                Tracking No.
              </p>
              {trackingEntries.length > 0 ? (
                <div className="space-y-1.5">
                  {trackingEntries.map((entry) => {
                    const carrier = entry.carrier ?? trackingCarrier;
                    const url = trackingUrl(carrier, entry.number);
                    return (
                      <div
                        key={`${carrier}-${entry.number}`}
                        className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 text-foreground"
                      >
                        <span
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-brand"
                          title={carrier}
                        >
                          <Truck className="h-3 w-3" />
                        </span>
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-w-0 whitespace-nowrap text-sky-600 hover:underline dark:text-sky-300"
                          title={`Track ${entry.number} on ${carrier}`}
                        >
                          <span className="font-mono text-[13px] font-semibold leading-tight">
                            {entry.number}
                          </span>
                          <span className="px-1 text-[11px] font-medium text-muted-foreground">
                            -
                          </span>
                          <span className="tabular-nums text-[11px] font-semibold text-sky-700 dark:text-sky-200">
                            {formatNumericDate(entry.shippedTime ?? ctx?.shippedTime)}
                          </span>
                        </a>
                        <CopyButton
                          value={entry.number}
                          title={`Copy tracking ${entry.number}`}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <span className="text-muted-foreground">
                  {ctx?.shippedTime
                    ? "Awaiting tracking upload"
                    : "Not yet shipped"}
                </span>
              )}
            </div>

            <div className="px-3 py-2.5 text-sm">
              <div className="mb-0.5 flex items-center justify-between gap-2">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
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

            <div className="px-3 py-2.5 text-sm">
              <div className="mb-0.5 flex items-center justify-between gap-2">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Delivery Address
                </p>
                {deliveryAddressText ? (
                  <CopyButton
                    value={deliveryAddressText}
                    title="Copy delivery address"
                  />
                ) : null}
              </div>
              {ctx?.shippingAddress ? (
                <>
                  <a
                    href={mapUrl(ctx.shippingAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-start gap-1 text-brand hover:underline"
                    title="Open in Google Maps"
                  >
                    <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="whitespace-pre-line text-sm leading-snug text-foreground">
                      {deliveryAddressText}
                    </span>
                  </a>
                  {buyerPhone ? (
                    <div className="mt-2 rounded border border-hairline bg-surface/50 px-2 py-1.5">
                      <div className="mb-0.5 flex items-center justify-between gap-2">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Buyer Phone Number
                        </p>
                        <CopyButton
                          value={buyerPhone}
                          title="Copy buyer phone number"
                        />
                      </div>
                      <a
                        href={`tel:${buyerPhone.replace(/[^\d+]/g, "")}`}
                        className="inline-flex items-center gap-1 font-mono text-xs text-brand hover:underline"
                      >
                        <Phone className="h-3 w-3" />
                        {buyerPhone}
                      </a>
                    </div>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>
          </div>

          {/* Products — separated with a strong divider so it reads as a
           * distinct section, the way eDesk visually breaks Order Info from
           * the line items. Each row shows thumbnail, title, SKU, qty + price. */}
          <div className="mt-4">
            <p className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              Products
            </p>
            <div className="space-y-2">
              {productItems.map((item) => {
                const ebayItemUrl = `https://www.ebay.com/itm/${item.itemId}`;
                return (
                  <div
                    key={item.itemId}
                    className="flex items-start gap-2 rounded-md border border-hairline bg-surface p-2 shadow-sm"
                  >
                    <a
                      href={ebayItemUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 rounded transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                    >
                      {item.pictureUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={item.pictureUrl}
                          alt=""
                          className="h-10 w-10 rounded border border-hairline object-cover"
                        />
                      ) : (
                        <div className="flex h-10 w-10 items-center justify-center rounded border border-hairline bg-surface-2 text-muted-foreground">
                          <Package className="h-4 w-4" />
                        </div>
                      )}
                    </a>
                    <div className="min-w-0 flex-1">
                      <a
                        href={ebayItemUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="line-clamp-2 text-sm text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                      >
                        {item.title}
                      </a>
                      {item.sku ? (
                        <SkuInventoryLine
                          sku={item.sku}
                          currentInventory={item.currentInventory}
                        />
                      ) : null}
                      {item.catalogWeight ? (
                        <CatalogWeightBlurb
                          weight={item.catalogWeight}
                          quantity={item.quantity ?? 1}
                        />
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right text-xs">
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
                  </div>
                );
              })}
              {productItems.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No products on this ticket.
                </p>
              ) : null}
            </div>

            {ctx?.shippingCents != null ? (
              // Shipping fee row — sits BETWEEN the products list and the
              // Total so the agent sees: products → shipping → total. Mirrors
              // eDesk's right-rail. Hidden on free shipping (null cents).
              <div className="mt-3 flex items-center justify-between border-t border-hairline pt-2 text-sm">
                <span className="text-muted-foreground">Shipping</span>
                <span className="text-foreground">
                  {ctx.shippingCents === 0
                    ? "Free"
                    : formatMoney(ctx.shippingCents, ctx.currency)}
                </span>
              </div>
            ) : null}
            {displayTotalCents != null ? (
              <div
                className={cn(
                  "flex items-center justify-between border-t border-hairline pt-2 text-sm",
                  ctx?.shippingCents != null ? "mt-2" : "mt-3",
                )}
              >
                <span className="font-semibold text-foreground">Total</span>
                <span
                  className={cn(
                    "font-semibold",
                    displayRefundCents != null
                      ? "text-muted-foreground line-through decoration-amber-500/70"
                      : "text-foreground",
                  )}
                >
                  {formatMoney(displayTotalCents, ctx?.currency)}
                </span>
              </div>
            ) : null}
            {displayRefundCents != null ? (
              // Refund block — appears when eBay reports a refund on the
              // order (direct refunds) OR when the order context shows $0.00
              // collected and the ticket's return/INAD case is refunded
              // (case refunds zero out AmountPaid without a refund line).
              // Shows the refunded amount, where it came from, and the
              // buyer's net so the agent never has to do the math (or open
              // eBay) to know what the buyer actually ended up paying.
              <div className="mt-2 space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="inline-flex items-center gap-1 font-semibold text-amber-700 dark:text-amber-300">
                    <ReceiptText className="h-3.5 w-3.5" />
                    {refundIsFull ? "Fully Refunded" : "Partially Refunded"}
                    {ctx?.refundStatus && ctx.refundStatus !== "Success" ? (
                      <span className="font-medium text-muted-foreground">
                        ({ctx.refundStatus})
                      </span>
                    ) : null}
                  </span>
                  <span className="font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                    -{formatMoney(displayRefundCents, ctx?.currency)}
                  </span>
                </div>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {caseRefundSource
                    ? `Refunded to the buyer via the ${caseRefundSource.toLowerCase()} on eBay.`
                    : "Refunded to the buyer on eBay (outside a return case)."}
                </p>
                {displayNetCents != null ? (
                  <div className="flex items-center justify-between gap-2 border-t border-amber-500/20 pt-1.5 text-sm">
                    <span className="font-semibold text-foreground">
                      Net After Refund
                    </span>
                    <span className="font-semibold tabular-nums text-foreground">
                      {formatMoney(displayNetCents, ctx?.currency)}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : zeroTotalWithValue ? (
              // $0.00 collected, items weren't free, but we can't pin it to
              // a refunded case — say SOMETHING so the bare zero isn't
              // mistaken for a pricing bug.
              <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                eBay reports $0.00 collected for this order — it was likely
                refunded or cancelled.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ── Related tickets ────────────────────────────────────────────────────────

function ReturnLabelSection({ ticket }: { ticket: HelpdeskTicketDetail }) {
  const currentUser = useCurrentUser();
  const canGenerate = canUseHelpdeskOrderActionsPermission(currentUser ?? {});
  const isEbay = ticket.channel === "TPP_EBAY" || ticket.channel === "TT_EBAY";
  const enabled = canGenerate && isEbay && Boolean(ticket.ebayOrderNumber);
  const { labels, loading, generating, error, generate } = useReturnLabels(ticket, enabled);
  const [banner, setBanner] = useState<string | null>(null);

  if (!enabled) return null;

  async function onGenerateClick() {
    setBanner(null);
    const hasExisting = labels.length > 0;
    if (
      hasExisting &&
      !window.confirm(
        "A return label was already generated for this ticket. Do you wish to generate another one?",
      )
    ) {
      return;
    }

    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    try {
      const label = await generate(hasExisting);
      if (popup) {
        popup.location.href = label.openUrl;
      } else {
        window.open(label.openUrl, "_blank", "noopener,noreferrer");
      }
      setBanner(`Generated return label ${label.trackingNumber}.`);
    } catch (err) {
      popup?.close();
      setBanner(err instanceof Error ? err.message : "Return label generation failed.");
    }
  }

  return (
    <section className="border-b border-hairline bg-card/40 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileText className="h-3.5 w-3.5 text-brand" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Return Label
          </h3>
        </div>
        {loading ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Checking
          </span>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => void onGenerateClick()}
        disabled={generating}
        className="inline-flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md bg-brand px-2 text-xs font-semibold text-primary-foreground hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {generating ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <FileText className="h-3.5 w-3.5" />
        )}
        Generate Return Label
      </button>

      {labels.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {labels.map((label) => (
            <a
              key={label.id}
              href={label.downloadUrl}
              className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md border border-hairline bg-surface px-2.5 py-2 text-xs text-foreground shadow-sm transition-colors hover:border-brand/30 hover:bg-surface-2"
            >
              <Download className="h-3.5 w-3.5 shrink-0 text-brand" />
              <span className="min-w-0 flex-1 truncate font-mono font-semibold">
                {label.trackingNumber}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {formatShortDate(label.createdAt)}
              </span>
            </a>
          ))}
        </div>
      ) : null}

      {banner || error ? (
        <p
          className={cn(
            "mt-2 rounded border px-2 py-1.5 text-[11px] leading-snug",
            banner?.startsWith("Generated")
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
              : "border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-200",
          )}
        >
          {banner ?? error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * One entry in the feedback history list: either feedback that was left
 * (buyer-authored or automated) or a "Feedback Removal Approved" event.
 * Rendered oldest-first so the section reads as the actual story:
 * "buyer left negative → eBay approved removal".
 */
type FeedbackHistoryEntry =
  | { type: "feedback"; at: string; item: FeedbackSummaryItem }
  | { type: "removal"; at: string };

function buildFeedbackHistory(
  data: FeedbackSummaryResponse["data"] | null,
): FeedbackHistoryEntry[] {
  if (!data) return [];
  const entries: FeedbackHistoryEntry[] = data.items.map((item) => ({
    type: "feedback" as const,
    at: item.leftAt,
    item,
  }));
  for (const removal of data.removals ?? []) {
    entries.push({ type: "removal", at: removal.at });
  }
  return entries.sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
}

function FeedbackHistoryItemCard({
  item,
  leaveBy,
}: {
  item: FeedbackSummaryItem;
  leaveBy: Date | null;
}) {
  const kindLabel = item.kind.charAt(0) + item.kind.slice(1).toLowerCase();
  const removed = Boolean(item.removedAt);
  return (
    <div
      className={cn(
        "rounded-md border border-hairline bg-surface/50 p-2",
        removed && "border-dashed",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
              item.isAutomated
                ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
                : item.kind === "POSITIVE"
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : item.kind === "NEGATIVE"
                  ? "bg-red-500/15 text-red-700 dark:text-red-300"
                  : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
            )}
          >
            {item.isAutomated ? "Automated by eBay" : `Buyer ${kindLabel}`}
          </span>
          {removed ? (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Removed
            </span>
          ) : null}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {formatFeedbackDate(item.leftAt)}
        </span>
      </div>
      <p className="mt-1 text-xs font-medium text-foreground">
        {item.isAutomated
          ? `Automated eBay ${kindLabel} Feedback`
          : `Buyer-authored ${kindLabel} Feedback`}
      </p>
      {!removed ? (
        <p
          className={cn(
            "mt-1 rounded border px-2 py-1.5 text-[11px] leading-relaxed",
            item.isAutomated
              ? "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-200"
              : "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200",
          )}
        >
          {item.isAutomated
            ? "Automated eBay Feedback."
            : "Feedback left directly by the buyer."}
        </p>
      ) : null}
      {typeof item.starRating === "number" && item.starRating > 0 ? (
        <p className="mt-1 text-xs text-foreground">
          Rating: {item.starRating}/5
        </p>
      ) : null}
      {item.comment ? (
        <p
          className={cn(
            "mt-1 line-clamp-4 text-xs leading-relaxed",
            removed ? "text-muted-foreground line-through" : "text-foreground",
          )}
        >
          "{item.comment}"
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          Feedback was left without a public comment.
        </p>
      )}
      {item.sellerResponse ? (
        <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
          Seller response: {item.sellerResponse}
        </p>
      ) : null}
      {item.isAutomated && !removed && leaveBy ? (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Buyer can still change this by leaving their own feedback until{" "}
          <span className="font-medium text-foreground">
            {formatFeedbackDeadline(leaveBy)}
          </span>
          .
        </p>
      ) : null}
    </div>
  );
}

function FeedbackRemovalCard({ at }: { at: string }) {
  return (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
          <ShieldCheck className="h-3 w-3" />
          Feedback Removal Approved
        </span>
        <span className="text-[10px] text-muted-foreground">
          {formatFeedbackDate(at)}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        eBay approved the removal request and removed this feedback, including
        the ratings.
      </p>
    </div>
  );
}

function FeedbackSection({
  ticket,
  order,
  feedback,
}: {
  ticket: HelpdeskTicketDetail;
  order: OrderContext | null;
  feedback: UseFeedbackSummaryResult;
}) {
  const isEbay = ticket.channel === "TPP_EBAY" || ticket.channel === "TT_EBAY";
  if (!isEbay || !ticket.ebayOrderNumber) return null;

  const history = buildFeedbackHistory(feedback.data ?? null);
  const first = feedback.data?.items[0] ?? null;
  const state = feedback.data?.state ?? "UNKNOWN";
  const leaveBy = feedbackLeaveByDate(ticket, order);
  const hasRemoval = (feedback.data?.removals?.length ?? 0) > 0;

  return (
    <section className="border-b border-hairline bg-card/40 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Star className="h-3.5 w-3.5 text-brand" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Feedback
          </h3>
        </div>
        {feedback.loading ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Checking
          </span>
        ) : first?.source === "live" ? (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-foreground">
            Live
          </span>
        ) : null}
      </div>

      {feedback.error ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Feedback lookup unavailable.
        </p>
      ) : history.length > 0 ? (
        <div className="space-y-1.5">
          {history.map((entry, idx) =>
            entry.type === "feedback" ? (
              <FeedbackHistoryItemCard
                key={`fb-${entry.item.id}`}
                item={entry.item}
                leaveBy={leaveBy}
              />
            ) : (
              <FeedbackRemovalCard key={`rm-${idx}`} at={entry.at} />
            ),
          )}
          {hasRemoval && (feedback.data?.items.length ?? 0) === 0 ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              The original feedback text wasn't captured before eBay removed
              it, so only the removal is shown here.
            </p>
          ) : null}
        </div>
      ) : state === "NOT_LEFT" ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>Feedback has not been left for this order.</p>
          {leaveBy ? (
            <p>
              Buyer can leave feedback until{" "}
              <span className="font-medium text-foreground">
                {formatFeedbackDeadline(leaveBy)}
              </span>
              .
            </p>
          ) : null}
        </div>
      ) : feedback.loading ? (
        <p className="text-xs text-muted-foreground">Checking eBay feedback...</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          No feedback result available yet.
        </p>
      )}
    </section>
  );
}

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
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Other Tickets from this Buyer
      </h3>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : related.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No other tickets on file.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {related.map((t) => (
            <li key={t.id}>
              <Link
                href={`/help-desk?ticket=${t.id}`}
                className="block rounded-md border border-hairline bg-surface px-2.5 py-2 shadow-sm transition-colors hover:border-brand/30 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <p className="line-clamp-1 min-w-0 flex-1 text-sm text-foreground">
                    {t.subject ?? t.ebayItemTitle ?? "Untitled"}
                  </p>
                  {t.type === "SYSTEM" || t.systemMessageType ? (
                    <span
                      className="inline-flex shrink-0 items-center rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-200"
                      title="This related ticket is an eBay system message, not a buyer-authored conversation."
                    >
                      System
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{t.status.replace("_", " ").toLowerCase()}</span>
                  {t.type === "SYSTEM" || t.systemMessageType ? (
                    <span className="font-semibold text-amber-700 dark:text-amber-300">
                      eBay system message
                    </span>
                  ) : null}
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

const EBAY_ORDER_TIME_ZONE = "America/Los_Angeles";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-xs font-medium text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-right text-sm">{children}</dd>
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
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-brand/25 bg-brand-muted/60 text-brand shadow-sm transition-colors hover:border-brand/50 hover:bg-brand-muted hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 cursor-pointer"
      title={title}
    >
      {copied ? (
        <Check className="h-3 w-3" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

function SkuInventoryLine({
  sku,
  currentInventory,
}: {
  sku: string;
  currentInventory: number | null | undefined;
}) {
  return (
    <div className="mt-1 grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      <span className="min-w-0 whitespace-normal break-all font-mono text-xs font-medium leading-snug text-emerald-700 dark:text-emerald-300">
        {sku}
      </span>
      <CopyButton value={sku} title="Copy SKU" />
      <InventoryBadge value={currentInventory} />
    </div>
  );
}

/** Catalog weight × qty; click toggles oz ↔ lbs (total line weight). */
function CatalogWeightBlurb({
  weight,
  quantity = 1,
}: {
  weight: string;
  quantity?: number;
}) {
  const [showLbs, setShowLbs] = useState(false);
  const totalOz = totalWeightOzFromCatalogLabel(weight, quantity);
  if (totalOz == null) return null;

  const display = showLbs
    ? formatOrderLineWeightLbs(totalOz)
    : formatOrderLineWeightOz(totalOz);

  return (
    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/85">
        Weight
      </span>
      <span className="mx-1.5 text-foreground/35" aria-hidden>
        ·
      </span>
      <button
        type="button"
        onClick={() => setShowLbs((v) => !v)}
        className="relative z-10 cursor-pointer font-medium tabular-nums text-foreground/90 underline-offset-2 hover:text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
        title={showLbs ? "Show ounces" : "Show pounds"}
        aria-label={`Total weight ${display}. Click to show ${showLbs ? "ounces" : "pounds"}.`}
      >
        {display}
      </button>
    </p>
  );
}

function InventoryBadge({ value }: { value: number | null | undefined }) {
  if (value == null) return null;

  return (
    <span
      className="shrink-0 font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-300"
      title={`Current inventory: ${value}`}
    >
      [{value}]
    </span>
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
    const date = new Date(value);
    const includeYear =
      yearInTimeZone(date, EBAY_ORDER_TIME_ZONE) !==
      yearInTimeZone(new Date(), EBAY_ORDER_TIME_ZONE);
    return date.toLocaleDateString(undefined, {
      timeZone: EBAY_ORDER_TIME_ZONE,
      month: "short",
      day: "numeric",
      ...(includeYear ? { year: "numeric" as const } : {}),
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
      timeZone: EBAY_ORDER_TIME_ZONE,
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function formatNumericDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString(undefined, {
      timeZone: EBAY_ORDER_TIME_ZONE,
      month: "numeric",
      day: "numeric",
      year: "2-digit",
    });
  } catch {
    return "—";
  }
}

function trackingUrl(carrier: string | null | undefined, number: string): string {
  const trackingNumber = number.trim();
  const normalizedCarrier = (carrier ?? "").toLowerCase();
  const encoded = encodeURIComponent(trackingNumber);
  if (/usps|postal|post office/.test(normalizedCarrier)) {
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encoded}`;
  }
  if (/\bups\b|united parcel/.test(normalizedCarrier)) {
    return `https://www.ups.com/track?tracknum=${encoded}`;
  }
  if (/fedex|federal express/.test(normalizedCarrier)) {
    return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
  }
  if (/\bdhl\b/.test(normalizedCarrier)) {
    return `https://www.dhl.com/us-en/home/tracking/tracking-express.html?tracking-id=${encoded}`;
  }
  if (/ontrac/.test(normalizedCarrier)) {
    return `https://www.ontrac.com/tracking/?number=${encoded}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(
    `${carrier ?? ""} tracking ${trackingNumber}`.trim(),
  )}`;
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
          timeZone: EBAY_ORDER_TIME_ZONE,
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

function yearInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    year: "numeric",
  }).format(date);
}

function formatFeedbackDate(value: string | null | undefined): string {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}

function validDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function earliestDate(dates: Array<Date | null>): Date | null {
  const valid = dates.filter((date): date is Date => Boolean(date));
  if (valid.length === 0) return null;
  return valid.reduce((earliest, date) =>
    date.getTime() < earliest.getTime() ? date : earliest,
  );
}

function feedbackLeaveByDate(
  ticket: HelpdeskTicketDetail,
  order: OrderContext | null,
): Date | null {
  const deliveredOrExpected = earliestDate([
    validDate(order?.actualDeliveryTime),
    validDate(order?.estimatedDeliveryMax ?? order?.estimatedDeliveryMin),
  ]);
  if (deliveredOrExpected) return addDays(deliveredOrExpected, 60);

  const purchased = validDate(order?.createdTime ?? order?.paidTime ?? ticket.createdAt);
  return purchased ? addDays(purchased, 90) : null;
}

function formatFeedbackDeadline(date: Date): string {
  return date.toLocaleDateString(undefined, {
    timeZone: EBAY_ORDER_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
