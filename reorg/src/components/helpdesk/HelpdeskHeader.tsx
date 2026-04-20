"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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
}: HelpdeskHeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const prefs = useHelpdeskPrefs();
  const safeMode = syncStatus?.flags.safeMode ?? true;

  // Local mirror so typing stays snappy even though the parent re-renders the
  // ticket list on every keystroke. We still notify the parent immediately —
  // it debounces server fetches itself in `use-helpdesk`.
  const [searchLocal, setSearchLocal] = useState(search);
  useEffect(() => {
    setSearchLocal(search);
  }, [search]);

  function setLayout(layout: HelpdeskLayout) {
    updateHelpdeskPrefs({ layout });
  }

  const lastTick = syncStatus?.lastTickAt ?? null;
  const backfillInProgress = syncStatus?.checkpoints.some((c) => !c.backfillDone) ?? false;

  return (
    <div className="flex items-center justify-between border-b border-hairline bg-card px-5 py-3">
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
            Backfilling 180 days
          </span>
        )}
      </div>
      {/*
        Global inbox search — single source of truth. Centered in the header
        so it's always reachable regardless of which layout (split / list)
        or which ticket is open. Submits as you type via `onSearchChange`,
        which the page-level `useHelpdesk` hook debounces.
      */}
      <div className="mx-6 hidden max-w-md flex-1 md:block">
        <div className="relative mx-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={searchLocal}
            onChange={(e) => {
              setSearchLocal(e.target.value);
              onSearchChange(e.target.value);
            }}
            placeholder="Search buyer, order #, or message…"
            className="h-8 w-full rounded-md border border-hairline bg-surface pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus:border-brand/40 focus:outline-none focus:ring-2 focus:ring-brand/20"
            aria-label="Search inbox"
          />
          {searchLocal.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setSearchLocal("");
                onSearchChange("");
              }}
              className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
              title="Clear search"
              aria-label="Clear search"
            >
              <X className="h-3 w-3" />
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
          className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 font-medium text-foreground transition-colors hover:bg-surface-2 cursor-pointer"
        >
          <BarChart3 className="h-3.5 w-3.5" />
          Dashboard
        </Link>
        <button
          type="button"
          onClick={onManualSync}
          disabled={manualSyncing}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 font-medium text-foreground transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
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
          className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 font-medium text-foreground transition-colors hover:bg-surface-2 cursor-pointer"
          aria-label="Help Desk preferences"
          title="Preferences"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        {agent && (
          <Link
            href="/help-desk/profile"
            className="ml-1 flex items-center gap-2 rounded-md border border-hairline bg-surface px-1.5 py-0.5 text-foreground transition-colors hover:bg-surface-2 cursor-pointer"
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
