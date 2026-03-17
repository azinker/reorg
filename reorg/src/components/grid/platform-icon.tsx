"use client";

import type { Platform } from "@/lib/grid-types";

const LOGO_SRC: Record<Platform, string> = {
  TPP_EBAY: "/logos/ebay.svg",
  TT_EBAY: "/logos/ebay.svg",
  BIGCOMMERCE: "/logos/bigcommerce.svg",
  SHOPIFY: "/logos/shopify.svg",
};

const LOGO_ALT: Record<Platform, string> = {
  TPP_EBAY: "eBay",
  TT_EBAY: "eBay",
  BIGCOMMERCE: "BigCommerce",
  SHOPIFY: "Shopify",
};

interface PlatformIconProps {
  platform: Platform;
  className?: string;
  size?: number;
}

export function PlatformIcon({ platform, className, size = 16 }: PlatformIconProps) {
  return (
    <img
      src={LOGO_SRC[platform]}
      alt={LOGO_ALT[platform]}
      width={size}
      height={size}
      className={className ?? `h-[${size}px] w-[${size}px]`}
      style={{ width: size, height: size, minWidth: size, minHeight: size }}
    />
  );
}

export function PlatformLabel({ platform }: { platform: Platform }) {
  const labels: Record<Platform, string> = {
    TPP_EBAY: "The Perfect Part (eBay)",
    TT_EBAY: "Telitetech (eBay)",
    BIGCOMMERCE: "BigCommerce",
    SHOPIFY: "Shopify",
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <PlatformIcon platform={platform} size={16} />
      <span>{labels[platform]}</span>
    </span>
  );
}
