"use client";

/**
 * In-place ticket reader (replaces the old TicketReaderModal).
 *
 * Visual model mirrors eDesk:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ ← Back     [Subject + buyer + order#] · Item link · channel │
 *   ├──────────────────────────────────────────┬───────────────────┤
 *   │ ThreadView (chat bubbles + composer)     │ ContextPanel      │
 *   │                                          │ (customer/order)  │
 *   └──────────────────────────────────────────┴───────────────────┘
 *
 * Layout rules:
 *   - In LIST layout the entire inbox is replaced by this reader. A
 *     persistent "← Back" button brings the inbox back. No URL change so
 *     the browser back button still navigates to the previous reorG page.
 *   - In SPLIT layout the inbox is still visible to the left. We render
 *     the same thread + context, but skip the back button (the inbox row
 *     is the "back" affordance there). The host decides via `showBack`.
 */

import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { useEffect } from "react";
import { ThreadView } from "@/components/helpdesk/ThreadView";
import { ContextPanel } from "@/components/helpdesk/ContextPanel";
import { HelpdeskSplit } from "@/components/helpdesk/HelpdeskSplit";
import { TicketTriageBar } from "@/components/helpdesk/TicketTriageBar";
import { cn } from "@/lib/utils";
import {
  useHelpdeskPrefs,
  updateHelpdeskPrefs,
} from "@/components/helpdesk/HelpdeskSettingsDialog";
import type {
  HelpdeskTicketDetail,
  HelpdeskSyncStatus,
} from "@/hooks/use-helpdesk";

