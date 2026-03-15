"use client";

import { cn } from "@/lib/utils";
import { PLATFORM_SHORT, PLATFORM_COLORS, type StoreValue } from "@/lib/grid-types";
import { ExternalLink } from "lucide-react";

interface ItemNumberCellProps {
  items: StoreValue[];
}

export function ItemNumberCell({ items }: ItemNumberCellProps) {
  if (items.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item, i) => {
        const label = PLATFORM_SHORT[item.platform];
        const colorClass = PLATFORM_COLORS[item.platform];

        return (
          <a
            key={`${item.platform}-${item.listingId}-${i}`}
            href={item.url ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "inline-flex min-w-[80px] items-center gap-1 rounded border px-2 py-1 text-xs transition-opacity hover:opacity-80 cursor-pointer",
              colorClass
            )}
            title={`Open ${label} listing ${item.value}`}
          >
            <span className="text-[10px] font-semibold uppercase opacity-70">{label}</span>
            <span className="font-mono text-[11px]">{String(item.value).slice(-6)}</span>
            <ExternalLink className="h-2.5 w-2.5 opacity-50" />
          </a>
        );
      })}
    </div>
  );
}
