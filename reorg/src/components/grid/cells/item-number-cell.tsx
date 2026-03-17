"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { PLATFORM_COLORS, PLATFORM_SHORT, type StoreValue, type Platform } from "@/lib/grid-types";
import { PlatformIcon } from "@/components/grid/platform-icon";
import { ExternalLink, Copy, Check, EyeOff } from "lucide-react";

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
  const [copied, setCopied] = useState(false);
  const prefix = PLATFORM_SHORT[item.platform];
  const url = buildListingUrl(item.platform, item.listingId, item.url);

  function handleCopy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(String(item.listingId));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className={cn(
        "flex w-full items-center gap-1.5 rounded border px-2 py-1 text-xs transition-opacity hover:opacity-80",
        colorClass
      )}
    >
      <PlatformIcon platform={item.platform} className="h-3.5 w-3.5 shrink-0" />
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
          className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[11px] font-bold leading-tight hover:underline cursor-pointer text-left"
          title={`Open in incognito — ${item.listingId} on TT eBay (right-click → Open in Incognito Window)`}
        >
          <span className="font-extrabold">{prefix}</span>
          <span className="opacity-40">-</span>
          <span className="truncate">{String(item.listingId)}</span>
          <EyeOff className="h-2.5 w-2.5 shrink-0 opacity-60" />
        </button>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[11px] font-bold leading-tight hover:underline"
          title={`Open listing ${item.listingId} on ${PLATFORM_SHORT[item.platform]}`}
        >
          <span className="font-extrabold">{prefix}</span>
          <span className="opacity-40">-</span>
          <span className="truncate">{String(item.listingId)}</span>
          <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-40" />
        </a>
      )}
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
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div className="flex max-w-[210px] flex-col gap-1">
      {items.map((item, i) => (
        <ItemRow key={`${item.platform}-${item.listingId}-${item.variantId ?? ""}-${i}`} item={item} />
      ))}
    </div>
  );
}
