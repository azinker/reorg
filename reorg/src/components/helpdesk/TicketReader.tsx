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
import {
  useHelpdeskPrefs,
  updateHelpdeskPrefs,
} from "@/components/helpdesk/HelpdeskSettingsDialog";
import type {
  HelpdeskTicketDetail,
  HelpdeskSyncStatus,
} from "@/hooks/use-helpdesk";

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
}: TicketReaderProps) {
  const prefs = useHelpdeskPrefs();

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
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline bg-card px-3 sm:px-4">
        {showBack && onBack && (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
            title="Back to inbox (Esc)"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </button>
        )}
        <div className="inline-flex h-7 items-center rounded-md border border-hairline bg-surface">
          <button
            type="button"
            onClick={onPrev}
            disabled={!onPrev || !hasPrev}
            className="inline-flex h-full w-7 items-center justify-center rounded-l-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            title="Previous ticket (↑)"
            aria-label="Previous ticket"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <div className="h-4 w-px bg-hairline" aria-hidden />
          <button
            type="button"
            onClick={onNext}
            disabled={!onNext || !hasNext}
            className="inline-flex h-full w-7 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            title="Next ticket (↓)"
            aria-label="Next ticket"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Ticket info row (subject / buyer / channel / order #). */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-card px-3 sm:px-4">
        <div className="min-w-0 flex-1">
          {ticket ? (
            <>
              <h2 className="truncate text-sm font-semibold text-foreground">
                {ticket.subject ?? ticket.ebayItemTitle ?? "(no subject)"}
              </h2>
              <p className="truncate text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">
                  {ticket.buyerName ?? ticket.buyerUserId ?? "Unknown buyer"}
                </span>
                <span className="px-1.5 text-muted-foreground/60">·</span>
                {ticket.integrationLabel}
                {ticket.ebayOrderNumber && (
                  <>
                    <span className="px-1.5 text-muted-foreground/60">·</span>
                    Order #{ticket.ebayOrderNumber}
                  </>
                )}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {loading ? "Loading conversation…" : "No ticket selected."}
            </p>
          )}
        </div>

        {ticket?.ebayItemId && (
          <a
            href={`https://www.ebay.com/itm/${ticket.ebayItemId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden h-8 items-center gap-1 rounded-md border border-hairline bg-surface px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer sm:inline-flex"
            title="Open this item on eBay in a new tab"
          >
            <ExternalLink className="h-3 w-3" /> View item
          </a>
        )}
      </div>

      {/* Thread + Context split */}
      <div className="flex flex-1 overflow-hidden">
        <HelpdeskSplit
          value={prefs.threadWidthPct}
          onCommit={(pct) => updateHelpdeskPrefs({ threadWidthPct: pct })}
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
