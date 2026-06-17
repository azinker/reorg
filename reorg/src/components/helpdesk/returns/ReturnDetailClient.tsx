"use client";

/**
 * Return Cases detail (/help-desk/returns/[returnId]).
 *
 * Re-fetches the latest return detail from eBay (read-only) on load, then shows
 * an eBay-Seller-Hub-style flow: a progress line, the current required action,
 * a right rail with order/return context, return details, a unified timeline,
 * and admin debug panels.
 *
 * Every seller action is gated three ways before it can fire a live write:
 *   1. eBay currently offers the option (availability.availableOnEbay)
 *   2. we don't policy-block it (availability.policyBlocked)
 *   3. the returns live-write lock is OFF (returnsLiveWritesEnabled)
 * and even then it runs preview → (typed) confirm → commit. The commit endpoint
 * re-checks all of the above server-side; the client gating is UX only.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  ShieldAlert,
  PackageOpen,
  CheckCircle2,
  XCircle,
  Truck,
  DollarSign,
  Clock,
  Lock,
  AlertTriangle,
  ExternalLink,
  MessageSquare,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
} from "lucide-react";
import {
  StoreBadge,
  LifecycleBadge,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  humanizeReason,
  STORE_FULL,
  type ReturnLifecycle,
} from "./returns-ui";

type ActionKey =
  | "APPROVE_RETURN"
  | "OFFER_PARTIAL_REFUND"
  | "UPLOAD_LABEL"
  | "CONFIRM_LABEL_SENT"
  | "PROVIDE_EBAY_LABEL"
  | "MARK_AS_RECEIVED"
  | "ISSUE_REFUND";

interface ActionAvailability {
  key: ActionKey;
  availableOnEbay: boolean;
  policyBlocked: boolean;
}

interface TrackingEvent {
  id: string;
  carrier: string | null;
  trackingNumber: string | null;
  eventDate: string | null;
  status: string | null;
  location: string | null;
  description: string | null;
}

interface ReturnFile {
  id: string;
  fileName: string | null;
  filePurpose: string | null;
  url: string | null;
  source: string | null;
  createdAt: string;
}

interface ActionAttempt {
  id: string;
  actionType: string;
  status: string;
  ebayRequestId: string | null;
  blockReason: string | null;
  errorMessage: string | null;
  createdAt: string;
  committedAt: string | null;
}

interface ReturnDetail {
  id: string;
  returnId: string;
  platform: string;
  ebayOrderNumber: string | null;
  ebayItemId: string | null;
  transactionId: string | null;
  returnQuantity: number | null;
  itemTitle: string | null;
  imageUrl: string | null;
  sku: string | null;
  buyerUserId: string | null;
  returnState: string | null;
  returnStatus: string | null;
  currentType: string | null;
  lifecycle: ReturnLifecycle;
  isClosed: boolean;
  sellerActionDue: boolean;
  escalated: boolean;
  caseId: string | null;
  reason: string | null;
  reasonType: string | null;
  buyerComments: string | null;
  sellerRefund: { value: number | null; currency: string | null; isActual: boolean };
  sellerResponseDueAt: string | null;
  buyerResponseDueAt: string | null;
  timeoutDate: string | null;
  openedAt: string;
  closedAt: string | null;
  ticketId: string | null;
  detailFetchedAt: string | null;
  lastSyncedAt: string;
  availability: ActionAvailability[];
  returnsLiveWritesEnabled: boolean;
  trackingEvents: TrackingEvent[];
  files: ReturnFile[];
  actionAttempts: ActionAttempt[];
  debug: { rawSummary: unknown; rawDetail: unknown; refreshError: string | null };
}

interface PreviewSummary {
  action: ActionKey;
  headline: string;
  lines: string[];
  requiresTypedConfirmation: boolean;
  finalRefundAmount?: number;
  currency?: string;
}

const CARRIERS = [
  { value: "USPS", label: "USPS" },
  { value: "UPS", label: "UPS" },
  { value: "FEDEX", label: "FedEx" },
  { value: "DHL", label: "DHL" },
  { value: "OTHER", label: "Other" },
];

// Actions the v1 write flow can actually execute (subset of ActionKey).
// PROVIDE_EBAY_LABEL is intentionally NOT here — it purchases a paid eBay label
// and is handled as a deep-link to eBay's own label-purchase flow instead.
const EXECUTABLE: ActionKey[] = [
  "APPROVE_RETURN",
  "OFFER_PARTIAL_REFUND",
  "UPLOAD_LABEL",
  "CONFIRM_LABEL_SENT",
  "MARK_AS_RECEIVED",
  "ISSUE_REFUND",
];

// Order the seller actions exactly like eBay's "Provide a return shipping
// label" screen. ISSUE_REFUND is rendered separately as the green Send-refund
// button under the Estimated refund card.
const ACTION_DISPLAY_ORDER: ActionKey[] = [
  "APPROVE_RETURN",
  "OFFER_PARTIAL_REFUND",
  "PROVIDE_EBAY_LABEL",
  "UPLOAD_LABEL",
  "CONFIRM_LABEL_SENT",
  "MARK_AS_RECEIVED",
];

const ACTION_META: Record<
  ActionKey,
  { label: string; desc: string; icon: typeof CheckCircle2 }
> = {
  APPROVE_RETURN: {
    label: "Approve return",
    desc: "Notify the buyer the return is approved.",
    icon: CheckCircle2,
  },
  OFFER_PARTIAL_REFUND: {
    label: "Offer partial refund",
    desc: "Offer the buyer a partial refund to keep the item.",
    icon: DollarSign,
  },
  UPLOAD_LABEL: {
    label: "Upload a label",
    desc: "Upload a return label and tracking from your preferred carrier.",
    icon: Truck,
  },
  CONFIRM_LABEL_SENT: {
    label: "Confirm you sent a label",
    desc: "Confirm you already provided a return label to the buyer.",
    icon: Truck,
  },
  PROVIDE_EBAY_LABEL: {
    label: "Provide an eBay label",
    desc: "Purchase an eBay return label based on eBay-negotiated rates (opens eBay).",
    icon: Truck,
  },
  MARK_AS_RECEIVED: {
    label: "Mark as received",
    desc: "Confirm the returned item arrived back to you.",
    icon: PackageOpen,
  },
  ISSUE_REFUND: {
    label: "Send refund",
    desc: "Refund the buyer (optionally with a deduction up to 50%).",
    icon: DollarSign,
  },
};

/** Deep link to the eBay return case (opens in a new tab). */
function ebayReturnUrl(returnId: string): string {
  return `https://www.ebay.com/rtn/Return/ReturnsDetail?returnId=${encodeURIComponent(returnId)}`;
}

