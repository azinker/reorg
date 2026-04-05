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

/** eBay — 4 coloured letters, scaled to fit the container */
function EbayLogo() {
  return (
    <svg viewBox="0 0 52 20" width="46" height="18" aria-label="eBay">
      <text x="0"  y="17" fontFamily="Arial Black,Arial,sans-serif" fontWeight="900" fontSize="20" fill="#e53238">e</text>
      <text x="13" y="17" fontFamily="Arial Black,Arial,sans-serif" fontWeight="900" fontSize="20" fill="#0064d2">b</text>
      <text x="26" y="17" fontFamily="Arial Black,Arial,sans-serif" fontWeight="900" fontSize="20" fill="#f5af02">a</text>
      <text x="38" y="17" fontFamily="Arial Black,Arial,sans-serif" fontWeight="900" fontSize="20" fill="#86b817">y</text>
    </svg>
  );
}

/** Shopify — green bag mark */
function ShopifyLogo() {
  return (
    <svg viewBox="0 0 32 36" width="20" height="22" aria-label="Shopify" fill="none">
      {/* handle */}
      <path d="M10 12 C10 6.5 13 4 16 4 C19 4 22 6.5 22 12" stroke="#95BF47" strokeWidth="2.5" strokeLinecap="round" fill="none"/>
      {/* bag body */}
      <rect x="4" y="12" width="24" height="20" rx="3" fill="#95BF47"/>
      {/* white S */}
      <path d="M13.5 19.5 C13.5 18 14.5 17 16 17 C17.5 17 18.5 17.8 18.5 19 C18.5 20.2 17.5 20.8 16 21.3 C14.5 21.8 13.5 22.5 13.5 23.8 C13.5 25.1 14.5 26 16 26 C17.5 26 18.5 25.1 18.5 23.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" fill="none"/>
    </svg>
  );
}

