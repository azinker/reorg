"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { PLATFORM_COLORS, PLATFORM_SHORT, type StoreValue, type Platform } from "@/lib/grid-types";
import { PlatformIcon } from "@/components/grid/platform-icon";
import { Check, Copy, ExternalLink, EyeOff } from "lucide-react";

const LISTING_URL_TEMPLATES: Record<Platform, (id: string) => string> = {
  TPP_EBAY: (id) => `https://www.ebay.com/itm/${id}`,
  TT_EBAY: (id) => `https://www.ebay.com/itm/${id}`,
  BIGCOMMERCE: (id) => {
    const storeHash = process.env.NEXT_PUBLIC_BIGCOMMERCE_STORE_HASH;
    return storeHash
      ? `https://store-${storeHash}.mybigcommerce.com/manage/products/edit/${id.replace(/^BC-/, "")}`
      : "#";
  },
  SHOPIFY: (id) => `https://admin.shopify.com/store/fd7279/products/${id.replace(/^SH-/, "")}`,
};

const PLATFORM_TEXT_COLORS: Record<Platform, string> = {
  TPP_EBAY: "text-blue-400",
  TT_EBAY: "text-emerald-400",
  BIGCOMMERCE: "text-orange-400",
  SHOPIFY: "text-lime-400",
};

function buildListingUrl(platform: Platform, listingId: string, explicitUrl?: string): string {
  if (explicitUrl && explicitUrl !== "#") return explicitUrl;
  const builder = LISTING_URL_TEMPLATES[platform];
  return builder ? builder(listingId) : "#";
}

interface ItemNumberCellProps {
  items: StoreValue[];
}

function ItemRow({ item }: { item: StoreValue }) {
  const colorClass = PLATFORM_COLORS[item.platform];
  const textColorClass = PLATFORM_TEXT_COLORS[item.platform];
  const [copied, setCopied] = useState(false);
  const prefix = PLATFORM_SHORT[item.platform];
  const url = buildListingUrl(item.platform, item.listingId, item.url);

  function handleCopy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    void navigator.clipboard.writeText(String(item.listingId));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex w-full items-center gap-1 rounded-md border border-border/60 bg-background/30 px-1.5 py-1">
      <div className="grid min-h-[30px] min-w-0 flex-1 grid-cols-[56px_minmax(0,1fr)_12px] items-center gap-1 rounded-sm border border-border/40 bg-background/45 px-1.5">
        <span
          className={cn(
            "inline-flex min-h-[22px] items-center justify-center gap-1 rounded-sm px-1 py-px text-[8px] font-bold uppercase leading-none",
            colorClass,
          )}
        >
          <PlatformIcon platform={item.platform} className="h-3 w-3 shrink-0" />
          <span>{prefix}</span>
        </span>

        {item.platform === "TT_EBAY" ? (
          <button
            onClick={(e) => {
              e.preventDefault();
              window.open(url, "_blank", "noopener,noreferrer");
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              window.open(url, "_blank", "noopener,noreferrer");
            }}
            className={cn(
              "min-w-0 truncate text-left font-mono text-[11px] font-bold leading-none hover:underline cursor-pointer",
              textColorClass,
            )}
            title={`Open in incognito - ${item.listingId} on TT eBay`}
          >
            {String(item.listingId)}
          </button>
        ) : (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "min-w-0 truncate font-mono text-[11px] font-bold leading-none hover:underline",
              textColorClass,
            )}
            title={`Open listing ${item.listingId} on ${PLATFORM_SHORT[item.platform]}`}
          >
            {String(item.listingId)}
          </a>
        )}

        {item.platform === "TT_EBAY" ? (
          <EyeOff className="h-2.5 w-2.5 shrink-0 opacity-50" />
        ) : (
          <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-40" />
        )}
      </div>

      <button
        onClick={handleCopy}
        className="shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-foreground cursor-pointer"
        title="Copy Item ID"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

export function ItemNumberCell({ items }: ItemNumberCellProps) {
  if (items.length === 0) {
    return <span className="text-xs text-muted-foreground">-</span>;
  }

  return (
    <div className="flex max-w-[220px] flex-col gap-1">
      {items.map((item, i) => (
        <ItemRow key={`${item.platform}-${item.listingId}-${item.variantId ?? ""}-${i}`} item={item} />
      ))}
    </div>
  );
}
