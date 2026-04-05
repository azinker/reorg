"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, RefreshCw, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WithdrawFundsShopifySnapshot } from "@/lib/services/withdraw-funds-shopify";

function formatMoney(amount: string, currencyCode: string) {
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n)) return `${amount} ${currencyCode}`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: 2,
  }).format(n);
}

function formatNy(iso: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const STATUS_COLORS: Record<string, string> = {
  PAID: "text-emerald-400",
  IN_TRANSIT: "text-sky-400",
  SCHEDULED: "text-amber-400",
  PENDING: "text-amber-400",
  FAILED: "text-red-400",
  CANCELED: "text-muted-foreground",
};

export default function WithdrawFundsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [data, setData] = useState<WithdrawFundsShopifySnapshot | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    setNotFound(null);
    try {
      const res = await fetch("/api/withdraw-funds/shopify", { cache: "no-store" });
      if (res.status === 403) { setForbidden(true); setData(null); return; }
      if (res.status === 404) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setNotFound(typeof j.error === "string" ? j.error : "Shopify is not connected.");
        setData(null);
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(typeof j.error === "string" ? j.error : "Failed to load");
      }
      const json = (await res.json()) as { data: WithdrawFundsShopifySnapshot };
      setData(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (forbidden) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg font-medium text-foreground">Admins only</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Withdraw Funds shows financial data from Shopify. Ask an admin if you need access.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-4 md:p-6">

      {/* Header */}
      <div className="flex flex-col gap-2 border-b border-border pb-4 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
            <Wallet className="h-3.5 w-3.5" />
            Withdraw Funds
          </div>
          <h1 className="mt-3 text-xl font-semibold tracking-tight text-foreground md:text-2xl">
            Shopify Balance &amp; Payments
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            To see your available balance or move money, open Shopify Balance below. reorG shows your recent payout history from Shopify Payments.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </button>
      </div>

      {notFound && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
          {notFound} Connect Shopify under Integrations, then return here.
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Hero: Shopify Balance link */}
          {data.adminUrls.shopifyBalance && (
            <a
              href={data.adminUrls.shopifyBalance}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-emerald-500/30 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.14),transparent_55%)] p-5 shadow-sm hover:border-emerald-500/50 hover:bg-emerald-500/10"
            >
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-emerald-300/80">Shopify Balance</p>
                <p className="mt-1 text-2xl font-semibold text-foreground">View available balance</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Opens your Shopify Balance account — transfer funds, send money, or add funds from there.
                </p>
              </div>
              <ExternalLink className="h-5 w-5 shrink-0 text-emerald-400 transition-transform group-hover:translate-x-0.5" />
            </a>
          )}

          {/* Secondary links */}
          <div className="flex flex-wrap gap-3">
            <a
              href={data.adminUrls.payoutsInAdmin}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted/60"
            >
              Payouts in Shopify admin
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            </a>
            <a
              href={data.adminUrls.paymentsSettings}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted/60"
            >
              Payment settings
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            </a>
          </div>

          {data.fetchError && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
              <strong className="font-semibold">Could not load Shopify Payments data.</strong> {data.fetchError}
            </div>
          )}

          {data.paymentsAccount && (
            <>
              {/* Info cards */}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
                  <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    Shopify Payments — pending sweep
                  </p>
                  <ul className="mt-2 space-y-1">
                    {data.paymentsAccount.balances.length === 0 ? (
                      <li className="text-sm text-muted-foreground">No balance rows returned.</li>
                    ) : (
                      data.paymentsAccount.balances.map((b) => (
                        <li key={`${b.currencyCode}-${b.amount}`} className="text-2xl font-semibold text-foreground">
                          {formatMoney(b.amount, b.currencyCode)}
                        </li>
                      ))
                    )}
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Amount earned but not yet swept into Shopify Balance. Resets to $0 after each daily payout.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Account {data.paymentsAccount.activated ? "activated" : "not activated"} ·{" "}
                    {data.paymentsAccount.country} · Default {data.paymentsAccount.defaultCurrency}
                  </p>
                </div>

                <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
                  <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Payout bank accounts</p>
                  {data.paymentsAccount.bankAccounts.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">None listed.</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {data.paymentsAccount.bankAccounts.map((b, i) => (
                        <li key={`${b.lastDigits}-${i}`} className="text-sm">
                          <span className="font-medium text-foreground">{b.bankName ?? "Bank account"}</span>
                          <span className="text-muted-foreground">
                            {" "}(···{b.lastDigits}) · {b.currency} ·{" "}
                            <span className={b.status === "VALIDATED" ? "text-emerald-400" : "text-amber-400"}>
                              {b.status}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {/* Payout history */}
              <div className="rounded-xl border border-border bg-card shadow-sm">
                <div className="border-b border-border px-4 py-3">
                  <p className="text-sm font-semibold text-foreground">Recent Shopify Payments payouts</p>
                  <p className="text-xs text-muted-foreground">
                    These are transfers from Shopify Payments into your Shopify Balance account (newest first, up to 25).
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-2 font-medium">Date (ET)</th>
                        <th className="px-4 py-2 font-medium">Net</th>
                        <th className="px-4 py-2 font-medium">Status</th>
                        <th className="px-4 py-2 font-medium">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.paymentsAccount.payouts.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                            No payouts returned.
                          </td>
                        </tr>
                      ) : (
                        data.paymentsAccount.payouts.map((p) => (
                          <tr key={p.id} className="border-b border-border/60 last:border-0">
                            <td className="px-4 py-2 text-foreground">{formatNy(p.issuedAt)}</td>
                            <td className="px-4 py-2 font-medium text-foreground">
                              {formatMoney(p.netAmount, p.currencyCode)}
                            </td>
                            <td className={cn("px-4 py-2 font-medium", STATUS_COLORS[p.status] ?? "text-foreground")}>
                              {p.status}
                            </td>
                            <td className="px-4 py-2 text-muted-foreground">{p.transactionType}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
