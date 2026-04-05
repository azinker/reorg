"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarDays,
  ChevronLeft,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { PayoutEntry, PayoutsSummary } from "@/lib/services/payouts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMoney(amount: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

function toETDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
  } catch { return iso.slice(0, 10); }
}

function formatDisplayDate(yyyyMmDd: string) {
  try {
    const [y, m, d] = yyyyMmDd.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" })
      .format(new Date(y, m - 1, d));
  } catch { return yyyyMmDd; }
}

function formatDateCell(iso: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium" }).format(new Date(iso));
  } catch { return iso; }
}

function lastNDays(n: number): string[] {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (n - 1 - i));
    return toETDate(d.toISOString());
  });
}

function todayET(): string { return toETDate(new Date().toISOString()); }

function amountColor(amount: number) {
  if (amount > 0) return "text-emerald-400";
  if (amount < 0) return "text-red-400";
  return "text-muted-foreground";
}

// ─── Brand Logos ──────────────────────────────────────────────────────────────

function EbayLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const cls = size === "lg" ? "text-2xl" : size === "sm" ? "text-base" : "text-xl";
  return (
    <span className={cn("font-black leading-none tracking-tighter", cls)}>
      <span style={{ color: "#e53238" }}>e</span>
      <span style={{ color: "#0064d2" }}>b</span>
      <span style={{ color: "#f5af02" }}>a</span>
      <span style={{ color: "#86b817" }}>y</span>
    </span>
  );
}

function ShopifyLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const px = size === "lg" ? 28 : size === "sm" ? 18 : 22;
  return (
    <svg width={px} height={px} viewBox="0 0 109 124" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M95.5 23.4c-.1-.7-.7-1.1-1.2-1.1s-10.5-.8-10.5-.8-7-6.8-7.7-7.5c-.7-.7-2.1-.5-2.6-.3 0 0-1.3.4-3.4 1.1C68 9.2 64.6 4 58.6 4c-.2 0-.3 0-.5.1C56.9 2.3 55.1 1.5 53.5 1.5c-11.7 0-17.3 14.6-19 22.1-4.5 1.4-7.7 2.4-8.1 2.5-2.5.8-2.6.8-2.9 3.1C23.3 31.5 10 131 10 131l73.9 13.9 24.8-6c.1 0-12.9-114.8-13.2-115.5zM66.7 17.4c-1.6.5-3.5 1.1-5.5 1.7v-1.2c0-3.7-.5-6.7-1.4-9.1 3.5.4 5.8 4.2 6.9 8.6zM53.2 9.3c1 2.3 1.6 5.6 1.6 10.1v.6c-3.8 1.2-8 2.5-12.1 3.7 2.3-8.9 6.7-13.3 10.5-14.4zm-3.7-3.4c.6 0 1.3.2 1.9.6-4.8 2.2-9.9 7.9-12.1 19.2l-9.1 2.8C32.5 20.6 37.9 5.9 49.5 5.9z" fill="#95BF47"/>
      <path d="M94.3 22.3c-.5 0-10.5-.8-10.5-.8s-7-6.8-7.7-7.5c-.3-.3-.6-.4-.9-.4L83.9 145l24.8-6S95.3 23.8 95 23c-.2-.4-.4-.7-.7-.7z" fill="#5E8E3E"/>
      <path d="M58.6 47.2l-3 11.4s-3.3-1.7-7.4-1.4c-5.9.4-5.9 4.1-5.9 5 .3 4.8 12.9 5.8 13.6 17 .6 8.8-4.7 14.8-12.2 15.3-9 .6-13.6-4.8-13.6-4.8l1.9-7.9s4.7 3.5 8.5 3.3c2.5-.2 3.4-2.2 3.3-3.6-.4-6.3-10.7-5.9-11.3-16.2-.6-8.7 5.2-17.5 17.8-18.3 4.9-.3 7.3.9 7.3.9v-.7z" fill="#fff"/>
    </svg>
  );
}

function AmazonLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const cls = size === "lg" ? "text-xl" : size === "sm" ? "text-sm" : "text-base";
  return (
    <span className={cn("font-bold leading-none", cls)}>
      <span style={{ color: "#FF9900" }}>amazon</span>
      <span className="ml-0.5 inline-block" style={{ color: "#FF9900", fontSize: "0.65em", verticalAlign: "middle" }}>▸</span>
    </span>
  );
}

function BigCommerceLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const cls = size === "lg" ? "text-xl" : size === "sm" ? "text-sm" : "text-base";
  return (
    <span className={cn("font-black leading-none tracking-tight", cls)} style={{ color: "#34313F" }}>
      <span className="rounded bg-[#34313F] px-1 py-0.5 text-white">bc</span>
    </span>
  );
}

function StripeLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const cls = size === "lg" ? "text-xl" : size === "sm" ? "text-sm" : "text-base";
  return (
    <span className={cn("font-bold leading-none", cls)} style={{ color: "#635bff" }}>
      stripe
    </span>
  );
}

function PlatformLogo({ platform, size = "md" }: { platform: string; size?: "sm" | "md" | "lg" }) {
  switch (platform) {
    case "TPP_EBAY":
    case "TT_EBAY":    return <EbayLogo size={size} />;
    case "SHOPIFY":    return <ShopifyLogo size={size} />;
    case "AMAZON":     return <AmazonLogo size={size} />;
    case "BIGCOMMERCE":return <BigCommerceLogo size={size} />;
    default:           return null;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PLATFORM_CONFIG: Record<string, {
  border: string;
  headerBg: string;
  accent: string;
  badgeBg: string;
  badgeText: string;
}> = {
  TPP_EBAY: {
    border: "border-[#0064d2]/25",
    headerBg: "bg-gradient-to-r from-[#0064d2]/10 via-[#e53238]/5 to-transparent",
    accent: "text-[#e53238]",
    badgeBg: "bg-[#e53238]/10 border-[#e53238]/25",
    badgeText: "text-[#e53238]",
  },
  TT_EBAY: {
    border: "border-[#0064d2]/20",
    headerBg: "bg-gradient-to-r from-[#0064d2]/8 via-[#e53238]/4 to-transparent",
    accent: "text-[#e53238]/80",
    badgeBg: "bg-[#e53238]/8 border-[#e53238]/20",
    badgeText: "text-[#e53238]/80",
  },
  SHOPIFY: {
    border: "border-[#95bf47]/25",
    headerBg: "bg-gradient-to-r from-[#95bf47]/10 via-[#5e8e3e]/5 to-transparent",
    accent: "text-[#95bf47]",
    badgeBg: "bg-[#95bf47]/10 border-[#95bf47]/25",
    badgeText: "text-[#95bf47]",
  },
  AMAZON: {
    border: "border-[#FF9900]/25",
    headerBg: "bg-gradient-to-r from-[#FF9900]/10 via-[#FF9900]/5 to-transparent",
    accent: "text-[#FF9900]",
    badgeBg: "bg-[#FF9900]/10 border-[#FF9900]/25",
    badgeText: "text-[#FF9900]",
  },
  BIGCOMMERCE: {
    border: "border-[#635bff]/25",
    headerBg: "bg-gradient-to-r from-[#635bff]/10 via-[#635bff]/5 to-transparent",
    accent: "text-[#635bff]",
    badgeBg: "bg-[#635bff]/10 border-[#635bff]/25",
    badgeText: "text-[#635bff]",
  },
};

const STATUS_CONFIG: Record<string, { bg: string; text: string; dot: string }> = {
  PAID:              { bg: "bg-emerald-500/10 border-emerald-500/25", text: "text-emerald-400", dot: "bg-emerald-400" },
  SUCCEEDED:         { bg: "bg-emerald-500/10 border-emerald-500/25", text: "text-emerald-400", dot: "bg-emerald-400" },
  CLOSED:            { bg: "bg-emerald-500/10 border-emerald-500/25", text: "text-emerald-400", dot: "bg-emerald-400" },
  SUCCESSFUL:        { bg: "bg-emerald-500/10 border-emerald-500/25", text: "text-emerald-400", dot: "bg-emerald-400" },
  IN_TRANSIT:        { bg: "bg-sky-500/10 border-sky-500/25",         text: "text-sky-400",     dot: "bg-sky-400" },
  PENDING:           { bg: "bg-amber-500/10 border-amber-500/25",     text: "text-amber-400",   dot: "bg-amber-400" },
  SCHEDULED:         { bg: "bg-amber-500/10 border-amber-500/25",     text: "text-amber-400",   dot: "bg-amber-400" },
  RETRYABLE_FAILURE: { bg: "bg-orange-500/10 border-orange-500/25",   text: "text-orange-400",  dot: "bg-orange-400" },
  FAILED:            { bg: "bg-red-500/10 border-red-500/25",         text: "text-red-400",     dot: "bg-red-400" },
  TERMINAL_FAILURE:  { bg: "bg-red-500/10 border-red-500/25",         text: "text-red-400",     dot: "bg-red-400" },
  CANCELED:          { bg: "bg-muted/40 border-border",               text: "text-muted-foreground", dot: "bg-muted-foreground" },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { bg: "bg-muted/40 border-border", text: "text-muted-foreground", dot: "bg-muted-foreground" };
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", cfg.bg, cfg.text)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", cfg.dot)} />
      {status}
    </span>
  );
}