/** Amazon — wordmark + orange smile */
function AmazonLogo() {
  return (
    <svg viewBox="0 0 58 26" width="52" height="22" aria-label="Amazon">
      <text x="0" y="16" fontFamily="Arial,sans-serif" fontWeight="bold" fontSize="14" fill="#232f3e" letterSpacing="-0.3">amazon</text>
      <path d="M4 21 Q29 29 54 21" stroke="#FF9900" strokeWidth="2" fill="none" strokeLinecap="round"/>
      <path d="M50 19 L54 21 L51 24" stroke="#FF9900" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

/** BigCommerce — blue "BC" badge */
function BigCommerceLogo() {
  return (
    <svg viewBox="0 0 36 22" width="36" height="22" aria-label="BigCommerce">
      <rect width="36" height="22" rx="4" fill="#183A7D"/>
      <text x="18" y="16" textAnchor="middle" fontFamily="Arial Black,Arial,sans-serif" fontWeight="900" fontSize="13" fill="white" letterSpacing="0.5">BC</text>
    </svg>
  );
}

/** Stripe — purple wordmark */
function StripeLogo() {
  return (
    <svg viewBox="0 0 42 16" width="40" height="15" aria-label="Stripe">
      <text x="0" y="13" fontFamily="Arial,sans-serif" fontWeight="bold" fontSize="14" fill="#635bff" letterSpacing="-0.2">stripe</text>
    </svg>
  );
}

function PlatformLogo({ platform }: { platform: string }) {
  switch (platform) {
    case "TPP_EBAY":
    case "TT_EBAY":     return <EbayLogo />;
    case "SHOPIFY":     return <ShopifyLogo />;
    case "AMAZON":      return <AmazonLogo />;
    case "BIGCOMMERCE": return <BigCommerceLogo />;
    default:            return null;
  }
}

/** Logo used inside the hero mini-badge (slightly smaller) */
function PlatformLogoHero({ platform }: { platform: string }) {
  return (
    <span className="flex items-center justify-center" style={{ transform: "scale(0.82)", transformOrigin: "center" }}>
      <PlatformLogo platform={platform} />
    </span>
  );
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

// ─── Platform Card (compact column tile) ─────────────────────────────────────

type PlatformData = PayoutsSummary["platforms"][number];

/** Short date like "Apr 6" */
function formatDateShort(iso: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
    }).format(new Date(iso));
  } catch { return iso.slice(0, 10); }
}

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
    : p.payouts.slice(0, 20);

  const dateTotal   = filteredPayouts.reduce((s, payout) => s + payout.netAmount, 0);
  const dateHasPayouts = filteredPayouts.length > 0;
  const displayAmount  = selectedDate ? (dateHasPayouts ? dateTotal : null) : p.latestNet;
  const displayCurrency = filteredPayouts[0]?.currency ?? p.latestCurrency;
  const latestDate  = p.payouts[0]?.date ? formatDateShort(p.payouts[0].date) : null;

  // Primary bank account (use the most common across payouts)
  const primaryBank = p.payouts.find((payout) => payout.bankAccount)?.bankAccount ?? null;

  const hint = NO_PAYOUT_HINT[p.platform];

  return (
    <div className={cn(
      "flex flex-col rounded-2xl border overflow-hidden shadow-sm bg-card/40 backdrop-blur-sm",
      cfg.border,
    )}>

      {/* ── Card header ── */}
      <div className={cn("flex flex-col gap-3 p-4", cfg.headerBg)}>

        {/* Top row: logo + label + external link */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Logo frame — wide enough for text-based logos */}
            <div className="flex h-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-card/80 px-2">
              <PlatformLogo platform={p.platform} />
            </div>
            <p className={cn("truncate text-[11px] font-bold uppercase tracking-[0.14em]", cfg.accent)}>
              {p.label}
            </p>
          </div>
          {p.adminUrl && (
            <a
              href={p.adminUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 cursor-pointer rounded-md border border-border/50 bg-card/60 p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              title={p.adminUrlLabel ?? "Open"}
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        {/* Amount */}
        {!p.fetchError ? (
          <div>
            <p className={cn(
              "text-2xl font-black tabular-nums leading-none",
              displayAmount != null ? amountColor(displayAmount) : "text-muted-foreground",
            )}>
              {displayAmount != null
                ? (displayAmount > 0 ? "+" : "") + formatMoney(displayAmount, displayCurrency)
                : "—"}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground/70">
              {selectedDate ? "on this date" : latestDate ? `latest · ${latestDate}` : "no data"}
            </p>
          </div>
        ) : (
          <p className="text-lg font-bold text-muted-foreground">—</p>
        )}

        {/* Bank badge */}
        {primaryBank && !p.fetchError && (
          <span className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-border/50 bg-muted/30 px-2 py-1 text-[11px] font-medium text-foreground/70">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/70" />
            {primaryBank}
          </span>
        )}
      </div>

      {/* ── Card body: compact payout rows ── */}
      <div className="flex-1 overflow-y-auto border-t border-border/30" style={{ maxHeight: 260 }}>
        {isStripeNotConfigured ? (
          <div className="px-4 py-3 text-xs text-muted-foreground/70">
            Add <code className="rounded bg-[#635bff]/10 px-1 text-[#635bff]">STRIPE_SECRET_KEY</code> to see live data.
          </div>
        ) : p.fetchError ? (
          <div className="flex items-start gap-2 px-4 py-3 text-xs text-amber-200/80">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <span>{p.fetchError}</span>
          </div>
        ) : selectedDate && !dateHasPayouts ? (
          <div className="flex items-start gap-2 px-4 py-3">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
            <div>
              <p className="text-xs font-medium text-muted-foreground">{hint?.title ?? "No payout"}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/60">{hint?.body}</p>
            </div>
          </div>
        ) : filteredPayouts.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">No data available.</p>
        ) : (
          filteredPayouts.map((payout, i) => {
            const scfg = STATUS_CONFIG[payout.status];
            return (
              <div
                key={payout.id}
                className={cn(
                  "border-b border-border/25 px-4 py-2.5 last:border-0 transition-colors hover:bg-white/[0.025]",
                  i === 0 && "bg-white/[0.015]",
                )}
              >
                {/* Row 1: date + net amount */}
                <div className="flex items-baseline justify-between gap-2">
                  <span className="shrink-0 text-[11px] font-medium text-foreground/60">
                    {formatDateShort(payout.date)}
                  </span>
                  <div className="text-right">
                    {payout.grossAmount != null && (
                      <span className="block text-[10px] text-muted-foreground/50">
                        gross {formatMoney(payout.grossAmount, payout.currency)}
                      </span>
                    )}
                    <span className={cn("text-sm font-bold tabular-nums", amountColor(payout.netAmount))}>
                      {payout.netAmount > 0 ? "+" : ""}{formatMoney(payout.netAmount, payout.currency)}
                    </span>
                  </div>
                </div>
                {/* Row 2: type + status + bank */}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {payout.type && (
                    <span className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide border",
                      cfg?.badgeBg, cfg?.badgeText,
                    )}>
                      {payout.type}
                    </span>
                  )}
                  <span className={cn("inline-flex items-center gap-1 text-[10px] font-semibold", scfg?.text ?? "text-muted-foreground")}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", scfg?.dot ?? "bg-muted-foreground")} />
                    {payout.status}
                  </span>
                  {payout.bankAccount && (
                    <span className="text-[10px] text-muted-foreground/50 truncate max-w-[110px]" title={payout.bankAccount}>
                      → {payout.bankAccount}
                    </span>
                  )}
                </div>
              </div>
            );
          })
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
                      <div key={p.platform} className={cn("rounded-xl border px-3 py-2.5", cfg?.badgeBg ?? "border-border bg-card/60")}>
                        <div className="mb-1.5 flex items-center justify-center overflow-hidden">
                          <PlatformLogoHero platform={p.platform} />
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

          {/* Platform cards — horizontal 5-col grid */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
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
