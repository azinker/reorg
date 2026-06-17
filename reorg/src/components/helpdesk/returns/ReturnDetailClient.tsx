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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  MessagesSquare,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Upload,
  Download,
  MapPin,
  X,
  PackagePlus,
} from "lucide-react";
import {
  StoreBadge,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  humanizeReason,
  reasonDefectAssociation,
  STORE_FULL,
  type ReturnLifecycle,
} from "./returns-ui";

type ActionKey =
  | "APPROVE_RETURN"
  | "DECLINE_RETURN"
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

interface ActionChoice {
  actionKey: ActionKey;
  label: string;
  description?: string;
  kind: "confirm" | "refund_full" | "refund_partial" | "label_upload" | "label_ebay";
  destructive?: boolean;
}

interface ActionGroup {
  id: string;
  label: string;
  description?: string;
  kind: "action" | "track";
  choices: ActionChoice[];
}

type StatusTone = "attention" | "progress" | "shipped" | "delivered" | "closed";
interface StatusDescriptor {
  label: string;
  tone: StatusTone;
}

interface ReturnTrackingInfo {
  trackingNumber: string | null;
  carrier: string | null;
  carrierUsed: string | null;
  deliveryStatus: string | null;
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
  ebayFileId: string | null;
  fileName: string | null;
  filePurpose: string | null;
  contentType: string | null;
  submitter: string | null;
  url: string | null;
  fullUrl: string | null;
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
  statusDescriptor: StatusDescriptor;
  returnTracking: ReturnTrackingInfo;
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
  actionModel: ActionGroup[];
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

// eBay's exact deduction reasons on the "Provide a refund" screen.
const DEDUCTION_REASONS = [
  "Item was opened",
  "Item was used",
  "Item was damaged",
  "Item was missing parts",
];

const MAX_DEDUCTION_PCT = 50;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Actions the v1 write flow can actually execute (subset of ActionKey).
// PROVIDE_EBAY_LABEL is now wired: it asks eBay to generate a prepaid return
// label for the buyer (eBay charges the seller). It runs through the same
// preview → typed-confirm → commit + safety-gate chain as every other write.
const EXECUTABLE: ActionKey[] = [
  "APPROVE_RETURN",
  "OFFER_PARTIAL_REFUND",
  "UPLOAD_LABEL",
  "PROVIDE_EBAY_LABEL",
  "CONFIRM_LABEL_SENT",
  "MARK_AS_RECEIVED",
  "ISSUE_REFUND",
];

const ACTION_META: Record<
  ActionKey,
  { label: string; desc: string; icon: typeof CheckCircle2 }
> = {
  APPROVE_RETURN: {
    label: "Accept the return",
    desc: "Accept the return, then provide a label for the buyer.",
    icon: CheckCircle2,
  },
  DECLINE_RETURN: {
    label: "Decline the return",
    desc: "Close this return request; the buyer keeps the item.",
    icon: XCircle,
  },
  OFFER_PARTIAL_REFUND: {
    label: "Offer a partial refund",
    desc: "Offer the buyer a partial refund to keep the item.",
    icon: DollarSign,
  },
  UPLOAD_LABEL: {
    label: "Upload a label",
    desc: "Upload a PDF/image return label file + tracking from your own carrier.",
    icon: Upload,
  },
  CONFIRM_LABEL_SENT: {
    label: "Confirm you sent a label",
    desc: "Confirm you already provided a return label to the buyer.",
    icon: Truck,
  },
  PROVIDE_EBAY_LABEL: {
    label: "Provide an eBay label",
    desc: "eBay generates a prepaid return label for the buyer and charges you for it.",
    icon: Truck,
  },
  MARK_AS_RECEIVED: {
    label: "Mark as received",
    desc: "Confirm the returned item arrived back to you.",
    icon: PackageOpen,
  },
  ISSUE_REFUND: {
    label: "Send a full refund",
    desc: "Refund the buyer in full (optionally with a deduction up to 50%).",
    icon: DollarSign,
  },
};

const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  attention: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  progress: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
  shipped: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-300",
  delivered: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  closed: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
};

/** Deep link to the eBay return case (opens in a new tab). */
function ebayReturnUrl(returnId: string): string {
  return `https://www.ebay.com/rtn/Return/ReturnsDetail?returnId=${encodeURIComponent(returnId)}`;
}

/** Deep link to the live eBay listing for an item id (opens in a new tab). */
function ebayListingUrl(itemId: string): string {
  return `https://www.ebay.com/itm/${encodeURIComponent(itemId)}`;
}

/** True for image files we can render inline (jpeg/png/gif/bmp or a data: image URL). */
function isImageFile(f: ReturnFile): boolean {
  if (f.contentType && f.contentType.startsWith("image/")) return true;
  if (f.url && f.url.startsWith("data:image/")) return true;
  return false;
}

/** A photo the buyer attached to the return (proof / item condition). */
function isBuyerPhoto(f: ReturnFile): boolean {
  const sub = (f.submitter ?? "").toUpperCase();
  return sub === "BUYER" && isImageFile(f) && !!f.url;
}

/** Reason value with the seller-defect association badge (Return details). */
function ReasonValue({
  reason,
  reasonType,
}: {
  reason: string | null;
  reasonType: string | null;
}) {
  const defect = reasonDefectAssociation(reason, reasonType);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span>{humanizeReason(reason)}</span>
      {defect === null ? null : (
        <span
          className={
            "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold " +
            (defect
              ? "bg-red-500/15 text-red-600 dark:text-red-300"
              : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300")
          }
        >
          {defect ? "Defect Associated" : "No Defect Associated"}
        </span>
      )}
    </span>
  );
}

