"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LifeBuoy,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Loader2,
  BarChart3,
  Settings,
  Columns,
  List,
  Search,
  X,
} from "lucide-react";
import type { HelpdeskSyncStatus } from "@/hooks/use-helpdesk";
import {
  HelpdeskSettingsDialog,
  updateHelpdeskPrefs,
  useHelpdeskPrefs,
  type HelpdeskLayout,
} from "@/components/helpdesk/HelpdeskSettingsDialog";
import { Avatar, type AvatarUser } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

interface HelpdeskAgent extends AvatarUser {
  /**
   * True when an admin is using "Login as" to view this Help Desk through
   * another user's account. Surfaces as a coloured ring around the avatar.
   */
  impersonating?: boolean;
}

interface HelpdeskHeaderProps {
  syncStatus: HelpdeskSyncStatus | null;
  manualSyncing: boolean;
  onManualSync: () => void;
  /**
   * The currently signed-in agent (or the user being impersonated). Rendered
   * as a small avatar at the right edge of the header so the agent always
   * knows whose mailbox they're working from.
   */
  agent: HelpdeskAgent | null;
  /**
   * Global inbox search. Rendered as a single centered field in the header
   * (one source of truth) — replaces the per-pane search boxes that used to
   * live in TicketList and TicketReader. Searches buyer name/username,
   * eBay order number, subject, and message body server-side.
   */
  search: string;
  onSearchChange: (q: string) => void;
  /**
   * True when the agent is currently reading a single ticket in the
   * reader pane. Used to:
   *   1. Display the search field as blank (the `search` prop is also
   *      passed in as "" by the parent in this state, but we use this
   *      flag to drive the Enter-key behavior below).
   *   2. Treat Enter / Escape inside the search input as a "take me
   *      back to the search results list" action — i.e. close the
   *      ticket and apply the new query atomically. Without this,
   *      submitting a search while reading a ticket would commit
   *      the query but leave the reader open, hiding the result.
   *
   * Optional so existing callers (none) don't break.
   */
  ticketOpen?: boolean;
  /**
   * Invoked when the agent submits a search via Enter while a ticket
   * is open. The parent should deselect the open ticket so the inbox
   * list (with the freshly applied search) becomes visible.
   */
  onCloseTicket?: () => void;
}

function relTime(date: string | null): string {
  if (!date) return "never";
  const ms = Date.now() - new Date(date).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(date).toLocaleString();
}

