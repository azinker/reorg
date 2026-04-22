"use client";

/**
 * Sub-filter chip bar for the "From eBay" folder.
 *
 * Renders a horizontally-scrollable strip of buttons, one per
 * `SystemMessageType` (Return Approved, Item Not Received, Buyer Shipped
 * Item, Case Closed, …) plus a leading "All" chip that clears the filter.
 *
 * The active chip is fully controlled by the parent (HelpDeskClient) so the
 * cache key inside `useHelpdesk` stays stable and so chip selection can be
 * reset whenever the agent navigates away from the From eBay folder.
 *
 * The labels are sourced from `SYSTEM_MESSAGE_TYPE_LABELS` in
 * `from-ebay-detect.ts` — keep both in sync when adding new categories so
 * the chip text matches the value the sync writes to `systemMessageType`.
 */

import { cn } from "@/lib/utils";
import {
  SYSTEM_MESSAGE_TYPES,
  SYSTEM_MESSAGE_TYPE_LABELS,
  type SystemMessageType,
} from "@/lib/helpdesk/from-ebay-detect";

interface FromEbayChipsProps {
  active: string | null;
  onChange: (next: string | null) => void;
}

/**
 * Display order for the chips. Chosen to put the highest-volume eBay
 * notifications first (Returns + INR + Cancellation) and the bookkeeping
 * categories last (Payouts / Funds On Hold / Reminders). The `OTHER`
 * bucket sits at the very end so it never visually competes with the
 * concrete categories an agent typically scans for.
 */
const CHIP_ORDER: SystemMessageType[] = [
  SYSTEM_MESSAGE_TYPES.RETURN_REQUEST,
  SYSTEM_MESSAGE_TYPES.RETURN_APPROVED,
  SYSTEM_MESSAGE_TYPES.RETURN_CLOSED,
  SYSTEM_MESSAGE_TYPES.ITEM_NOT_RECEIVED,
  SYSTEM_MESSAGE_TYPES.CANCELLATION_REQUEST,
  SYSTEM_MESSAGE_TYPES.CANCELLATION_CONFIRMED,
  SYSTEM_MESSAGE_TYPES.CASE_OPENED,
  SYSTEM_MESSAGE_TYPES.CASE_ON_HOLD,
  SYSTEM_MESSAGE_TYPES.CASE_CLOSED,
  SYSTEM_MESSAGE_TYPES.BUYER_SHIPPED,
  SYSTEM_MESSAGE_TYPES.ITEM_DELIVERED,
  SYSTEM_MESSAGE_TYPES.REFUND_ISSUED,
  SYSTEM_MESSAGE_TYPES.REFUND_REQUESTED,
  SYSTEM_MESSAGE_TYPES.REMINDER_TO_SHIP,
  SYSTEM_MESSAGE_TYPES.PAYOUT_SENT,
  SYSTEM_MESSAGE_TYPES.FUNDS_ON_HOLD,
  SYSTEM_MESSAGE_TYPES.FEEDBACK_REMOVAL_APPROVED,
  SYSTEM_MESSAGE_TYPES.FEEDBACK_REPORTED,
  SYSTEM_MESSAGE_TYPES.OTHER_EBAY_NOTIFICATION,
];

export function FromEbayChips({ active, onChange }: FromEbayChipsProps) {
  return (
    <div
      className="flex flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-hairline bg-card/40 px-3 py-2 text-[11px]"
      role="tablist"
      aria-label="Filter From eBay messages by type"
    >
      <span className="shrink-0 text-muted-foreground">eBay event</span>
      <Chip
        active={active === null}
        onClick={() => onChange(null)}
        label="All"
      />
      {CHIP_ORDER.map((type) => (
        <Chip
          key={type}
          active={active === type}
          onClick={() => onChange(type)}
          label={SYSTEM_MESSAGE_TYPE_LABELS[type]}
        />
      ))}
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "shrink-0 cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-sky-500/60 bg-sky-500/15 text-sky-700 dark:text-sky-300"
          : "border-hairline bg-surface text-muted-foreground hover:bg-surface-2 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