const NO_PAYOUT_HINT: Record<string, { title: string; body: string }> = {
  TPP_EBAY: {
    title: "No payout on this date",
    body: "eBay pays out daily on business days. No deposit was made on this date.",
  },
  TT_EBAY: {
    title: "No payout on this date",
    body: "eBay pays out daily on business days. No deposit was made on this date.",
  },
  SHOPIFY: {
    title: "No deposit recorded",
    body: 'Shopify Payments deposits daily into your Shopify Balance — an internal wallet that accumulates over time. No deposit was recorded on this date. Your running balance can only be viewed inside Shopify admin (click "Open Shopify Balance" above).',
  },
  AMAZON: {
    title: "No settlement on this date",
    body: "Amazon settles on a ~14-day cycle. This date falls inside a settlement period — the transfer will appear once that period closes.",
  },
  BIGCOMMERCE: {
    title: "No payout on this date",
    body: "Stripe payout schedules depend on your account settings. No payout was recorded on this date.",
  },
};

// ─── Payouts Table ────────────────────────────────────────────────────────────

function PayoutsTable({ payouts, platform }: { payouts: PayoutEntry[]; platform: string }) {
  const showGross = payouts.some((p) => p.grossAmount != null);
  const showBank  = payouts.some((p) => p.bankAccount != null);
  const cfg = PLATFORM_CONFIG[platform];

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border/60 text-[10px] uppercase tracking-widest text-muted-foreground/70">
            <th className="px-5 py-2.5 font-semibold">Date (ET)</th>
            {showGross && <th className="px-5 py-2.5 font-semibold">Gross</th>}
            <th className="px-5 py-2.5 font-semibold">Net</th>
            <th className="px-5 py-2.5 font-semibold">Status</th>
            <th className="px-5 py-2.5 font-semibold">Type</th>
            {showBank && <th className="px-5 py-2.5 font-semibold">Paid to</th>}
          </tr>
        </thead>
        <tbody>
          {payouts.map((p, i) => (
            <tr
              key={p.id}
              className={cn(
                "border-b border-border/30 last:border-0 transition-colors hover:bg-white/[0.02]",
                i === 0 && "bg-white/[0.015]",
              )}
            >
              <td className="px-5 py-3 text-sm text-foreground/90">{formatDateCell(p.date)}</td>
              {showGross && (
                <td className="px-5 py-3 text-sm text-muted-foreground">
                  {p.grossAmount != null ? formatMoney(p.grossAmount, p.currency) : "—"}
                </td>
              )}
              <td className={cn("px-5 py-3 text-sm font-bold tabular-nums", amountColor(p.netAmount))}>
                {p.netAmount > 0 ? "+" : ""}{formatMoney(p.netAmount, p.currency)}
              </td>
              <td className="px-5 py-3">
                <StatusBadge status={p.status} />
              </td>
              <td className="px-5 py-3">
                <span className={cn("rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide", cfg?.badgeBg, cfg?.badgeText)}>
                  {p.type ?? "—"}
                </span>
              </td>
              {showBank && (
                <td className="px-5 py-3">
                  {p.bankAccount ? (
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/30 px-2.5 py-1 text-xs font-medium text-foreground/80">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/70" />
                      {p.bankAccount}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground/50">—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Platform Card ────────────────────────────────────────────────────────────

type PlatformData = PayoutsSummary["platforms"][number];

function PlatformCard({ p, selectedDate }: { p: PlatformData; selectedDate: string | null }) {
  const cfg = PLATFORM_CONFIG[p.platform] ?? {
    border: "border-border",
    headerBg: "bg-card",
    accent: "text-foreground",
    badgeBg: "bg-muted/40 border-border",
    badgeText: "text-muted-foreground",
  };

  const isStripeNotConfigured = p.platform === "BIGCOMMERCE" && p.fetchError?.includes("STRIPE_SECRET_KEY");

  const filteredPayouts = selectedDate
    ? p.payouts.filter((payout) => toETDate(payout.date) === selectedDate)
    : p.payouts.slice(0, 15);

  const dateTotal = filteredPayouts.reduce((s, payout) => s + payout.netAmount, 0);
  const dateHasPayouts = filteredPayouts.length > 0;
  const displayAmount = selectedDate
    ? dateHasPayouts ? dateTotal : null
    : p.latestNet;
  const displayCurrency = filteredPayouts[0]?.currency ?? p.latestCurrency;

  const hint = NO_PAYOUT_HINT[p.platform];
  const latestPayoutDate = p.payouts[0]?.date ? formatDateCell(p.payouts[0].date) : null;

  return (
    <div className={cn("rounded-2xl border overflow-hidden shadow-sm bg-card/40 backdrop-blur-sm", cfg.border)}>

      {/* Header */}
      <div className={cn("flex items-center justify-between gap-4 px-5 py-4", cfg.headerBg)}>
        <div className="flex items-center gap-4">
          {/* Logo block */}
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-card/80 shadow-sm">
            <PlatformLogo platform={p.platform} size="sm" />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <p className={cn("text-[11px] font-bold uppercase tracking-[0.15em]", cfg.accent)}>
                {p.label}
              </p>
              {!selectedDate && latestPayoutDate && !p.fetchError && (
                <span className="rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
                  latest: {latestPayoutDate}
                </span>
              )}
            </div>
            <p className={cn(
              "mt-0.5 text-2xl font-bold tabular-nums leading-none",
              displayAmount != null ? amountColor(displayAmount) : "text-muted-foreground",
            )}>
              {displayAmount != null
                ? (displayAmount > 0 ? "+" : "") + formatMoney(displayAmount, displayCurrency)
                : "—"}
            </p>
          </div>
        </div>

        {p.adminUrl && (
          <a
            href={p.adminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border/60 bg-card/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground"
          >
            {p.adminUrlLabel ?? "Open"}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {/* Body */}
      <div className="border-t border-border/30">
        {isStripeNotConfigured ? (
          <div className="flex items-start gap-3 px-5 py-4">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#635bff]/15">
              <StripeLogo size="sm" />
            </div>
            <p className="text-sm text-muted-foreground">
              Add{" "}
              <code className="rounded border border-[#635bff]/30 bg-[#635bff]/10 px-1.5 py-0.5 text-xs font-mono text-[#635bff]">
                STRIPE_SECRET_KEY
              </code>{" "}
              to your environment variables to see live Stripe payout data here.
            </p>
          </div>
        ) : p.fetchError ? (
          <div className="flex items-start gap-2.5 px-5 py-4 text-sm text-amber-200/80">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            {p.fetchError}
          </div>
        ) : selectedDate && !dateHasPayouts ? (
          <div className="flex items-start gap-3 px-5 py-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" />
            <div>
              <p className="text-sm font-medium text-muted-foreground">{hint?.title ?? "No payout on this date"}</p>
              <p className="mt-0.5 text-xs text-muted-foreground/60">{hint?.body}</p>
            </div>
          </div>
        ) : filteredPayouts.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">No payout history available.</p>
        ) : (
          <PayoutsTable payouts={filteredPayouts} platform={p.platform} />
        )}
      </div>
    </div>
  );
}

// ─── Date strip ───────────────────────────────────────────────────────────────

function DateStrip({
  payoutDateSet,
  selectedDate,
  onSelect,
}: {
  payoutDateSet: Set<string>;
  selectedDate: string | null;
  onSelect: (date: string | null) => void;
}) {
  const days = lastNDays(7);
  const today = todayET();
  const dateInputRef = useRef<HTMLInputElement>(null);
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="flex items-stretch gap-2 overflow-x-auto pb-1">

      {/* "Latest" pill */}
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "flex shrink-0 cursor-pointer flex-col items-center justify-center rounded-xl border px-4 py-2.5 text-center transition-all",
          selectedDate === null
            ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200 shadow-[0_0_12px_rgba(16,185,129,0.15)]"
            : "border-border/60 bg-card/60 text-muted-foreground hover:border-border hover:bg-muted/30 hover:text-foreground",
        )}
      >
        <span className="text-[10px] font-bold uppercase tracking-widest">All</span>
        <span className="text-sm font-bold">Latest</span>
      </button>

      {days.map((d) => {
        const [y, m, day] = d.split("-").map(Number);
        const jsDate = new Date(y, m - 1, day);
        const dayName = DAY_NAMES[jsDate.getDay()];
        const isToday = d === today;
        const isSelected = d === selectedDate;
        const hasPayout = payoutDateSet.has(d);

        return (
          <button
            key={d}
            type="button"
            onClick={() => onSelect(isSelected ? null : d)}
            className={cn(
              "relative flex shrink-0 cursor-pointer flex-col items-center rounded-xl border px-3.5 py-2.5 text-center transition-all",
              isSelected
                ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200 shadow-[0_0_12px_rgba(16,185,129,0.15)]"
                : isToday
                  ? "border-emerald-500/20 bg-emerald-500/5 text-muted-foreground hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-200"
                  : "border-border/60 bg-card/60 text-muted-foreground hover:border-border hover:bg-muted/30 hover:text-foreground",
            )}
          >
            <span className={cn(
              "text-[10px] font-bold uppercase tracking-widest",
              isToday && !isSelected ? "text-emerald-400/70" : "",
            )}>
              {isToday ? "Today" : dayName}
            </span>
            <span className="text-sm font-bold">{day}</span>
            <span className={cn(
              "mt-1 h-1.5 w-1.5 rounded-full transition-all",
              hasPayout ? "bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)]" : "bg-transparent",
            )} />
          </button>
        );
      })}

      {/* Earlier date picker */}
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => dateInputRef.current?.showPicker?.() ?? dateInputRef.current?.click()}
          className={cn(
            "flex h-full cursor-pointer flex-col items-center justify-center rounded-xl border px-3.5 py-2.5 text-center transition-all",
            selectedDate && !days.includes(selectedDate)
              ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200 shadow-[0_0_12px_rgba(16,185,129,0.15)]"
              : "border-border/60 bg-card/60 text-muted-foreground hover:border-border hover:bg-muted/30 hover:text-foreground",
          )}
        >
          <CalendarDays className="h-4 w-4" />
          <span className="mt-1 text-[10px] font-bold uppercase tracking-widest">
            {selectedDate && !days.includes(selectedDate)
              ? formatDisplayDate(selectedDate).split(",")[0]
              : "Earlier"}
          </span>
        </button>
        <input
          ref={dateInputRef}
          type="date"
          max={today}
          value={selectedDate && !days.includes(selectedDate) ? selectedDate : ""}
          onChange={(e) => { if (e.target.value) onSelect(e.target.value); }}
          className="pointer-events-none absolute inset-0 h-0 w-0 opacity-0"
        />
      </div>

      {selectedDate && (
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-border/60 bg-card/60 px-3 py-2 text-xs text-muted-foreground transition-all hover:border-border hover:bg-muted/30 hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" />
          Clear
        </button>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PayoutsPage() {
  const [loading, setLoading]       = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [forbidden, setForbidden]   = useState(false);
  const [data, setData]             = useState<PayoutsSummary | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    setForbidden(false);
    try {
      const res = await fetch("/api/payouts", { cache: "no-store" });
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(typeof j.error === "string" ? j.error : "Failed to load");
      }
      const json = (await res.json()) as { data: PayoutsSummary };
      setData(json.data);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const payoutDateSet = new Set<string>();
  data?.platforms.forEach((p) => {
    p.payouts.forEach((payout) => payoutDateSet.add(toETDate(payout.date)));
  });

  const heroTotal = data
    ? selectedDate
      ? data.platforms.reduce((sum, p) => {
          const dayPayouts = p.payouts.filter((payout) => toETDate(payout.date) === selectedDate);
          return sum + dayPayouts.reduce((s, payout) => s + (payout.currency === "USD" ? payout.netAmount : 0), 0);
        }, 0)
      : data.heroTotal
    : 0;

  if (forbidden) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg font-medium">Admins only</p>
        <p className="max-w-md text-sm text-muted-foreground">Payouts shows financial data. Ask an admin if you need access.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 p-4 md:p-6">

      {/* Page header */}
      <div className="flex flex-col gap-2 border-b border-border pb-4 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
            <Wallet className="h-3.5 w-3.5" />
            Payouts
          </div>
          <h1 className="mt-3 text-xl font-semibold tracking-tight text-foreground md:text-2xl">
            Marketplace Payouts
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Live payout data from every marketplace. Select a date to see what each store paid out that day.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </button>
      </div>

      {fetchError && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {fetchError}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-24">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-400/60" />
            <p className="text-sm text-muted-foreground">Fetching payouts from all marketplaces…</p>
          </div>
        </div>
      )}

      {data && (
        <>
          {/* Hero */}
          <div className="relative overflow-hidden rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-950/60 via-card/80 to-card/60 p-5 shadow-lg">
            {/* Decorative glow */}
            <div className="pointer-events-none absolute -left-10 -top-10 h-40 w-40 rounded-full bg-emerald-500/10 blur-3xl" />
            <div className="pointer-events-none absolute right-0 top-0 h-32 w-32 rounded-full bg-emerald-400/5 blur-2xl" />

            <div className="relative flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-300">
                  <TrendingUp className="h-3.5 w-3.5" />
                  {selectedDate ? `Payouts — ${formatDisplayDate(selectedDate)}` : "Combined latest payouts"}
                </div>
                <p className={cn("mt-3 text-5xl font-black tabular-nums tracking-tight", amountColor(heroTotal))}>
                  {heroTotal > 0 ? "+" : ""}{formatMoney(heroTotal, "USD")}
                </p>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  {selectedDate
                    ? "Net across all marketplaces on this date · Shopify Balance not accessible via API"
                    : "Sum of most recent payout per marketplace · Shopify Balance not accessible via API"}
                </p>
              </div>

              <div className="flex flex-wrap gap-2.5">
                {data.platforms
                  .filter((p) => !p.fetchError || p.platform === "SHOPIFY")
                  .map((p) => {
                    const cfg = PLATFORM_CONFIG[p.platform];
                    const dayPayouts = selectedDate
                      ? p.payouts.filter((payout) => toETDate(payout.date) === selectedDate)
                      : null;
                    const amount = dayPayouts
                      ? dayPayouts.reduce((s, payout) => s + payout.netAmount, 0)
                      : p.latestNet;
                    const currency = dayPayouts?.[0]?.currency ?? p.latestCurrency;
                    const hasAmount = amount != null && (!selectedDate || (dayPayouts?.length ?? 0) > 0);
                    return (
                      <div key={p.platform} className={cn("rounded-xl border px-3.5 py-2.5", cfg?.badgeBg ?? "border-border bg-card/60")}>
                        <div className="mb-1">
                          <PlatformLogo platform={p.platform} size="sm" />
                        </div>
                        <p className={cn("text-sm font-bold tabular-nums", hasAmount ? amountColor(amount!) : "text-muted-foreground")}>
                          {hasAmount ? (amount! > 0 ? "+" : "") + formatMoney(amount!, currency) : "—"}
                        </p>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>

          {/* Date strip */}
          <DateStrip
            payoutDateSet={payoutDateSet}
            selectedDate={selectedDate}
            onSelect={setSelectedDate}
          />

          {selectedDate && (
            <p className="text-xs text-muted-foreground/70">
              Showing payouts for{" "}
              <span className="font-semibold text-foreground">{formatDisplayDate(selectedDate)}</span>
              {" "}· Green dots indicate days with at least one recorded payout.
            </p>
          )}

          {/* Platform cards — vertical stack */}
          <div className="flex flex-col gap-3.5">
            {data.platforms.map((p) => (
              <PlatformCard key={p.platform} p={p} selectedDate={selectedDate} />
            ))}
          </div>

          <p className="text-[11px] text-muted-foreground/50">
            Last fetched:{" "}
            {new Intl.DateTimeFormat("en-US", {
              timeZone: "America/New_York",
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(data.fetchedAt))}{" "}
            ET
          </p>
        </>
      )}
    </div>
  );
}