export default function ReturnDetailClient({ returnId }: { returnId: string }) {
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReturnDetail | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  // The raw eBay payload debug panel is hidden from the normal seller view.
  // It's only rendered when the page is opened with `?debug=1` for support.
  const [debugEnabled, setDebugEnabled] = useState(false);
  useEffect(() => {
    try {
      setDebugEnabled(new URLSearchParams(window.location.search).get("debug") === "1");
    } catch {
      /* no-op */
    }
  }, []);

  // Action modal state
  const [activeAction, setActiveAction] = useState<ActionKey | null>(null);

  const load = useCallback(
    async (refresh: boolean) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/helpdesk/returns/${encodeURIComponent(returnId)}?refresh=${refresh ? "1" : "0"}`,
          { cache: "no-store" },
        );
        if (res.status === 403) {
          setForbidden(true);
          return;
        }
        if (res.status === 404) {
          setError("Return not found.");
          return;
        }
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        const json = (await res.json()) as { data: ReturnDetail };
        setDetail(json.data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load return.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [returnId],
  );

  // First load refreshes from eBay so availability is authoritative.
  useEffect(() => {
    void load(true);
  }, [load]);

  if (forbidden) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-12">
        <div className="rounded-xl border border-hairline bg-card p-6 text-center">
          <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-amber-500" />
          <h1 className="text-lg font-semibold text-foreground">Admins only</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Return Cases is restricted to Admin users in v1.
          </p>
          <Link
            href="/help-desk/returns"
            className="mt-4 inline-flex items-center gap-2 rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-foreground hover:bg-surface-2 cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Return Cases
          </Link>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full min-h-[400px] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-12">
        <Link
          href="/help-desk/returns"
          className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Return Cases
        </Link>
        <div className="rounded-xl border border-hairline bg-card p-6 text-center text-sm text-red-600 dark:text-red-300">
          {error ?? "Return not found."}
        </div>
      </div>
    );
  }

  const liveBlocked = !detail.returnsLiveWritesEnabled;
  const availMap = new Map(detail.availability.map((a) => [a.key, a]));

  function actionState(key: ActionKey): {
    enabled: boolean;
    reason: string | null;
  } {
    const a = availMap.get(key);
    if (!a || !a.availableOnEbay) {
      return { enabled: false, reason: "eBay does not currently offer this action." };
    }
    if (a.policyBlocked) {
      return {
        enabled: false,
        reason:
          key === "PROVIDE_EBAY_LABEL"
            ? "Buying an eBay-paid label is blocked by reorG policy."
            : "Blocked by reorG policy.",
      };
    }
    if (!EXECUTABLE.includes(key)) {
      return { enabled: false, reason: "Not supported in reorG v1." };
    }
    if (liveBlocked) {
      return {
        enabled: false,
        reason: "Live return writes are locked. Turn the lock OFF on the Return Cases page.",
      };
    }
    return { enabled: true, reason: null };
  }

  // Build the ordered list of seller actions eBay currently offers, in eBay's
  // own order. ISSUE_REFUND is pulled out and rendered as the green Send-refund
  // button under the Estimated refund card.
  const offeredActions = ACTION_DISPLAY_ORDER.map((key) => availMap.get(key))
    .filter((a): a is ActionAvailability => !!a && a.availableOnEbay);
  const refundAvail = availMap.get("ISSUE_REFUND");
  const refundState = actionState("ISSUE_REFUND");
  const showRefundButton = !detail.isClosed && !!refundAvail?.availableOnEbay;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      {/* Top bar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/help-desk/returns"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Return Cases
        </Link>
        <div className="flex items-center gap-2">
          {detail.detailFetchedAt ? (
            <span className="text-[11px] text-muted-foreground">
              Detail fetched {fmtDateTime(detail.detailFetchedAt)}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
          >
            {refreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh from eBay
          </button>
        </div>
      </div>

      {detail.debug.refreshError ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Live refresh failed — showing cached data. {detail.debug.refreshError}
        </div>
      ) : null}

      {liveBlocked ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <Lock className="h-4 w-4 shrink-0" />
          Live return writes are <strong>LOCKED</strong>. You can preview every
          action, but commits are disabled until an admin turns the lock OFF on
          the Return Cases page.
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* ── Main column ─────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-6">
          <ProgressLine lifecycle={detail.lifecycle} isClosed={detail.isClosed} />

          {/* Action area */}
          <section className="rounded-xl border border-hairline bg-card p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-foreground">
                {detail.isClosed
                  ? "This return is closed"
                  : detail.sellerActionDue
                    ? "Action needed"
                    : "No action needed right now"}
              </h2>
              <LifecycleBadge
                lifecycle={detail.lifecycle}
                rawLabel={detail.returnState}
              />
            </div>

            {detail.isClosed ? (
              <p className="text-sm text-muted-foreground">
                No further seller actions are available. See the timeline below
                for the full history.
              </p>
            ) : offeredActions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                eBay is not offering any seller actions right now. This usually
                means the ball is in the buyer&apos;s court (e.g. awaiting the
                buyer to ship). Refresh to re-check.
              </p>
            ) : (
              <div className="space-y-2">
                {offeredActions.map((a) => {
                  const meta = ACTION_META[a.key];
                  const Icon = meta.icon;

                  // "Provide an eBay label" buys a paid eBay label through
                  // eBay's own purchase flow — deep-link there instead of
                  // firing an ambiguous paid API write.
                  if (a.key === "PROVIDE_EBAY_LABEL") {
                    return (
                      <a
                        key={a.key}
                        href={ebayReturnUrl(detail.returnId)}
                        target="_blank"
                        rel="noreferrer"
                        className="flex w-full items-start gap-3 rounded-lg border border-brand/30 bg-brand/5 p-3 text-left transition-colors hover:bg-brand/10 cursor-pointer"
                      >
                        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground">
                              {meta.label}
                            </span>
                            <span className="inline-flex items-center gap-1 rounded bg-brand/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand">
                              <ExternalLink className="h-2.5 w-2.5" /> eBay
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {meta.desc}
                          </p>
                        </div>
                      </a>
                    );
                  }

                  const st = actionState(a.key);
                  return (
                    <button
                      key={a.key}
                      type="button"
                      disabled={!st.enabled}
                      onClick={() => st.enabled && setActiveAction(a.key)}
                      title={st.reason ?? meta.desc}
                      className={
                        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors " +
                        (st.enabled
                          ? "border-brand/30 bg-brand/5 hover:bg-brand/10 cursor-pointer"
                          : "border-hairline/60 bg-surface/40 opacity-70 cursor-not-allowed")
                      }
                    >
                      <Icon
                        className={
                          "mt-0.5 h-4 w-4 shrink-0 " +
                          (st.enabled ? "text-brand" : "text-muted-foreground")
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {meta.label}
                          </span>
                          {!st.enabled && a.policyBlocked ? (
                            <span className="inline-flex items-center gap-1 rounded bg-zinc-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-600 dark:text-zinc-400">
                              <Lock className="h-2.5 w-2.5" /> Blocked
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {st.enabled ? meta.desc : st.reason}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Return details */}
          <section className="rounded-xl border border-hairline bg-card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Return details
            </h2>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <Detail label="Reason" value={humanizeReason(detail.reason)} />
              <Detail label="Return type" value={detail.currentType ?? "Return"} />
              <Detail
                label="Quantity"
                value={detail.returnQuantity != null ? String(detail.returnQuantity) : "—"}
              />
              <Detail label="SKU" value={detail.sku ?? "—"} />
              <Detail
                label="Escalated"
                value={detail.escalated ? "Yes — eBay involved" : "No"}
              />
              <Detail
                label="eBay case"
                value={
                  <a
                    href={ebayReturnUrl(detail.returnId)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-brand hover:underline"
                  >
                    {detail.caseId ?? detail.returnId}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                }
              />
            </dl>
            {detail.buyerComments ? (
              <div className="mt-4 rounded-lg border border-hairline bg-surface p-3">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Buyer comments
                </p>
                <p className="whitespace-pre-wrap text-sm text-foreground">
                  {detail.buyerComments}
                </p>
              </div>
            ) : null}
          </section>

          {/* Timeline */}
          <Timeline detail={detail} />

          {/* Debug (admin) — hidden from the normal seller view; only shown
              when the page is opened with ?debug=1 for support triage. */}
          {debugEnabled ? (
            <section className="rounded-xl border border-hairline bg-card">
              <button
                type="button"
                onClick={() => setShowDebug((v) => !v)}
                className="flex w-full items-center justify-between px-5 py-3 text-sm font-semibold text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <span className="uppercase tracking-wider">Debug (admin)</span>
                {showDebug ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </button>
              {showDebug ? (
                <div className="space-y-3 border-t border-hairline px-5 py-4">
                  <DebugBlock title="Availability" data={detail.availability} />
                  <DebugBlock title="Raw summary" data={detail.debug.rawSummary} />
                  <DebugBlock title="Raw detail" data={detail.debug.rawDetail} />
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        {/* ── Right rail ──────────────────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="rounded-xl border border-hairline bg-card p-4">
            <div className="flex gap-3">
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md border border-hairline bg-surface">
                {detail.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={detail.imageUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <PackageOpen className="h-5 w-5 text-muted-foreground/50" />
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <StoreBadge platform={detail.platform} />
                <p className="mt-1 line-clamp-3 text-sm font-medium text-foreground">
                  {detail.itemTitle ?? "(no title)"}
                </p>
              </div>
            </div>

            <dl className="mt-4 space-y-2.5 text-sm">
              <RailRow label="Store" value={STORE_FULL[detail.platform] ?? detail.platform} />
              <RailRow
                label="Order"
                value={
                  detail.ebayOrderNumber ? (
                    <span className="inline-flex items-center gap-1">
                      <a
                        href={`https://www.ebay.com/sh/ord/details?orderid=${encodeURIComponent(detail.ebayOrderNumber)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-brand hover:underline"
                      >
                        {detail.ebayOrderNumber}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                      <CopyButton value={detail.ebayOrderNumber} label="order ID" />
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
              <RailRow
                label="Return ID"
                value={
                  <span className="inline-flex items-center gap-1">
                    <a
                      href={ebayReturnUrl(detail.returnId)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-brand hover:underline"
                    >
                      {detail.returnId}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    <CopyButton value={detail.returnId} label="return ID" />
                  </span>
                }
              />
              {detail.caseId ? (
                <RailRow
                  label="eBay case ID"
                  value={
                    <span className="inline-flex items-center gap-1">
                      <a
                        href={ebayReturnUrl(detail.returnId)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-brand hover:underline"
                      >
                        {detail.caseId}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                      <CopyButton value={detail.caseId} label="case ID" />
                    </span>
                  }
                />
              ) : null}
              <RailRow
                label="Request amount"
                value={fmtMoney(detail.sellerRefund.value, detail.sellerRefund.currency)}
              />
              <RailRow label="Reason" value={humanizeReason(detail.reason)} />
              <RailRow
                label="Buyer"
                value={
                  detail.buyerUserId ? (
                    <span className="inline-flex items-center gap-1">
                      <Link
                        href={`/help-desk?q=${encodeURIComponent(detail.buyerUserId)}`}
                        className="inline-flex items-center gap-1 text-brand hover:underline"
                        title="Search this buyer in Help Desk"
                      >
                        {detail.buyerUserId}
                        <MessageSquare className="h-3 w-3" />
                      </Link>
                      <CopyButton value={detail.buyerUserId} label="buyer username" />
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
              <RailRow label="Opened" value={fmtDate(detail.openedAt)} />
              {detail.sellerResponseDueAt && !detail.isClosed ? (
                <RailRow
                  label="Respond by"
                  value={
                    <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-300">
                      <Clock className="h-3 w-3" />
                      {fmtDate(detail.sellerResponseDueAt)}
                    </span>
                  }
                />
              ) : null}
              {detail.closedAt ? (
                <RailRow label="Closed" value={fmtDate(detail.closedAt)} />
              ) : null}
            </dl>

            <a
              href={ebayReturnUrl(detail.returnId)}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-xs font-medium text-brand hover:bg-brand/20 cursor-pointer"
            >
              <ExternalLink className="h-3.5 w-3.5" /> View return on eBay
            </a>

            {detail.ticketId ? (
              <Link
                href={`/help-desk?ticket=${encodeURIComponent(detail.ticketId)}`}
                className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-hairline bg-surface px-3 py-2 text-xs font-medium text-foreground hover:bg-surface-2 cursor-pointer"
              >
                <MessageSquare className="h-3.5 w-3.5" /> View linked ticket
              </Link>
            ) : null}
          </div>

          {/* Refund summary card */}
          {detail.sellerRefund.value != null || showRefundButton ? (
            <div className="rounded-xl border border-hairline bg-card p-4">
              {detail.sellerRefund.value != null ? (
                <>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {detail.sellerRefund.isActual ? "Refunded" : "Estimated refund"}
                  </p>
                  <p className="mt-1 text-2xl font-semibold text-foreground">
                    {fmtMoney(detail.sellerRefund.value, detail.sellerRefund.currency)}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {detail.sellerRefund.isActual
                      ? "Amount eBay reports as actually refunded."
                      : "eBay estimate of the refund if this return completes."}
                  </p>
                </>
              ) : null}

              {showRefundButton ? (
                <>
                  <button
                    type="button"
                    disabled={!refundState.enabled}
                    onClick={() => refundState.enabled && setActiveAction("ISSUE_REFUND")}
                    title={refundState.reason ?? "Refund the buyer."}
                    className={
                      "mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors " +
                      (refundState.enabled
                        ? "bg-emerald-600 text-white hover:bg-emerald-700 cursor-pointer"
                        : "bg-emerald-600/30 text-white/70 cursor-not-allowed")
                    }
                  >
                    <DollarSign className="h-4 w-4" /> Send refund
                  </button>
                  {!refundState.enabled && refundState.reason ? (
                    <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
                      {refundState.reason}
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>

      {/* Action modal */}
      {activeAction ? (
        <ActionModal
          returnId={detail.returnId}
          action={activeAction}
          detail={detail}
          onClose={() => setActiveAction(null)}
          onCommitted={() => {
            setActiveAction(null);
            void load(true);
          }}
        />
      ) : null}
    </div>
  );
}

// ── Progress line ────────────────────────────────────────────────────────────

function ProgressLine({
  lifecycle,
  isClosed,
}: {
  lifecycle: ReturnLifecycle;
  isClosed: boolean;
}) {
  // Map lifecycle → which of the 3 eBay-style stages are complete.
  const order: ReturnLifecycle[] = [
    "requested",
    "in_transit",
    "delivered",
    "refund_pending",
    "closed",
  ];
  const idx = order.indexOf(lifecycle);
  const stages = [
    { key: "started", label: "Started", done: idx >= 0 },
    { key: "shipped", label: "Shipped", done: idx >= 1 },
    {
      key: "refund",
      label: isClosed ? "Closed" : "Refund",
      done: idx >= 3 || isClosed,
    },
  ];
  return (
    <div className="rounded-xl border border-hairline bg-card px-6 py-5">
      <div className="flex items-center">
        {stages.map((s, i) => (
          <div key={s.key} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center">
              <div
                className={
                  "flex h-7 w-7 items-center justify-center rounded-full border-2 " +
                  (s.done
                    ? "border-brand bg-brand text-white"
                    : "border-hairline bg-surface text-muted-foreground")
                }
              >
                {s.done ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
                )}
              </div>
              <span
                className={
                  "mt-1.5 text-xs " +
                  (s.done ? "font-medium text-foreground" : "text-muted-foreground")
                }
              >
                {s.label}
              </span>
            </div>
            {i < stages.length - 1 ? (
              <div
                className={
                  "mx-2 h-0.5 flex-1 " +
                  (stages[i + 1].done ? "bg-brand" : "bg-hairline")
                }
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────────

function Timeline({ detail }: { detail: ReturnDetail }) {
  type Item = {
    when: string | null;
    title: string;
    sub?: string | null;
    tone: "neutral" | "good" | "bad" | "info";
  };
  const items: Item[] = [];

  items.push({
    when: detail.openedAt,
    title: "Return requested by buyer",
    sub: humanizeReason(detail.reason),
    tone: "info",
  });

  for (const t of detail.trackingEvents) {
    items.push({
      when: t.eventDate,
      title: `Tracking: ${t.status ?? "update"}`,
      sub: [t.carrier, t.trackingNumber, t.location, t.description]
        .filter(Boolean)
        .join(" · "),
      tone: "neutral",
    });
  }

  for (const a of detail.actionAttempts) {
    const good = a.status === "COMMITTED";
    const bad = a.status === "FAILED" || a.status === "BLOCKED";
    items.push({
      when: a.committedAt ?? a.createdAt,
      title: `${labelizeAction(a.actionType)} — ${a.status.toLowerCase()}`,
      sub:
        a.errorMessage ??
        a.blockReason ??
        (a.ebayRequestId ? `eBay request ${a.ebayRequestId}` : null),
      tone: good ? "good" : bad ? "bad" : "neutral",
    });
  }

  if (detail.closedAt) {
    items.push({
      when: detail.closedAt,
      title: "Return closed",
      tone: "neutral",
    });
  }

  items.sort((x, y) => {
    const xt = x.when ? new Date(x.when).getTime() : 0;
    const yt = y.when ? new Date(y.when).getTime() : 0;
    return yt - xt;
  });

  return (
    <section className="rounded-xl border border-hairline bg-card p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Timeline
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No events yet.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((it, i) => (
            <li key={i} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  className={
                    "mt-1 h-2.5 w-2.5 shrink-0 rounded-full " +
                    (it.tone === "good"
                      ? "bg-emerald-500"
                      : it.tone === "bad"
                        ? "bg-red-500"
                        : it.tone === "info"
                          ? "bg-sky-500"
                          : "bg-muted-foreground/40")
                  }
                />
                {i < items.length - 1 ? (
                  <span className="mt-1 w-px flex-1 bg-hairline" />
                ) : null}
              </div>
              <div className="min-w-0 pb-1">
                <p className="text-sm text-foreground">{it.title}</p>
                {it.sub ? (
                  <p className="text-xs text-muted-foreground">{it.sub}</p>
                ) : null}
                <p className="text-[11px] text-muted-foreground/70">
                  {fmtDateTime(it.when)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function labelizeAction(actionType: string): string {
  return actionType
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

// ── Small presentational bits ────────────────────────────────────────────────

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-foreground">{value}</dd>
    </div>
  );
}

/** Small inline copy-to-clipboard button used next to IDs in the rail. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable — no-op */
        }
      }}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-surface-2 hover:text-foreground cursor-pointer"
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-500" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

function RailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-foreground">{value}</dd>
    </div>
  );
}

function DebugBlock({ title, data }: { title: string; data: unknown }) {
  return (
    <details className="rounded-lg border border-hairline bg-surface">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-foreground">
        {title}
      </summary>
      <pre className="max-h-72 overflow-auto px-3 pb-3 text-[10px] leading-relaxed text-muted-foreground">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

// ── Action modal (preview → typed confirm → commit) ──────────────────────────

function ActionModal({
  returnId,
  action,
  detail,
  onClose,
  onCommitted,
}: {
  returnId: string;
  action: ActionKey;
  detail: ReturnDetail;
  onClose: () => void;
  onCommitted: () => void;
}) {
  const meta = ACTION_META[action];
  const currency = detail.sellerRefund.currency ?? "USD";

  // params
  const [amount, setAmount] = useState("");
  const [carrier, setCarrier] = useState("USPS");
  const [tracking, setTracking] = useState("");
  const [comments, setComments] = useState("");
  const [deductionType, setDeductionType] = useState<"none" | "percent" | "amount">(
    "none",
  );
  const [deductionValue, setDeductionValue] = useState("");
  const [deductionReason, setDeductionReason] = useState("");

  const [preview, setPreview] = useState<PreviewSummary | null>(null);
  const [idemKey, setIdemKey] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function runPreview() {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { action };
      if (action === "OFFER_PARTIAL_REFUND") {
        const n = Number(amount);
        if (!Number.isFinite(n) || n <= 0) throw new Error("Enter a valid amount.");
        body.amount = n;
        if (comments) body.comments = comments;
      }
      if (action === "CONFIRM_LABEL_SENT" || action === "UPLOAD_LABEL") {
        body.carrierEnum = carrier;
        if (!tracking.trim()) throw new Error("Enter the tracking number.");
        body.trackingNumber = tracking.trim();
        if (comments) body.comments = comments;
      }
      if (action === "ISSUE_REFUND" && deductionType !== "none") {
        const n = Number(deductionValue);
        if (!Number.isFinite(n) || n < 0) throw new Error("Enter a valid deduction.");
        body.deductionType = deductionType;
        body.deductionValue = n;
        if (deductionReason) body.deductionReason = deductionReason;
      }
      const res = await fetch(
        `/api/helpdesk/returns/${encodeURIComponent(returnId)}/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = (await res.json().catch(() => null)) as {
        data?: { idempotencyKey?: string; summary?: PreviewSummary };
        error?: string;
      } | null;
      if (!res.ok || !json?.data?.summary) {
        throw new Error(json?.error ?? `Preview failed (${res.status})`);
      }
      setPreview(json.data.summary);
      setIdemKey(json.data.idempotencyKey ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Preview failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runCommit() {
    if (!idemKey) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/helpdesk/returns/${encodeURIComponent(returnId)}/commit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: idemKey,
            typedConfirmation: preview?.requiresTypedConfirmation ? typed : undefined,
          }),
        },
      );
      const json = (await res.json().catch(() => null)) as {
        data?: { status?: string };
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(json?.error ?? `Commit failed (${res.status})`);
      }
      onCommitted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Commit failed.");
      setBusy(false);
    }
  }

  const confirmWord = "CONFIRM";
  const canCommit =
    !!preview &&
    !!idemKey &&
    (!preview.requiresTypedConfirmation ||
      typed.trim().toUpperCase() === confirmWord);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-hairline bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
          <h3 className="text-sm font-semibold text-foreground">{meta.label}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <XCircle className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {!preview ? (
            <>
              <p className="text-xs text-muted-foreground">{meta.desc}</p>

              {action === "OFFER_PARTIAL_REFUND" ? (
                <Labeled label={`Partial refund amount (${currency})`}>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="h-9 w-full rounded-md border border-hairline bg-surface px-2 text-sm text-foreground"
                  />
                </Labeled>
              ) : null}

              {action === "CONFIRM_LABEL_SENT" || action === "UPLOAD_LABEL" ? (
                <>
                  <Labeled label="Carrier">
                    <select
                      value={carrier}
                      onChange={(e) => setCarrier(e.target.value)}
                      className="h-9 w-full rounded-md border border-hairline bg-surface px-2 text-sm text-foreground cursor-pointer"
                    >
                      {CARRIERS.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </Labeled>
                  <Labeled label="Tracking number">
                    <input
                      value={tracking}
                      onChange={(e) => setTracking(e.target.value)}
                      className="h-9 w-full rounded-md border border-hairline bg-surface px-2 text-sm text-foreground"
                    />
                  </Labeled>
                </>
              ) : null}

              {action === "ISSUE_REFUND" ? (
                <>
                  <Labeled label="Deduction">
                    <select
                      value={deductionType}
                      onChange={(e) =>
                        setDeductionType(
                          e.target.value as "none" | "percent" | "amount",
                        )
                      }
                      className="h-9 w-full rounded-md border border-hairline bg-surface px-2 text-sm text-foreground cursor-pointer"
                    >
                      <option value="none">No deduction (full refund)</option>
                      <option value="percent">Percent (max 50%)</option>
                      <option value="amount">Fixed amount</option>
                    </select>
                  </Labeled>
                  {deductionType !== "none" ? (
                    <>
                      <Labeled
                        label={
                          deductionType === "percent"
                            ? "Deduction percent (0–50)"
                            : `Deduction amount (${currency})`
                        }
                      >
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={deductionValue}
                          onChange={(e) => setDeductionValue(e.target.value)}
                          className="h-9 w-full rounded-md border border-hairline bg-surface px-2 text-sm text-foreground"
                        />
                      </Labeled>
                      <Labeled label="Deduction reason (optional)">
                        <input
                          value={deductionReason}
                          onChange={(e) => setDeductionReason(e.target.value)}
                          className="h-9 w-full rounded-md border border-hairline bg-surface px-2 text-sm text-foreground"
                        />
                      </Labeled>
                    </>
                  ) : null}
                </>
              ) : null}

              {action === "OFFER_PARTIAL_REFUND" ||
              action === "CONFIRM_LABEL_SENT" ||
              action === "UPLOAD_LABEL" ? (
                <Labeled label="Comments (optional)">
                  <textarea
                    value={comments}
                    onChange={(e) => setComments(e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-hairline bg-surface px-2 py-1.5 text-sm text-foreground"
                  />
                </Labeled>
              ) : null}

              {err ? (
                <p className="text-xs text-red-600 dark:text-red-300">{err}</p>
              ) : null}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-foreground hover:bg-surface-2 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={runPreview}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand/90 disabled:opacity-50 cursor-pointer"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Preview
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-lg border border-hairline bg-surface p-3">
                <p className="text-sm font-medium text-foreground">
                  {preview.headline}
                </p>
                <ul className="mt-2 space-y-1">
                  {preview.lines.map((l, i) => (
                    <li key={i} className="text-xs text-muted-foreground">
                      • {l}
                    </li>
                  ))}
                </ul>
                {preview.finalRefundAmount != null ? (
                  <p className="mt-2 text-sm font-semibold text-foreground">
                    Refund: {fmtMoney(preview.finalRefundAmount, preview.currency)}
                  </p>
                ) : null}
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This sends a single live action to eBay and cannot be undone.
              </div>

              {preview.requiresTypedConfirmation ? (
                <Labeled label={`Type ${confirmWord} to proceed`}>
                  <input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={confirmWord}
                    className="h-9 w-full rounded-md border border-hairline bg-surface px-2 text-sm text-foreground"
                  />
                </Labeled>
              ) : null}

              {err ? (
                <p className="text-xs text-red-600 dark:text-red-300">{err}</p>
              ) : null}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setPreview(null);
                    setIdemKey(null);
                    setTyped("");
                    setErr(null);
                  }}
                  className="rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-foreground hover:bg-surface-2 cursor-pointer"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={runCommit}
                  disabled={busy || !canCommit}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 cursor-pointer"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Confirm &amp; send to eBay
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Labeled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
