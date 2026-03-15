"use client";

import { cn } from "@/lib/utils";
import {
  PLATFORM_SHORT,
  PLATFORM_COLORS,
  type Platform,
  type StoreValue,
} from "@/lib/grid-types";

interface StoreBlockProps {
  item: StoreValue;
  format?: "currency" | "percent" | "text" | "link";
  showStaged?: boolean;
}

export function StoreBlock({ item, format = "text", showStaged = true }: StoreBlockProps) {
  const label = PLATFORM_SHORT[item.platform];
  const colorClass = PLATFORM_COLORS[item.platform];
  const hasStaged = showStaged && item.stagedValue != null && item.stagedValue !== item.value;

  function fmt(val: number | string | null): string {
    if (val == null) return "N/A";
    if (format === "currency") return `$${Number(val).toFixed(2)}`;
    if (format === "percent") return `${(Number(val) * 100).toFixed(1)}%`;
    return String(val);
  }

  return (
    <div
      className={cn(
        "inline-flex min-w-[80px] flex-col rounded border px-2 py-1 text-xs",
        colorClass,
        hasStaged && "ring-1 ring-[var(--staged)]"
      )}
    >
      <span className="mb-0.5 text-[10px] font-semibold uppercase opacity-70">
        {label}
        {item.variantId && (
          <span className="ml-1 font-normal opacity-50">({item.variantId})</span>
        )}
      </span>
      {hasStaged ? (
        <>
          <span className="font-semibold leading-tight">
            {fmt(item.stagedValue!)}
            <span className="ml-1 inline-flex items-center rounded-sm bg-[var(--staged)] px-1 py-px text-[9px] font-bold text-[var(--staged-foreground)]">
              STAGED
            </span>
          </span>
          <span className="mt-0.5 text-[10px] leading-tight opacity-50 line-through">
            {fmt(item.value)} <span className="no-underline">live</span>
          </span>
        </>
      ) : (
        <span className="font-medium leading-tight">{fmt(item.value)}</span>
      )}
    </div>
  );
}

interface StoreBlockGroupProps {
  items: StoreValue[];
  format?: "currency" | "percent" | "text" | "link";
  showStaged?: boolean;
}

export function StoreBlockGroup({ items, format = "text", showStaged = true }: StoreBlockGroupProps) {
  if (items.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item, i) => (
        <StoreBlock key={`${item.platform}-${item.listingId}-${i}`} item={item} format={format} showStaged={showStaged} />
      ))}
    </div>
  );
}