export function HelpdeskHeader({
  syncStatus,
  manualSyncing,
  onManualSync,
  agent,
  search,
  onSearchChange,
  ticketOpen = false,
  onCloseTicket,
}: HelpdeskHeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const prefs = useHelpdeskPrefs();
  const safeMode = syncStatus?.flags.safeMode ?? true;
  const router = useRouter();
  const pathname = usePathname();

  /**
   * If the agent is on a sub-page (filters / profile / global-settings /
   * dashboard / etc) and submits a search via Enter, we route them back
   * to the main inbox with the query baked into the URL. The list view
   * picks `?q=` up automatically and renders matching tickets.
   */
  function isOnInboxRoot(): boolean {
    return pathname === "/help-desk" || pathname === "/help-desk/";
  }
  function routeToSearchResults(value: string) {
    const trimmed = value.trim();
    const target = trimmed
      ? `/help-desk?q=${encodeURIComponent(trimmed)}`
      : "/help-desk";
    router.push(target);
  }

  /**
   * Local mirror of the search input. Two reasons it lives here:
   *
   *  1. Snappy typing — the controlled `<input>` value comes from local
   *     state, so each keystroke is a single small re-render of just the
   *     header instead of the whole help-desk tree.
   *  2. **Debounced parent commit** — we deliberately do NOT call
   *     `onSearchChange` on every keystroke. The parent's `search` state
   *     drives the prop tree of FolderSidebar / TicketList (all 50 ticket
   *     rows!) / TicketReader / ContextPanel. Notifying the parent on every
   *     keystroke caused a re-render storm that locked up the UI when
   *     typing or deleting (e.g. typing "Apple" then backspacing it
   *     out → 10 full help-desk re-renders).
   *
   * The parent now only hears about the search query 250 ms after the user
   * stops typing. The page-level useHelpdesk hook still adds its own 500 ms
   * debounce on top of that before hitting the network — together they
   * mean common type-then-delete gestures fire ZERO re-renders below the
   * header AND ZERO API calls.
   */
  const [searchLocal, setSearchLocal] = useState(search);
  // Sync external `search` changes (e.g. parent clearing it programmatically
  // after a "go to ticket" deep-link) into the local mirror without firing
  // a debounced notification back up.
  const lastCommittedRef = useRef(search);
  useEffect(() => {
    if (search !== lastCommittedRef.current) {
      lastCommittedRef.current = search;
      setSearchLocal(search);
    }
  }, [search]);

  // Debounced commit — the parent only hears about a search change 250 ms
  // after the user stops typing. We use a ref to track the pending timer
  // so the cleanup function can cancel it on unmount or new keystrokes.
  const commitTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (commitTimerRef.current != null) {
        window.clearTimeout(commitTimerRef.current);
      }
    };
  }, []);
  function scheduleCommit(value: string) {
    if (commitTimerRef.current != null) {
      window.clearTimeout(commitTimerRef.current);
    }
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = null;
      lastCommittedRef.current = value;
      onSearchChange(value);
    }, 250);
  }
  function commitNow(value: string) {
    if (commitTimerRef.current != null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    lastCommittedRef.current = value;
    onSearchChange(value);
  }

  function setLayout(layout: HelpdeskLayout) {
    updateHelpdeskPrefs({ layout });
  }

  const lastTick = syncStatus?.lastTickAt ?? null;
  // Only the message-folder checkpoints (`inbox`, `sent`) actually have a
  // backfill state — they walk back day-by-day until they hit the horizon
  // and then flip `backfillDone=true`. The action-mirror checkpoints
  // (`returns`, `cancellations`, `feedback`) are watermark-sync only; they
  // don't need a backfill flag and were always reading as "in progress",
  // which made this badge stick on forever after the messages were done.
  const backfillInProgress =
    syncStatus?.checkpoints.some(
      (c) => (c.folder === "inbox" || c.folder === "sent") && !c.backfillDone,
    ) ?? false;

  return (
    <div className="flex items-center justify-between border-b border-hairline bg-card/95 px-4 py-2 shadow-[0_1px_0_rgb(255_255_255_/_0.03)] backdrop-blur-sm sm:px-5">
      <div className="flex items-center gap-2">
        <LifeBuoy className="h-5 w-5 text-brand" />
        <h1 className="text-lg font-semibold text-foreground">Help Desk</h1>
        {safeMode ? (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300"
            title="Outbound messages are blocked. Sync, notes, and reads still work."
          >
            <ShieldAlert className="h-3 w-3" /> Safe Mode
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300"
            title="Outbound messages enabled."
          >
            <ShieldCheck className="h-3 w-3" /> Live
          </span>
        )}
        {backfillInProgress && (
          <span className="inline-flex items-center gap-1 rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
            <Loader2 className="h-3 w-3 animate-spin" />
            Backfilling {syncStatus?.backfillDays ?? 60} {(syncStatus?.backfillDays ?? 60) === 1 ? "day" : "days"}
          </span>
        )}
      </div>
      {/*
        Global inbox search — single source of truth. Centered in the header
        so it's always reachable regardless of which layout (split / list)
        or which ticket is open. Submits as you type via `onSearchChange`,
        which the page-level `useHelpdesk` hook debounces.

        SCOPE: searches buyer USERNAME or eBay ORDER NUMBER only. We
        deliberately removed body / subject / item-id matching — agents
        kept stumbling on irrelevant matches (e.g. typing "Apple" surfaced
        every message containing the word "apple" from any thread). The
        server-side route enforces the same restriction; this placeholder
        is just the user-facing contract.
      */}
      <div className="mx-6 hidden max-w-2xl flex-1 md:block">
        <div className="relative mx-auto">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            // type="text" (NOT "search") — `type=search` triggers the browser's
            // built-in clear (×) button, which collided with our custom one
            // and produced a duplicate × in the field.
            type="text"
            value={searchLocal}
            onChange={(e) => {
              const next = e.target.value;
              setSearchLocal(next);
              // While a ticket is open we MUST NOT debounce-commit
              // the search up to the parent — that would deselect
              // the ticket on every keystroke pause (since the parent
              // wraps onSearchChange with selectTicket(null)). Wait
              // for an explicit Enter / Escape / Blur instead.
              if (!ticketOpen) {
                scheduleCommit(next);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                // Submitting the search ALWAYS surfaces the agent in the
                // inbox list view with results — even if they were
                // currently reading a single ticket. Route first, then
                // commit so the list mounts with the query already
                // applied.
                if (!isOnInboxRoot()) {
                  routeToSearchResults(searchLocal);
                  return;
                }
                if (ticketOpen) {
                  onCloseTicket?.();
                }
                commitNow(searchLocal);
              } else if (e.key === "Escape" && searchLocal.length > 0) {
                setSearchLocal("");
                if (!ticketOpen) commitNow("");
              }
            }}
            onBlur={() => {
              // Don't commit on blur while reading a ticket — see the
              // onChange comment above. The user must press Enter to
              // re-enter search mode.
              if (!ticketOpen) commitNow(searchLocal);
            }}
            placeholder="Search by buyer username or eBay Order ID"
            className="h-9 w-full rounded-md border border-hairline bg-surface pl-9 pr-9 text-sm text-foreground shadow-sm placeholder:text-muted-foreground transition-colors focus:border-brand/40 focus:outline-none focus:ring-2 focus:ring-brand/20"
            aria-label="Search inbox by buyer username or eBay Order ID"
          />
          {searchLocal.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setSearchLocal("");
                commitNow("");
              }}
              className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
              title="Clear search"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>Synced {relTime(lastTick)}</span>
        <div
          className="inline-flex h-7 items-center rounded-md border border-hairline bg-surface p-0.5"
          role="group"
          aria-label="Layout"
        >
          <button
            type="button"
            onClick={() => setLayout("split")}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors cursor-pointer",
              prefs.layout === "split"
                ? "bg-surface-2 text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            title="Split layout: ticket list, conversation, and context panel side by side"
          >
            <Columns className="h-3 w-3" /> Split
          </button>
          <button
            type="button"
            onClick={() => setLayout("list")}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors cursor-pointer",
              prefs.layout === "list"
                ? "bg-surface-2 text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            title="List layout: full-width inbox; click a ticket to open it in a reader"
          >
            <List className="h-3 w-3" /> List
          </button>
        </div>
        <Link
          href="/help-desk/dashboard"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 font-medium text-foreground shadow-sm transition-colors hover:border-brand/35 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 cursor-pointer"
        >
          <BarChart3 className="h-3.5 w-3.5" />
          Dashboard
        </Link>
        <button
          type="button"
          onClick={onManualSync}
          disabled={manualSyncing}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 font-medium text-foreground shadow-sm transition-colors hover:border-brand/35 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
        >
          {manualSyncing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Sync now
        </button>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 font-medium text-foreground shadow-sm transition-colors hover:border-brand/35 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 cursor-pointer"
          aria-label="Help Desk preferences"
          title="Preferences"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        {agent && (
          <Link
            href="/help-desk/profile"
            className="ml-1 flex items-center gap-2 rounded-md border border-hairline bg-surface px-1.5 py-0.5 text-foreground shadow-sm transition-colors hover:border-brand/35 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 cursor-pointer"
            title={
              agent.impersonating
                ? `Acting as ${agent.name ?? agent.email ?? "user"} (impersonating). Click to view profile.`
                : `Signed in as ${agent.name ?? agent.email ?? "user"}. Click to edit profile.`
            }
            aria-label="Open agent profile"
          >
            <Avatar
              user={agent}
              size="sm"
              ring={agent.impersonating}
              className={cn(
                agent.impersonating && "ring-2 ring-amber-500/70",
              )}
            />
            <span className="hidden max-w-[10rem] truncate text-[11px] font-medium text-foreground sm:inline">
              {agent.name ?? agent.handle ?? agent.email ?? "Agent"}
            </span>
          </Link>
        )}
      </div>
      <HelpdeskSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