/** Buyer-uploaded photos rendered as clickable thumbnails (expand to lightbox). */
function BuyerPhotos({ files }: { files: ReturnFile[] }) {
  const photos = files.filter(isBuyerPhoto);
  const [active, setActive] = useState<string | null>(null);
  if (photos.length === 0) return null;
  return (
    <>
      <div className="mt-3">
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Buyer photos ({photos.length})
        </p>
        <div className="flex flex-wrap gap-3">
          {photos.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setActive(p.fullUrl ?? p.url)}
              className="h-32 w-32 overflow-hidden rounded-lg border border-hairline bg-surface transition-transform hover:scale-[1.03] hover:border-brand/50 cursor-pointer sm:h-36 sm:w-36"
              title="Click to expand"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url ?? ""} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      </div>
      {active ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setActive(null)}
        >
          <button
            type="button"
            onClick={() => setActive(null)}
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 cursor-pointer"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={active}
            alt=""
            className="h-auto max-h-[88vh] w-auto max-w-[92vw] rounded-lg bg-white object-contain shadow-2xl"
            style={{ minHeight: "min(70vh, 700px)" }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * eBay-parity "Provide a return shipping label" screen, shown after the seller
 * clicks "Accept the return". Mirrors Seller Hub: three label options plus a
 * "Send refund" escape hatch. Choosing any of these accepts the return and
 * performs the action in one confirmed step (the server accepts first).
 */
function AcceptLabelPanel({
  onChoose,
  onBack,
}: {
  onChoose: (k: ActionKey) => void;
  onBack: () => void;
}) {
  const options: {
    key: ActionKey;
    title: string;
    desc: string;
    Icon: typeof Truck;
    destructive?: boolean;
  }[] = [
    {
      key: "PROVIDE_EBAY_LABEL",
      title: "Provide an eBay label",
      desc: "Purchase an eBay return label based on shipping prices negotiated by eBay. eBay charges you, the seller, for the label.",
      Icon: Truck,
      destructive: true,
    },
    {
      key: "UPLOAD_LABEL",
      title: "Upload a label",
      desc: "Upload a return label and tracking details from your preferred carrier.",
      Icon: Upload,
    },
    {
      key: "CONFIRM_LABEL_SENT",
      title: "Confirm you sent a label",
      desc: "Confirm you have already provided a return label to the buyer.",
      Icon: CheckCircle2,
    },
  ];
  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <ArrowLeft className="h-3 w-3" /> Back
      </button>
      <p className="text-sm font-semibold text-foreground">
        Provide a return shipping label
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Purchase a return label from your preferred carrier and then share it
        with the buyer. If you prefer to close this return request instead and
        let the buyer keep the item, you can send a refund.
      </p>
      <div className="mt-3 space-y-2">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onChoose(o.key)}
            className={
              "flex w-full items-start gap-2.5 rounded-lg border p-3 text-left transition-colors " +
              (o.destructive
                ? "border-red-500/30 bg-red-500/5 hover:bg-red-500/10 cursor-pointer"
                : "border-brand/30 bg-brand/5 hover:bg-brand/10 cursor-pointer")
            }
          >
            <o.Icon
              className={
                "mt-0.5 h-4 w-4 shrink-0 " +
                (o.destructive ? "text-red-600 dark:text-red-300" : "text-brand")
              }
            />
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium text-foreground">{o.title}</span>
              <p className="mt-0.5 text-xs text-muted-foreground">{o.desc}</p>
            </div>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChoose("ISSUE_REFUND")}
        className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300 cursor-pointer"
      >
        <DollarSign className="h-4 w-4" /> Send refund instead
      </button>
    </div>
  );
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
  // Message-correspondence popup state
  const [showCorrespondence, setShowCorrespondence] = useState(false);
  // Track-package popup state
  const [showTracking, setShowTracking] = useState(false);
  // eBay "Accept the return" → "Provide a return shipping label" sub-flow.
  const [acceptFlow, setAcceptFlow] = useState(false);

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
      return { enabled: false, reason: "Blocked by reorG policy." };
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

  // The action area is driven entirely by the server's eBay-parity action model
  // (detail.actionModel) so the options shown match Seller Hub 1:1 for the
  // return's current lifecycle. We split out the "track" group (read-only Track
  // Package). The refund itself is always launched from the Action needed panel
  // (eBay-parity flow) — the refund card on the right is informational only.
  const actionGroups = detail.actionModel.filter((g) => g.id !== "track");
  const trackGroup = detail.actionModel.find((g) => g.id === "track");
  const acceptGroup = detail.actionModel.find((g) => g.id === "accept");
  const refundAvailable =
    !detail.isClosed && !!availMap.get("ISSUE_REFUND")?.availableOnEbay;
  // The accept sub-flow only makes sense while the return is still awaiting a
  // seller verdict. Once accepted (or closed) the accept group disappears, so
  // exit the flow automatically.
  const inAcceptFlow = acceptFlow && !!acceptGroup;

  // Lifecycle-aware deadline messaging (approve-by vs. in-transit vs.
  // refund-by). Computed once and reused in the detail card + right rail.
  const deadline = deadlineNotice(detail);

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

          {/* Action area — driven by the server eBay-parity action model */}
          <section className="rounded-xl border border-hairline bg-card p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-foreground">
                {detail.isClosed
                  ? "This return is closed"
                  : detail.sellerActionDue
                    ? "Action needed"
                    : "No action needed right now"}
              </h2>
              <span
                className={
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold " +
                  STATUS_TONE_CLASS[detail.statusDescriptor.tone]
                }
              >
                {detail.statusDescriptor.label}
              </span>
            </div>

            {detail.isClosed ? (
              <p className="text-sm text-muted-foreground">
                No further seller actions are available. See the timeline below
                for the full history.
              </p>
            ) : actionGroups.length === 0 && !trackGroup ? (
              <p className="text-sm text-muted-foreground">
                eBay is not offering any seller actions right now. This usually
                means the ball is in the buyer&apos;s court (e.g. awaiting the
                buyer to ship). Refresh to re-check.
              </p>
            ) : inAcceptFlow ? (
              <AcceptLabelPanel
                onChoose={(k) => setActiveAction(k)}
                onBack={() => setAcceptFlow(false)}
              />
            ) : (
              <div className="space-y-3">
                {actionGroups.map((g) => (
                  <div
                    key={g.id}
                    className="rounded-lg border border-hairline bg-surface/40 p-3"
                  >
                    <div className="mb-2">
                      <p className="text-sm font-semibold text-foreground">{g.label}</p>
                      {g.description ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {g.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {g.choices.map((c) => {
                        const meta = ACTION_META[c.actionKey];
                        const Icon = meta?.icon ?? CheckCircle2;
                        const st = actionState(c.actionKey);
                        return (
                          <button
                            key={c.actionKey}
                            type="button"
                            disabled={!st.enabled}
                            onClick={() => {
                              if (!st.enabled) return;
                              // eBay parity: "Accept the return" navigates to the
                              // "Provide a return shipping label" screen rather
                              // than firing a standalone write.
                              if (c.actionKey === "APPROVE_RETURN") setAcceptFlow(true);
                              else setActiveAction(c.actionKey);
                            }}
                            title={st.reason ?? c.description ?? c.label}
                            className={
                              "flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors " +
                              (!st.enabled
                                ? "border-hairline/60 bg-surface/40 opacity-70 cursor-not-allowed"
                                : c.destructive
                                  ? "border-red-500/30 bg-red-500/5 hover:bg-red-500/10 cursor-pointer"
                                  : "border-brand/30 bg-brand/5 hover:bg-brand/10 cursor-pointer")
                            }
                          >
                            <Icon
                              className={
                                "mt-0.5 h-4 w-4 shrink-0 " +
                                (!st.enabled
                                  ? "text-muted-foreground"
                                  : c.destructive
                                    ? "text-red-600 dark:text-red-300"
                                    : "text-brand")
                              }
                            />
                            <div className="min-w-0 flex-1">
                              <span className="text-sm font-medium text-foreground">
                                {c.label}
                              </span>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {st.enabled ? c.description ?? meta?.desc : st.reason}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {trackGroup ? (
                  <button
                    type="button"
                    onClick={() => setShowTracking(true)}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-hairline bg-surface/40 p-3 text-left hover:bg-surface-2 cursor-pointer"
                  >
                    <Truck className="h-4 w-4 shrink-0 text-brand" />
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium text-foreground">
                        Track package
                      </span>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        See the buyer&apos;s return shipment tracking events.
                      </p>
                    </div>
                  </button>
                ) : null}
              </div>
            )}
          </section>

          {/* Return details */}
          <section className="rounded-xl border border-hairline bg-card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Return details
            </h2>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <Detail
                label="Reason"
                value={<ReasonValue reason={detail.reason} reasonType={detail.reasonType} />}
              />
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
              {deadline ? (
                <Detail
                  label={deadline.label}
                  value={
                    deadline.date ? (
                      <span
                        className={
                          "inline-flex items-center gap-1 font-medium " +
                          deadline.valueClass
                        }
                      >
                        <Clock className="h-3.5 w-3.5" />
                        {fmtDateTime(deadline.date)}
                      </span>
                    ) : (
                      <span className={"font-medium " + deadline.valueClass}>
                        {detail.lifecycle === "in_transit"
                          ? "In transit back to you"
                          : "Issued"}
                      </span>
                    )
                  }
                />
              ) : null}
            </dl>
            {deadline ? (
              <p
                className={
                  "mt-3 flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] " +
                  (deadline.noteTone === "warn"
                    ? "border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                    : "border-sky-500/25 bg-sky-500/5 text-sky-700 dark:text-sky-300")
                }
              >
                {deadline.noteTone === "warn" ? (
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                ) : (
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
                )}
                {deadline.note}
              </p>
            ) : null}
            {detail.buyerComments || detail.files.some((f) => isBuyerPhoto(f)) ? (
              <div className="mt-4 rounded-lg border border-hairline bg-surface p-3">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Buyer comments
                </p>
                {detail.buyerComments ? (
                  <p className="whitespace-pre-wrap text-sm text-foreground">
                    {detail.buyerComments}
                  </p>
                ) : null}
                <BuyerPhotos files={detail.files} />
              </div>
            ) : null}
          </section>

          {/* Return tracking */}
          {detail.returnTracking.trackingNumber || detail.trackingEvents.length > 0 ? (
            <ReturnTrackingBox detail={detail} />
          ) : null}

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
                {detail.itemTitle && detail.ebayItemId ? (
                  <a
                    href={ebayListingUrl(detail.ebayItemId)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 line-clamp-3 inline-flex text-sm font-medium text-foreground hover:text-brand hover:underline"
                    title="Open the listing on eBay"
                  >
                    {detail.itemTitle}
                  </a>
                ) : (
                  <p className="mt-1 line-clamp-3 text-sm font-medium text-foreground">
                    {detail.itemTitle ?? "(no title)"}
                  </p>
                )}
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
                      <a
                        href={`/help-desk?q=${encodeURIComponent(detail.buyerUserId)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-brand hover:underline"
                        title="Search this buyer in Help Desk (new tab)"
                      >
                        {detail.buyerUserId}
                        <MessageSquare className="h-3 w-3" />
                      </a>
                      <CopyButton value={detail.buyerUserId} label="buyer username" />
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
              <RailRow label="Opened" value={fmtDate(detail.openedAt)} />
              {deadline ? (
                <RailRow
                  label={deadline.label}
                  value={
                    deadline.date ? (
                      <span
                        className={
                          "inline-flex items-center gap-1 " + deadline.valueClass
                        }
                      >
                        <Clock className="h-3 w-3" />
                        {fmtDate(deadline.date)}
                      </span>
                    ) : (
                      <span className={deadline.valueClass}>
                        {detail.lifecycle === "in_transit"
                          ? "In transit"
                          : "Issued"}
                      </span>
                    )
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

          {/* Refund summary card — informational. The refund action lives in
              the Action needed panel (eBay-parity flow), so no button here. */}
          {detail.sellerRefund.value != null ? (
            <div className="rounded-xl border border-hairline bg-card p-4">
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

              {refundAvailable ? (
                <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                  <DollarSign className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span>
                    To refund, use{" "}
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">
                      Send a full refund
                    </span>{" "}
                    or{" "}
                    <span className="font-medium text-foreground">Offer a partial refund</span>{" "}
                    in the Action needed panel.
                  </span>
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Message correspondence — opens a popup with this buyer's threads. */}
          <button
            type="button"
            onClick={() => setShowCorrespondence(true)}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-hairline bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-surface-2 cursor-pointer"
          >
            <MessagesSquare className="h-4 w-4 text-brand" />
            View Message Correspondence
          </button>
        </aside>
      </div>

      {/* Correspondence popup */}
      {showCorrespondence ? (
        <CorrespondenceModal
          returnId={detail.returnId}
          buyerUserId={detail.buyerUserId}
          onClose={() => setShowCorrespondence(false)}
        />
      ) : null}

      {/* Track-package popup */}
      {showTracking ? (
        <TrackingModal detail={detail} onClose={() => setShowTracking(false)} />
      ) : null}

      {/* Action modal */}
      {activeAction ? (
        <ActionModal
          returnId={detail.returnId}
          action={activeAction}
          detail={detail}
          onClose={() => setActiveAction(null)}
          onCommitted={() => {
            setActiveAction(null);
            setAcceptFlow(false);
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
    extra?: React.ReactNode;
    tone: "neutral" | "good" | "bad" | "info";
  };
  const items: Item[] = [];

  const labelFile = findLabelFile(detail.files);

  items.push({
    when: detail.openedAt,
    title: "Return requested by buyer",
    sub: humanizeReason(detail.reason),
    tone: "info",
  });

  // Return-case milestones derived from tracking — NOT the granular per-scan
  // updates (those live in the Return Tracking frame). We surface only the
  // "buyer shipped" and "delivered back" milestones here.
  if (detail.trackingEvents.length > 0) {
    const byDateAsc = [...detail.trackingEvents].sort((a, b) => {
      const at = a.eventDate ? new Date(a.eventDate).getTime() : 0;
      const bt = b.eventDate ? new Date(b.eventDate).getTime() : 0;
      return at - bt;
    });
    const earliest = byDateAsc[0];
    items.push({
      when: earliest.eventDate,
      title: "Buyer shipped the item back",
      sub: [detail.returnTracking.carrier ?? "USPS", detail.returnTracking.trackingNumber]
        .filter(Boolean)
        .join(" · "),
      tone: "info",
    });
    const deliveredEvent = [...byDateAsc]
      .reverse()
      .find((e) => /deliver/i.test(`${e.status ?? ""} ${e.description ?? ""}`));
    if (deliveredEvent) {
      items.push({
        when: deliveredEvent.eventDate,
        title: "Item delivered back to you",
        tone: "good",
      });
    }
  }

  for (const a of detail.actionAttempts) {
    const good = a.status === "COMMITTED";
    const bad = a.status === "FAILED" || a.status === "BLOCKED";
    // For a committed label upload/provide, surface the return tracking number
    // and a link to re-download the uploaded label file.
    const isLabel = a.actionType === "UPLOAD_LABEL" || a.actionType === "PROVIDE_EBAY_LABEL";
    let extra: React.ReactNode = null;
    if (good && isLabel) {
      const tn = detail.returnTracking.trackingNumber;
      extra = (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {tn ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-foreground">
              <Truck className="h-3 w-3 text-brand" />
              {detail.returnTracking.carrier ?? "USPS"}:{" "}
              <span className="font-medium">{tn}</span>
            </span>
          ) : null}
          {labelFile ? (
            <a
              href={`/api/helpdesk/returns/${encodeURIComponent(detail.returnId)}/files/${encodeURIComponent(labelFile.id)}/download`}
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline"
            >
              <Download className="h-3 w-3" /> Download label
            </a>
          ) : null}
        </div>
      );
    }
    items.push({
      when: a.committedAt ?? a.createdAt,
      title: `${labelizeAction(a.actionType)} — ${a.status.toLowerCase()}`,
      sub:
        a.errorMessage ??
        a.blockReason ??
        (a.ebayRequestId ? `eBay request ${a.ebayRequestId}` : null),
      extra,
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
                {it.extra}
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

interface DeadlineNotice {
  /** Short label for the detail/rail row. */
  label: string;
  /** Date to render (ISO) — null when the notice is purely informational. */
  date: string | null;
  /** Tailwind text-color classes for the date value. */
  valueClass: string;
  /** Explanatory sentence shown under RETURN DETAILS. */
  note: string;
  /** Visual treatment of the note box. */
  noteTone: "warn" | "info";
}

/**
 * eBay-parity deadline messaging that changes with the return lifecycle.
 *
 *   - requested      → "Approve / respond by" + auto-escalate warning (seller
 *                       must accept/decline/refund before eBay steps in).
 *   - in_transit     → already approved; buyer is shipping the item back. No
 *                       seller deadline — purely informational.
 *   - delivered      → item is back with the seller; show the refund/respond-by
 *                       deadline (eBay can auto-refund if the seller stalls).
 *   - refund_pending → refund issued; eBay is finalizing. Informational.
 *   - closed / none  → no notice.
 */
function deadlineNotice(detail: ReturnDetail): DeadlineNotice | null {
  if (detail.isClosed) return null;
  const due = detail.sellerResponseDueAt;

  switch (detail.lifecycle) {
    case "requested":
      if (!due) return null;
      return {
        label: "Approve / respond by",
        date: due,
        valueClass: "text-amber-600 dark:text-amber-300",
        note:
          "If you don't respond by this date, eBay may auto-escalate — closing the case against the seller or providing the buyer a return label automatically.",
        noteTone: "warn",
      };
    case "in_transit":
      return {
        label: "Return approved",
        date: null,
        valueClass: "text-emerald-600 dark:text-emerald-300",
        note: detail.buyerResponseDueAt
          ? `You approved this return — the buyer is shipping the item back (they must ship by ${fmtDateTime(detail.buyerResponseDueAt)}). No action is needed until it's delivered to you.`
          : "You approved this return — the buyer is shipping the item back. No action is needed until it's delivered to you.",
        noteTone: "info",
      };
    case "delivered":
      return {
        label: due ? "Refund / respond by" : "Item delivered",
        date: due,
        valueClass: "text-amber-600 dark:text-amber-300",
        note: due
          ? "The item was delivered back to you. Issue the buyer's refund by this date, or eBay may automatically refund them on your behalf."
          : "The item was delivered back to you. Review it and issue the buyer's refund to close this return.",
        noteTone: "warn",
      };
    case "refund_pending":
      return {
        label: "Refund in progress",
        date: null,
        valueClass: "text-sky-600 dark:text-sky-300",
        note: "A refund has been issued — eBay is finalizing this return.",
        noteTone: "info",
      };
    default:
      return null;
  }
}

/** The seller-provided return label file (for re-download), if one exists. */
function findLabelFile(files: ReturnFile[]): ReturnFile | null {
  return (
    files.find(
      (f) =>
        (f.filePurpose ?? "").toUpperCase().includes("LABEL") ||
        f.source === "UPLOAD",
    ) ?? null
  );
}

// ── Return tracking box (under Return details) ────────────────────────────────

function ReturnTrackingBox({ detail }: { detail: ReturnDetail }) {
  const tn = detail.returnTracking.trackingNumber;
  const carrier = detail.returnTracking.carrier ?? "USPS";
  const events = detail.trackingEvents;
  const status = detail.returnTracking.deliveryStatus;
  return (
    <section className="rounded-xl border border-hairline bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Return tracking
        </h2>
      </div>

      {tn ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{carrier}:</span>
          <span className="font-medium text-foreground">{tn}</span>
          <CopyButton value={tn} label="tracking number" />
          {status && !["UNKNOWN", "UNCONFIRMED"].includes(status.toUpperCase()) ? (
            <span className="inline-flex items-center rounded-full bg-indigo-500/15 px-2 py-0.5 text-[11px] font-semibold text-indigo-600 dark:text-indigo-300">
              {humanizeTrackingStatus(status)}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Awaiting carrier scan
            </span>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No return tracking yet. It appears here once the buyer ships the item
          back (or you upload a label with tracking).
        </p>
      )}

      {events.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {events.map((e) => (
            <li key={e.id} className="flex gap-3">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm text-foreground">
                  {e.description ?? humanizeTrackingStatus(e.status) ?? "Update"}
                </p>
                {e.location ? (
                  <p className="text-xs text-muted-foreground">{e.location}</p>
                ) : null}
                <p className="text-[11px] text-muted-foreground/70">
                  {fmtDateTime(e.eventDate)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function humanizeTrackingStatus(s: string | null): string {
  if (!s) return "";
  return s
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

// ── Track package modal (mirrors eBay's Track Package popup) ───────────────────

function TrackingModal({
  detail,
  onClose,
}: {
  detail: ReturnDetail;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tn = detail.returnTracking.trackingNumber;
  const carrier = detail.returnTracking.carrier ?? "USPS";
  const events = detail.trackingEvents;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl border border-hairline bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Truck className="h-4 w-4 text-brand" /> Track package
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground cursor-pointer"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {tn ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{carrier}:</span>
              <span className="font-medium text-foreground">{tn}</span>
              <CopyButton value={tn} label="tracking number" />
            </div>
          ) : null}
          {events.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No tracking events yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {events.map((e, i) => (
                <li key={e.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span
                      className={
                        "mt-1 h-2.5 w-2.5 shrink-0 rounded-full " +
                        (i === 0 ? "bg-brand" : "bg-muted-foreground/40")
                      }
                    />
                    {i < events.length - 1 ? (
                      <span className="mt-1 w-px flex-1 bg-hairline" />
                    ) : null}
                  </div>
                  <div className="min-w-0 pb-1">
                    <p className="text-sm text-foreground">
                      {e.description ?? humanizeTrackingStatus(e.status) ?? "Update"}
                    </p>
                    {e.location ? (
                      <p className="text-xs text-muted-foreground">{e.location}</p>
                    ) : null}
                    <p className="text-[11px] text-muted-foreground/70">
                      {fmtDateTime(e.eventDate)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
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
  // UPLOAD_LABEL file attachment (base64, no data: prefix)
  const [labelFileName, setLabelFileName] = useState<string | null>(null);
  const [labelFileData, setLabelFileData] = useState<string | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  // ISSUE_REFUND (eBay "Provide a refund" parity): Amount/Percent toggle, live
  // deduction calc, required reason checkboxes + comment.
  const [refundMode, setRefundMode] = useState<"amount" | "percent">("amount");
  const [deductionValue, setDeductionValue] = useState("");
  const [deductionReasons, setDeductionReasons] = useState<string[]>([]);

  const [preview, setPreview] = useState<PreviewSummary | null>(null);
  const [idemKey, setIdemKey] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Post-commit "Your refund is being processed" screen + SkuVault add-back result.
  const [committed, setCommitted] = useState(false);
  const [skuBusy, setSkuBusy] = useState(false);
  const [skuMsg, setSkuMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Live refund math for the ISSUE_REFUND screen.
  const purchasePrice = detail.sellerRefund.value ?? 0;
  const dedRaw = Number(deductionValue);
  const dedNum = Number.isFinite(dedRaw) && dedRaw > 0 ? dedRaw : 0;
  const deductionAmount = round2(
    refundMode === "percent"
      ? (purchasePrice * Math.min(dedNum, MAX_DEDUCTION_PCT)) / 100
      : Math.min(dedNum, round2(purchasePrice * (MAX_DEDUCTION_PCT / 100))),
  );
  const totalRefund = round2(Math.max(purchasePrice - deductionAmount, 0));
  const hasDeduction = deductionAmount > 0;
  const refundReturnQty = detail.returnQuantity ?? 1;

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
      if (action === "UPLOAD_LABEL") {
        if (!labelFileData || !labelFileName) {
          throw new Error("Choose a label file (PDF or image) to upload.");
        }
        body.labelFileData = labelFileData;
        body.labelFileName = labelFileName;
      }
      if (action === "DECLINE_RETURN" && comments) {
        body.comments = comments;
      }
      if (action === "ISSUE_REFUND") {
        if (purchasePrice > 0) body.amount = round2(purchasePrice);
        if (hasDeduction) {
          if (deductionReasons.length === 0) {
            throw new Error("Select at least one deduction reason.");
          }
          if (!comments.trim()) {
            throw new Error("A deduction comment is required (Comments).");
          }
          body.deductionType = refundMode;
          body.deductionValue = dedNum;
          body.deductionReason = deductionReasons.join(", ");
          body.deductionComment = comments.trim();
        } else {
          body.deductionType = "none";
        }
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

  async function addBackToSkuvault() {
    if (!detail.sku) {
      setSkuMsg({ ok: false, text: "No SKU on this return — nothing was added to SkuVault." });
      return;
    }
    setSkuBusy(true);
    try {
      const res = await fetch("/api/skuvault/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: detail.sku, quantity: refundReturnQty, action: "add" }),
      });
      const json = (await res.json().catch(() => null)) as {
        data?: {
          sku?: string;
          quantityChanged?: number;
          quantityOnHand?: number;
          warehouse?: string | null;
        };
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(json?.error ?? `SkuVault update failed (${res.status})`);
      }
      const d = json?.data;
      const qty = d?.quantityChanged ?? refundReturnQty;
      const onHand = d?.quantityOnHand;
      const wh = d?.warehouse ? ` (${d.warehouse})` : "";
      setSkuMsg({
        ok: true,
        text: `Added ${qty} × ${d?.sku ?? detail.sku} back to SkuVault${
          onHand != null ? ` — now ${onHand} on hand${wh}` : ""
        }.`,
      });
    } catch (e) {
      setSkuMsg({
        ok: false,
        text: e instanceof Error ? e.message : "SkuVault update failed.",
      });
    } finally {
      setSkuBusy(false);
    }
  }

  async function runCommit(opts?: { addToSkuvault?: boolean }) {
    if (!idemKey) return;
    setBusy(true);
    setErr(null);
    try {
      // eBay's "Review and refund → Refund now" screen IS the explicit
      // confirmation for ISSUE_REFUND, so we satisfy the server's typed gate
      // automatically here; other irreversible actions still require typing.
      const typedConfirmation = preview?.requiresTypedConfirmation
        ? action === "ISSUE_REFUND"
          ? "CONFIRM"
          : typed
        : undefined;
      const res = await fetch(
        `/api/helpdesk/returns/${encodeURIComponent(returnId)}/commit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idempotencyKey: idemKey, typedConfirmation }),
        },
      );
      const json = (await res.json().catch(() => null)) as {
        data?: { status?: string };
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(json?.error ?? `Commit failed (${res.status})`);
      }

      if (action === "ISSUE_REFUND") {
        // Show "Your refund is being processed", optionally restock, then close.
        setCommitted(true);
        if (opts?.addToSkuvault) {
          await addBackToSkuvault();
        }
        setTimeout(() => onCommitted(), opts?.addToSkuvault ? 2600 : 1800);
        return;
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

              {action === "UPLOAD_LABEL" ? (
                <Labeled label="Label file (PDF or image)">
                  <div className="flex items-center gap-2">
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-brand/40 bg-brand/10 px-3 py-1.5 text-xs font-medium text-brand hover:bg-brand/20">
                      {fileBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Upload className="h-3.5 w-3.5" />
                      )}
                      Browse…
                      <input
                        type="file"
                        accept="application/pdf,image/png,image/jpeg,image/gif"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          if (file.size > 10 * 1024 * 1024) {
                            setErr("Label file must be 10 MB or smaller.");
                            return;
                          }
                          setErr(null);
                          setFileBusy(true);
                          const reader = new FileReader();
                          reader.onload = () => {
                            const result = String(reader.result ?? "");
                            const base64 = result.includes(",")
                              ? result.slice(result.indexOf(",") + 1)
                              : result;
                            setLabelFileData(base64);
                            setLabelFileName(file.name);
                            setFileBusy(false);
                          };
                          reader.onerror = () => {
                            setErr("Could not read that file.");
                            setFileBusy(false);
                          };
                          reader.readAsDataURL(file);
                        }}
                      />
                    </label>
                    {labelFileName ? (
                      <span className="inline-flex min-w-0 items-center gap-1 text-xs text-foreground">
                        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                        <span className="truncate">{labelFileName}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        No file chosen
                      </span>
                    )}
                  </div>
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
                <div className="space-y-3">
                  {/* Purchase price → deduction → total refund, like eBay's
                      "Provide a refund" page. */}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Purchase price</span>
                    <span className="font-medium text-foreground">
                      {fmtMoney(purchasePrice, currency)}
                    </span>
                  </div>

                  <div className="rounded-lg border border-hairline bg-surface p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Deduction
                      </span>
                      {hasDeduction ? (
                        <button
                          type="button"
                          onClick={() => {
                            setDeductionValue("");
                            setDeductionReasons([]);
                          }}
                          className="text-xs text-brand hover:underline cursor-pointer"
                        >
                          Clear
                        </button>
                      ) : (
                        <span className="text-sm font-medium text-foreground">
                          −{fmtMoney(deductionAmount, currency)}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-3">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={deductionValue}
                        onChange={(e) => setDeductionValue(e.target.value)}
                        placeholder="0"
                        className="h-9 w-24 rounded-md border border-hairline bg-card px-2 text-sm text-foreground"
                      />
                      <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
                        <input
                          type="radio"
                          name="refundMode"
                          checked={refundMode === "amount"}
                          onChange={() => setRefundMode("amount")}
                          className="cursor-pointer accent-brand"
                        />
                        Amount
                      </label>
                      <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
                        <input
                          type="radio"
                          name="refundMode"
                          checked={refundMode === "percent"}
                          onChange={() => setRefundMode("percent")}
                          className="cursor-pointer accent-brand"
                        />
                        Percent
                      </label>
                      {hasDeduction ? (
                        <span className="ml-auto text-sm font-medium text-foreground">
                          −{fmtMoney(deductionAmount, currency)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      Max deduction is {MAX_DEDUCTION_PCT}% of the purchase price.
                    </p>

                    {hasDeduction ? (
                      <div className="mt-3 border-t border-hairline pt-3">
                        <p className="mb-1.5 text-xs font-medium text-foreground">
                          Deduction reason{" "}
                          <span className="text-red-500">(Required)</span>
                        </p>
                        <div className="space-y-1.5">
                          {DEDUCTION_REASONS.map((r) => (
                            <label
                              key={r}
                              className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                            >
                              <input
                                type="checkbox"
                                checked={deductionReasons.includes(r)}
                                onChange={(e) =>
                                  setDeductionReasons((prev) =>
                                    e.target.checked
                                      ? [...prev, r]
                                      : prev.filter((x) => x !== r),
                                  )
                                }
                                className="cursor-pointer accent-brand"
                              />
                              {r}
                            </label>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Original shipping</span>
                    <span className="text-foreground">Free</span>
                  </div>
                  <div className="flex items-center justify-between border-t border-hairline pt-2 text-base">
                    <span className="font-semibold text-foreground">Total refund</span>
                    <span className="font-semibold text-foreground">
                      {fmtMoney(totalRefund, currency)}
                    </span>
                  </div>

                  <Labeled
                    label={
                      hasDeduction
                        ? "Comments (required with deductions)"
                        : "Comments (optional)"
                    }
                  >
                    <textarea
                      value={comments}
                      onChange={(e) => setComments(e.target.value)}
                      rows={2}
                      placeholder="Give the buyer a little more info."
                      className="w-full rounded-md border border-hairline bg-surface px-2 py-1.5 text-sm text-foreground"
                    />
                  </Labeled>
                </div>
              ) : null}

              {action === "OFFER_PARTIAL_REFUND" ||
              action === "CONFIRM_LABEL_SENT" ||
              action === "UPLOAD_LABEL" ||
              action === "DECLINE_RETURN" ? (
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
                  {action === "ISSUE_REFUND" ? "Next" : "Preview"}
                </button>
              </div>
            </>
          ) : committed ? (
            // eBay parity: "Your refund is being processed" → auto-closes.
            <div className="space-y-3 py-2 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
              <p className="text-base font-semibold text-foreground">
                Your refund is being processed
              </p>
              <p className="text-xs text-muted-foreground">
                eBay will email the buyer once it&apos;s complete. This return
                closes once the refund goes through.
              </p>
              <p className="text-sm font-semibold text-foreground">
                Total refund: {fmtMoney(totalRefund, currency)}
              </p>
              {skuBusy ? (
                <p className="inline-flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding back to
                  SkuVault…
                </p>
              ) : null}
              {skuMsg ? (
                <div
                  className={`mx-auto max-w-sm rounded-lg border px-3 py-2 text-xs ${
                    skuMsg.ok
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                  }`}
                >
                  {skuMsg.text}
                </div>
              ) : null}
            </div>
          ) : action === "ISSUE_REFUND" ? (
            // eBay "Review and refund" screen with dual Refund buttons.
            <>
              <p className="text-sm font-semibold text-foreground">
                Review and refund
              </p>
              <p className="text-xs text-muted-foreground">
                Review the details below and, if everything looks good, refund
                the buyer now.
              </p>

              <div className="rounded-lg border border-hairline bg-surface p-3">
                <div className="flex items-center justify-between text-base">
                  <span className="font-semibold text-foreground">Total refund</span>
                  <span className="font-semibold text-foreground">
                    {fmtMoney(preview.finalRefundAmount ?? totalRefund, preview.currency ?? currency)}
                  </span>
                </div>
                <div className="mt-2 space-y-1 border-t border-hairline pt-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Purchase price</span>
                    <span className="text-foreground">{fmtMoney(purchasePrice, currency)}</span>
                  </div>
                  {hasDeduction ? (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Deduction</span>
                        <span className="text-foreground">−{fmtMoney(deductionAmount, currency)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Reason</span>
                        <span className="max-w-[60%] truncate text-right text-foreground">
                          {deductionReasons.join(", ")}
                        </span>
                      </div>
                    </>
                  ) : null}
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Original shipping</span>
                    <span className="text-foreground">Free</span>
                  </div>
                </div>
                <p className="mt-2 border-t border-hairline pt-2 text-[11px] text-muted-foreground">
                  eBay credits your selling fees on this refund automatically.
                  The exact amount deducted from your payout appears on eBay.
                </p>
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This sends a single live refund to eBay and cannot be undone.
              </div>

              {err ? (
                <p className="text-xs text-red-600 dark:text-red-300">{err}</p>
              ) : null}

              <div className="space-y-2 pt-1">
                <button
                  type="button"
                  onClick={() => runCommit()}
                  disabled={busy}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 cursor-pointer"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Refund now
                </button>
                <button
                  type="button"
                  onClick={() => runCommit({ addToSkuvault: true })}
                  disabled={busy || !detail.sku}
                  title={
                    detail.sku
                      ? `Refund and add ${refundReturnQty} × ${detail.sku} back to SkuVault`
                      : "No SKU on this return — SkuVault add-back unavailable"
                  }
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-brand px-3 py-2.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-50 cursor-pointer"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />}
                  Refund + Add {refundReturnQty} back to SkuVault
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPreview(null);
                    setIdemKey(null);
                    setErr(null);
                  }}
                  disabled={busy}
                  className="w-full rounded-md border border-hairline bg-surface px-3 py-2 text-xs text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                >
                  Go back
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
                  onClick={() => runCommit()}
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

// ── Message correspondence popup ──────────────────────────────────────────────

interface CorrespondenceMessage {
  id: string;
  direction: string;
  source: string;
  fromName: string | null;
  bodyText: string;
  isHtml: boolean;
  sentAt: string;
}
interface CorrespondenceThread {
  ticketId: string;
  subject: string | null;
  ebayOrderNumber: string | null;
  messages: CorrespondenceMessage[];
}
interface CorrespondenceData {
  buyerUserId: string | null;
  threads: CorrespondenceThread[];
  ticketSearchHref: string | null;
}

function CorrespondenceModal({
  returnId,
  buyerUserId,
  onClose,
}: {
  returnId: string;
  buyerUserId: string | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<CorrespondenceData | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Jump straight to the most recent message once the thread renders, so the
  // user lands on the latest correspondence instead of the oldest message.
  useLayoutEffect(() => {
    if (loading || !data) return;
    const el = scrollRef.current;
    if (!el) return;
    const jump = () => {
      el.scrollTop = el.scrollHeight;
    };
    jump();
    // Run again after paint in case HTML message bodies reflow the height.
    const raf = requestAnimationFrame(jump);
    return () => cancelAnimationFrame(raf);
  }, [loading, data]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/helpdesk/returns/${encodeURIComponent(returnId)}/correspondence`,
          { cache: "no-store" },
        );
        const json = (await res.json().catch(() => null)) as {
          data?: CorrespondenceData;
          error?: string;
        } | null;
        if (!res.ok) throw new Error(json?.error ?? `Failed (${res.status})`);
        if (!cancelled) setData(json?.data ?? null);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [returnId]);

  const totalMessages =
    data?.threads.reduce((n, t) => n + t.messages.length, 0) ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-hairline bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <MessagesSquare className="h-4 w-4 text-brand" />
              Message correspondence
            </h3>
            {buyerUserId ? (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Buyer {buyerUserId} · {totalMessages} message
                {totalMessages === 1 ? "" : "s"}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground cursor-pointer"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : err ? (
            <p className="py-6 text-center text-sm text-red-600 dark:text-red-300">
              {err}
            </p>
          ) : !data || data.threads.length === 0 ? (
            <div className="py-8 text-center">
              <MessageSquare className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                No Help Desk messages found for this buyer yet.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {data.threads.map((t) => (
                <div key={t.ticketId}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-semibold text-foreground">
                      {t.subject ?? "(no subject)"}
                    </p>
                    {t.ebayOrderNumber ? (
                      <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {t.ebayOrderNumber}
                      </span>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    {t.messages.map((m) => {
                      const outbound = m.direction === "OUTBOUND";
                      return (
                        <div
                          key={m.id}
                          className={
                            "flex " + (outbound ? "justify-end" : "justify-start")
                          }
                        >
                          <div
                            className={
                              "max-w-[80%] rounded-lg px-3 py-2 text-sm " +
                              (outbound
                                ? "bg-brand/10 text-foreground"
                                : "bg-surface text-foreground")
                            }
                          >
                            <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                              {m.fromName ?? (outbound ? "You" : "Buyer")} ·{" "}
                              {fmtDateTime(m.sentAt)}
                            </p>
                            {m.isHtml ? (
                              <div
                                className="prose prose-sm max-w-none text-foreground [&_*]:!text-foreground"
                                dangerouslySetInnerHTML={{ __html: m.bodyText }}
                              />
                            ) : (
                              <p className="whitespace-pre-wrap">{m.bodyText}</p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <Link
                    href={`/help-desk?ticket=${encodeURIComponent(t.ticketId)}`}
                    target="_blank"
                    className="mt-2 inline-flex items-center gap-1 text-[11px] text-brand hover:underline"
                  >
                    Open ticket <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>

        {data?.ticketSearchHref ? (
          <div className="border-t border-hairline px-5 py-3">
            <a
              href={data.ticketSearchHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:underline"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Open full conversation in Help Desk
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}