const STORE_BADGE_CLASS: Record<string, string> = {
  TPP_EBAY:
    "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  TT_EBAY:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

function storeDisplayLabel(ticket: HelpdeskTicketDetail): string {
  const raw =
    ticket.integrationLabel ||
    (ticket.channel === "TPP_EBAY"
      ? "The Perfect Part"
      : ticket.channel === "TT_EBAY"
        ? "Telitetech"
        : ticket.channel);
  return raw.replace(/\s*\(eBay\)\s*/i, "").trim() || raw;
}

interface TicketReaderProps {
  ticket: HelpdeskTicketDetail | null;
  loading: boolean;
  safeMode: boolean;
  syncStatus: HelpdeskSyncStatus | null;
  /** When true, render the "← Back" button in the header bar. */
  showBack?: boolean;
  /** Invoked when the user clicks Back (or hits Esc with no input focused). */
  onBack?: () => void;
  /** Optional prev/next ticket navigators (eDesk-style header arrows). */
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  onSent: () => void;
  agentFolders?: { id: string; name: string; color: string }[];
}

export function TicketReader({
  ticket,
  loading,
  safeMode,
  syncStatus,
  showBack = false,
  onBack,
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
  onSent,
  agentFolders = [],
}: TicketReaderProps) {
  const prefs = useHelpdeskPrefs();

  // ── Presence heartbeat ────────────────────────────────────────────────────
  // While this reader is mounted AND the tab is in the foreground, ping the
  // per-ticket presence endpoint every 10s. The Status column in the inbox
  // reads from /api/helpdesk/presence with an 8s poll, so other agents see
  // the green eye within ~10s and lose it ~25s after the tab blurs (TTL).
  // On unmount or visibility change → away, signal-out via DELETE.
  useEffect(() => {
    const id = ticket?.id;
    if (!id) return;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    function isVisible() {
      return typeof document !== "undefined" && !document.hidden;
    }

    async function beat() {
      if (cancelled || !isVisible()) return;
      try {
        await fetch(`/api/helpdesk/tickets/${id}/presence`, {
          method: "POST",
          credentials: "same-origin",
        });
      } catch {
        /* network blips are fine — next poll will retry */
      }
    }

    async function clear() {
      try {
        await fetch(`/api/helpdesk/tickets/${id}/presence`, {
          method: "DELETE",
          credentials: "same-origin",
          keepalive: true,
        });
      } catch {
        /* ignored */
      }
    }

    function start() {
      if (intervalId) return;
      void beat();
      intervalId = setInterval(beat, 10_000);
    }

    function stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    function onVisibility() {
      if (isVisible()) start();
      else {
        stop();
        void clear();
      }
    }

    if (isVisible()) start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      void clear();
    };
  }, [ticket?.id]);

  // Esc → Back. Only fires when no input/textarea is focused so we don't
  // hijack the composer.
  useEffect(() => {
    if (!showBack || !onBack) return;
    const back = onBack;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      back();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showBack, onBack]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      {/*
       * Global navigation row (eDesk parity):
       *   [← Back] [‹] [›]   ──────  [search ticket inbox]
       *
       * In LIST layout we render Back. In SPLIT layout we don't render Back
       * (the list is already visible) but we keep the prev/next + search so
       * the agent has fast keyboard-free navigation across the whole inbox.
       *
       * Prev/next walk the *currently filtered* ticket list. Disabled when
       * we're at an edge so the agent can see the list boundary without
       * losing their selection.
       */}
      {/*
       * Back / prev / next sized for fast targeting in LIST layout. The agent
       * spends most of their time on this row (one click per ticket triaged)
       * so the controls were bumped from h-7 / 11px / 3.5w icons up to
       * h-9 / 13px / 4w icons. Header bar height grows to h-12 to match.
       */}
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-hairline bg-card/95 px-3 py-1.5 shadow-[0_1px_0_rgb(255_255_255_/_0.03)] backdrop-blur-sm sm:px-4">
        {showBack && onBack && (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-hairline bg-surface px-3 text-[13px] font-medium text-muted-foreground shadow-sm transition-colors hover:border-brand/35 hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 cursor-pointer"
            title="Back to inbox (Esc)"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        )}
        <div className="inline-flex h-9 items-center rounded-md border border-hairline bg-surface shadow-sm">
          <button
            type="button"
            onClick={onPrev}
            disabled={!onPrev || !hasPrev}
            className="inline-flex h-full w-9 items-center justify-center rounded-l-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            title="Previous ticket (↑)"
            aria-label="Previous ticket"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="h-5 w-px bg-hairline" aria-hidden />
          <button
            type="button"
            onClick={onNext}
            disabled={!onNext || !hasNext}
            className="inline-flex h-full w-9 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            title="Next ticket (↓)"
            aria-label="Next ticket"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="mx-1 hidden h-8 w-px shrink-0 bg-hairline sm:block" aria-hidden />
        <div className="min-w-[14rem] flex-1">
          {ticket ? (
            <>
              <h2 className="truncate text-sm font-semibold leading-5 text-foreground sm:text-[15px]">
                {ticket.subject ?? ticket.ebayItemTitle ?? "(no subject)"}
              </h2>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                <span className="truncate font-semibold text-foreground">
                  {ticket.buyerName ?? ticket.buyerUserId ?? "Unknown buyer"}
                </span>
                <span
                  className={cn(
                    "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md border px-1.5 text-[10px] font-semibold",
                    STORE_BADGE_CLASS[ticket.channel] ??
                      "border-hairline bg-surface text-muted-foreground",
                  )}
                  title={ticket.integrationLabel}
                >
                  <img
                    src="/logos/ebay.svg"
                    alt="eBay"
                    width={24}
                    height={11}
                    className="h-2.5 w-auto shrink-0"
                  />
                  {storeDisplayLabel(ticket)}
                </span>
                {ticket.ebayOrderNumber && (
                  <span className="truncate font-medium">
                    Order #{ticket.ebayOrderNumber}
                  </span>
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {loading ? "Loading conversation..." : "No ticket selected."}
            </p>
          )}
        </div>
        <TicketTriageBar
          ticket={ticket}
          onMutated={onSent}
          agentFolders={agentFolders}
          embedded
          className="hidden xl:flex"
        />
        <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
          {ticket?.ebayOrderNumber && (
            <a
              href={`https://www.ebay.com/mesh/ord/details?orderid=${ticket.ebayOrderNumber}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-brand/30 bg-surface px-2 text-[11px] text-muted-foreground shadow-sm transition-colors hover:border-brand/60 hover:bg-brand/10 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 cursor-pointer"
              title="Open this message thread on eBay in a new tab"
            >
              <ExternalLink className="h-3 w-3" /> View message
            </a>
          )}

          {ticket?.ebayItemId && (
            <a
              href={`https://www.ebay.com/itm/${ticket.ebayItemId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 text-[11px] text-muted-foreground shadow-sm transition-colors hover:border-brand/35 hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 cursor-pointer"
              title="Open this item on eBay in a new tab"
            >
              <ExternalLink className="h-3 w-3" /> View item
            </a>
          )}
        </div>
      </div>

      {/* Ticket info row (subject / buyer / channel / order #). */}
      <div className="hidden">
        <div className="min-w-0 flex-1">
          {ticket ? (
            <>
              <h2 className="truncate text-[17px] font-semibold text-foreground">
                {ticket.subject ?? ticket.ebayItemTitle ?? "(no subject)"}
              </h2>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="truncate text-sm font-semibold text-foreground">
                  {ticket.buyerName ?? ticket.buyerUserId ?? "Unknown buyer"}
                </span>
                <span
                  className={cn(
                    "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold",
                    STORE_BADGE_CLASS[ticket.channel] ??
                      "border-hairline bg-surface text-muted-foreground",
                  )}
                  title={ticket.integrationLabel}
                >
                  <img
                    src="/logos/ebay.svg"
                    alt="eBay"
                    width={26}
                    height={12}
                    className="h-3 w-auto shrink-0"
                  />
                  {storeDisplayLabel(ticket)}
                </span>
                {ticket.ebayOrderNumber && (
                  <span className="truncate text-xs font-medium text-muted-foreground">
                    Order #{ticket.ebayOrderNumber}
                  </span>
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {loading ? "Loading conversation…" : "No ticket selected."}
            </p>
          )}
        </div>

        {ticket?.ebayOrderNumber && (
          <a
            href={`https://www.ebay.com/mesh/ord/details?orderid=${ticket.ebayOrderNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden h-8 items-center gap-1 rounded-md border border-brand/30 bg-surface px-2.5 text-[11px] text-muted-foreground shadow-sm transition-colors hover:border-brand/60 hover:bg-brand/10 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 cursor-pointer sm:inline-flex"
            title="Open this message thread on eBay in a new tab"
          >
            <ExternalLink className="h-3 w-3" /> View message
          </a>
        )}

        {ticket?.ebayItemId && (
          <a
            href={`https://www.ebay.com/itm/${ticket.ebayItemId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden h-8 items-center gap-1 rounded-md border border-hairline bg-surface px-2.5 text-[11px] text-muted-foreground shadow-sm transition-colors hover:border-brand/35 hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 cursor-pointer sm:inline-flex"
            title="Open this item on eBay in a new tab"
          >
            <ExternalLink className="h-3 w-3" /> View item
          </a>
        )}
      </div>

      {/*
       * Per-ticket triage bar (eDesk parity). Lives below the ticket info
       * row so it always travels with the active ticket. We render it even
       * when no ticket is selected (controls disable themselves) so the
       * layout doesn't reflow on selection change.
       */}
      <TicketTriageBar
        ticket={ticket}
        onMutated={onSent}
        agentFolders={agentFolders}
        className="xl:hidden"
      />

      {/* Thread + Context split */}
      <div className="flex flex-1 overflow-hidden">
        <HelpdeskSplit
          value={prefs.threadWidthPct}
          onCommit={(pct) => updateHelpdeskPrefs({ threadWidthPct: pct })}
          min={showBack ? 45 : 35}
          max={showBack ? 90 : 75}
          left={
            <ThreadView
              ticket={ticket}
              loading={loading}
              safeMode={safeMode}
              syncStatus={syncStatus}
              onSent={onSent}
              showHeader={false}
            />
          }
          right={
            <ContextPanel ticket={ticket} widthClassName="flex-1 min-w-0" />
          }
        />
      </div>
    </div>
  );
}
