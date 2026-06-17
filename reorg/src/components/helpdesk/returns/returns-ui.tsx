/**
 * Shared presentational helpers for the Return Cases UI (list + detail).
 * Pure, no data fetching — keeps the two client components consistent.
 */
import { Store } from "lucide-react";

export type ReturnLifecycle =
  | "requested"
  | "in_transit"
  | "delivered"
  | "refund_pending"
  | "closed";

export const STORE_LABEL: Record<string, string> = {
  TPP_EBAY: "TPP",
  TT_EBAY: "TT",
};

export const STORE_FULL: Record<string, string> = {
  TPP_EBAY: "The Perfect Part (eBay)",
  TT_EBAY: "Telitetech (eBay)",
};

/** Small colored store badge. TPP = brand blue, TT = violet. */
export function StoreBadge({ platform }: { platform: string }) {
  const tpp = platform === "TPP_EBAY";
  return (
    <span
      title={STORE_FULL[platform] ?? platform}
      className={
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold " +
        (tpp
          ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
          : "bg-violet-500/15 text-violet-700 dark:text-violet-300")
      }
    >
      <Store className="h-2.5 w-2.5" />
      {STORE_LABEL[platform] ?? platform}
    </span>
  );
}

const LIFECYCLE_META: Record<
  ReturnLifecycle,
  { label: string; cls: string }
> = {
  requested: {
    label: "Requested",
    cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  in_transit: {
    label: "In transit",
    cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  },
  delivered: {
    label: "Delivered",
    cls: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  },
  refund_pending: {
    label: "Refund pending",
    cls: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  },
  closed: {
    label: "Closed",
    cls: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
  },
};

export function LifecycleBadge({
  lifecycle,
  rawLabel,
}: {
  lifecycle: ReturnLifecycle;
  rawLabel?: string | null;
}) {
  const meta = LIFECYCLE_META[lifecycle] ?? LIFECYCLE_META.requested;
  return (
    <span
      title={rawLabel ?? meta.label}
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium " +
        meta.cls
      }
    >
      {meta.label}
    </span>
  );
}

/** Title-case a raw eBay ReturnStateEnum, e.g. RETURN_APPROVED → "Return Approved". */
export function humanizeState(state: string | null | undefined): string {
  if (!state) return "Unknown";
  return state
    .trim()
    .toLowerCase()
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Status pill that shows the *actual* eBay state (e.g. "Return Approved",
 * "Item Shipped") colored by its coarse lifecycle. More accurate than the
 * coarse lifecycle label alone — an approved return awaiting the buyer reads
 * "Return Approved" instead of the misleading "Requested".
 */
export function StatusBadge({
  lifecycle,
  state,
}: {
  lifecycle: ReturnLifecycle;
  state?: string | null;
}) {
  const meta = LIFECYCLE_META[lifecycle] ?? LIFECYCLE_META.requested;
  const label = state ? humanizeState(state) : meta.label;
  return (
    <span
      title={label}
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium " +
        meta.cls
      }
    >
      {label}
    </span>
  );
}

/** Format an ISO date as "Jun 16, 2026". */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Format an ISO datetime as "Jun 16, 2026, 5:19 PM". */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Relative "x ago" string for freshness indicators. */
export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function fmtMoney(
  value: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (value == null) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
    }).format(value);
  } catch {
    return `${currency ?? "$"}${value.toFixed(2)}`;
  }
}

/**
 * eBay's Post-Order API returns terse `ReturnReasonEnum` codes (e.g.
 * `ORDERED_WRONG_ITEM`) that do NOT match the buyer-facing wording shown in
 * Seller Hub. This maps the codes to eBay's current buyer-facing labels so the
 * Help Desk reads exactly like eBay. Verified against the live Get Return
 * payload: the API code `ORDERED_WRONG_ITEM` is presented to the buyer as
 * "Just didn't like it". Unknown codes fall back to title-case.
 */
const RETURN_REASON_LABELS: Record<string, string> = {
  ORDERED_WRONG_ITEM: "Just didn't like it",
  JUST_DONT_WANT: "Just didn't like it",
  NO_LONGER_NEED_ITEM: "No longer needed",
  ORDERED_ACCIDENTALLY: "Ordered by mistake",
  FOUND_BETTER_PRICE: "Found a better price",
  NOT_AS_DESCRIBED: "Doesn't match description or photos",
  WRONG_ITEM: "Wrong item sent",
  WRONG_ITEM_RECEIVED: "Wrong item sent",
  ARRIVED_DAMAGED: "Arrived damaged",
  DEFECTIVE_ITEM: "Doesn't work or defective",
  ITEM_DEFECTIVE: "Doesn't work or defective",
  MISSING_PARTS: "Missing parts or pieces",
  MISSING_PARTS_OR_PIECES: "Missing parts or pieces",
  WRONG_SIZE: "Doesn't fit",
  DOESNT_FIT: "Doesn't fit",
  ITEM_NOT_RECEIVED: "Didn't arrive",
  EXTRA_ITEM: "Extra item received",
  AUTHENTICITY: "Not authentic",
  COUNTERFEIT: "Not authentic",
};

/** Human label for a return reason, mapped to eBay's buyer-facing wording. */
export function humanizeReason(reason: string | null | undefined): string {
  if (!reason) return "—";
  const key = reason.trim().toUpperCase();
  if (RETURN_REASON_LABELS[key]) return RETURN_REASON_LABELS[key];
  return reason
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}
