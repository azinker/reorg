"use client";

/**
 * TicketTriageBar — per-ticket action header.
 *
 *   [Type ▾] [💤 Snooze] [✓ Resolve] [📦 Archive] [⚠ Spam] [⋯] [👤 Assign ▾]
 *
 * Sits between the ticket info row and the thread. Optimistic UX: we fire
 * the mutation, then call `onMutated()` so the parent (HelpDeskClient) can
 * invalidate the list/detail cache.
 *
 * All actions go through the existing batch endpoint so audit logging,
 * permission checks, and folder routing stay in one place. Snooze flips
 * to the dedicated /snooze route (its own audit path).
 *
 * NB: there is intentionally NO "New Ticket" button here. reorG only
 * responds to messages eBay syncs into the system — we never originate a
 * conversation, and eBay's API doesn't even support agent-initiated
 * threads. The earlier eDesk-style placeholder for this was removed at
 * Adam's request once he confirmed it'd never light up.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Clock,
  MoreHorizontal,
  Star,
  ChevronDown,
  CircleCheck,
  Flag,
  UserPlus,
  Check,
  Loader2,
  FolderInput,
  Inbox,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  HelpdeskTicketDetail,
  HelpdeskTicketType,
} from "@/hooks/use-helpdesk";
import {
  FOLDER_LABELS,
  deriveTicketFolder,
} from "@/lib/helpdesk/folder-display";

const TYPE_LABELS: Record<HelpdeskTicketType, string> = {
  QUERY: "Query",
  PRE_SALES: "Pre-sales",
  RETURN_REQUEST: "Return Request",
  ITEM_NOT_RECEIVED: "Item Not Received",
  NEGATIVE_FEEDBACK: "Negative Feedback",
  REFUND: "Refund",
  SHIPPING_QUERY: "Shipping Query",
  CANCELLATION: "Cancellation",
  SYSTEM: "System",
  OTHER: "Other",
};

const TYPE_ORDER: HelpdeskTicketType[] = [
  "QUERY",
  "PRE_SALES",
  "RETURN_REQUEST",
  "ITEM_NOT_RECEIVED",
  "NEGATIVE_FEEDBACK",
  "REFUND",
  "SHIPPING_QUERY",
  "CANCELLATION",
  // SYSTEM was previously omitted here because the type is set automatically
  // by ingest for eBay system notifications (return opened, payout sent, …)
  // and we didn't want agents to hand-pick it. But if an agent accidentally
  // picks another type on a SYSTEM ticket to test something, they need a
  // way to put it back — so we expose it. Ingest still sets it automatically
  // for inbound; this dropdown just lets an agent correct a miscategorised row.
  "SYSTEM",
  "OTHER",
];

// Snooze presets (label → minutes from now). null = custom (we drop in a
// 7d default for now; a date picker can land later).
const SNOOZE_PRESETS: Array<{ id: string; label: string; minutes: number }> = [
  { id: "1h", label: "1 hour", minutes: 60 },
  { id: "3h", label: "3 hours", minutes: 60 * 3 },
  { id: "tomorrow", label: "Tomorrow morning", minutes: 60 * 16 },
  { id: "2d", label: "2 days", minutes: 60 * 24 * 2 },
  { id: "1w", label: "1 week", minutes: 60 * 24 * 7 },
];

interface AgentOption {
  id: string;
  name: string | null;
  email: string;
  avatarUrl?: string | null;
}

interface AgentFolderOption {
  id: string;
  name: string;
  color: string;
}

interface TicketTriageBarProps {
  ticket: HelpdeskTicketDetail | null;
  onMutated: () => void;
  agentFolders?: AgentFolderOption[];
  embedded?: boolean;
  className?: string;
}

export function TicketTriageBar({
  ticket,
  onMutated,
  agentFolders = [],
  embedded = false,
  className,
}: TicketTriageBarProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Transient "just-succeeded" pulse keyed by action label. Drives the
  // brief checkmark swap on the Archive / Resolve icons so the agent gets
  // immediate visual confirmation that the click registered, then the
  // button settles back into its normal state once the inbox refresh
  // pulls in the new ticket flags. ~1.5s feels right — long enough to
  // notice, short enough not to block a follow-up click.
  const [justDone, setJustDone] = useState<string | null>(null);
  useEffect(() => {
    if (!justDone) return;
    const t = setTimeout(() => setJustDone(null), 1500);
    return () => clearTimeout(t);
  }, [justDone]);

  // Live agent list (lazy — only fetched when the assign menu opens once).
  const [agents, setAgents] = useState<AgentOption[] | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);

  async function loadAgents() {
    if (agents !== null || agentsLoading) return;
    setAgentsLoading(true);
    try {
      const res = await fetch("/api/helpdesk/agents", { cache: "no-store" });
      if (!res.ok) throw new Error(`agents ${res.status}`);
      const j = (await res.json()) as { data?: AgentOption[] };
      setAgents(j.data ?? []);
    } catch (e) {
      setAgents([]);
      setError(e instanceof Error ? e.message : "Failed to load agents");
    } finally {
      setAgentsLoading(false);
    }
  }

  async function runBatch(action: Record<string, unknown>, label: string) {
    if (!ticket) return;
    setBusy(label);
    setError(null);
    try {
      const res = await fetch("/api/helpdesk/tickets/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketIds: [ticket.id], ...action }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(j.error?.message ?? `Failed (${res.status})`);
      }
      setJustDone(label);
      onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function snooze(minutes: number | null) {
    if (!ticket) return;
    setBusy("snooze");
    setError(null);
    try {
      // Pass null = clear snooze. Otherwise UTC ISO string for `until`.
      const until = minutes
        ? new Date(Date.now() + minutes * 60_000).toISOString()
        : null;
      const res = await fetch(
        `/api/helpdesk/tickets/${ticket.id}/snooze`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ until }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(j.error?.message ?? `Failed (${res.status})`);
      }
      onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Snooze failed");
    } finally {
      setBusy(null);
    }
  }

  const disabled = !ticket || busy !== null;

  // Toolbar strip — subtle brand-tinted gradient anchors the row so the
  // agent reads it as a distinct "command bar" rather than a continuation
  // of the message list. The tint is intentionally faint (≤8% alpha) so
  // it never competes with the action buttons themselves.
  return (
    <div
      className={cn(
        embedded
          ? "flex min-w-0 shrink-0 flex-wrap items-center gap-1.5"
          : "flex min-h-10 shrink-0 flex-wrap items-center gap-1.5 border-b border-hairline bg-card/90 px-3 py-1.5 shadow-[0_1px_0_rgb(255_255_255_/_0.03)] backdrop-blur-sm sm:px-4",
        className,
      )}
    >
      <TypeMenu
        value={ticket?.type ?? null}
        disabled={disabled}
        onPick={(t) =>
          runBatch({ action: "setType", type: t }, "type")
        }
      />

      <SnoozeMenu
        snoozedUntil={ticket?.snoozedUntil ?? null}
        disabled={disabled}
        onPick={snooze}
      />

      {/* Resolve — close the loop on a ticket with no further buyer action
          expected. Toggles RESOLVED ↔ TO_DO (clicking again on a resolved
          ticket reopens it). A buyer reply on a RESOLVED ticket bounces
          it back to TO_DO via deriveStatusOnInbound, so this button is
          safe even if the buyer ends up writing back. */}
      {(() => {
        const isResolved = ticket?.status === "RESOLVED";
        const justResolved = justDone === "resolve";
        return (
          <IconButton
            title={
              isResolved
                ? "Resolved — click to reopen as To Do"
                : "Mark as Resolved (closes the conversation; buyer reply will bounce it back to To Do)"
            }
            disabled={disabled}
            active={isResolved}
            success={justResolved}
            accent="emerald"
            label={isResolved ? "Reopen" : "Resolve"}
            onClick={() =>
              runBatch(
                {
                  action: "setStatus",
                  status: isResolved ? "TO_DO" : "RESOLVED",
                },
                "resolve",
              )
            }
          >
            {justResolved ? (
              <Check className="h-4 w-4" />
            ) : (
              <CircleCheck className="h-4 w-4" />
            )}
          </IconButton>
        );
      })()}

      {/* Archive — agent decision that this ticket will never need a
          response (auto-responder confirmation, junk-but-not-spam, eBay
          system noise). Toggles isArchived. As with Resolve, a buyer
          reply will bounce it back out to To Do automatically. */}
      {(() => {
        const isArchived = !!ticket?.isArchived;
        const justArchived = justDone === "archive";
        return (
          <IconButton
            title={
              isArchived
                ? "Archived — click to unarchive"
                : "Archive (moves to Archived; buyer reply will bounce it back to To Do)"
            }
            disabled={disabled}
            active={isArchived}
            success={justArchived}
            accent="violet"
            label={isArchived ? "Unarchive" : "Archive"}
            onClick={() =>
              runBatch(
                { action: "archive", isArchived: !isArchived },
                "archive",
              )
            }
          >
            {justArchived ? (
              <Check className="h-4 w-4" />
            ) : (
              <Archive className="h-4 w-4" />
            )}
          </IconButton>
        );
      })()}

      <IconButton
        title="Mark as spam"
        disabled={disabled}
        active={ticket?.status === "SPAM"}
        accent="red"
        label={ticket?.status === "SPAM" ? "Not Spam" : "Spam"}
        onClick={() =>
          runBatch(
            { action: "markSpam", isSpam: ticket?.status !== "SPAM" },
            "spam",
          )
        }
      >
        <AlertTriangle className="h-4 w-4" />
      </IconButton>

      <MoreMenu
        ticket={ticket}
        disabled={disabled}
        onToggleFavorite={() =>
          runBatch(
            { action: "setFavorite", isFavorite: !ticket?.isFavorite },
            "favorite",
          )
        }
        onToggleImportant={() =>
          runBatch(
            { action: "setImportant", isImportant: !ticket?.isImportant },
            "important",
          )
        }
      />

      <AssignMenu
        ticket={ticket}
        agents={agents}
        agentsLoading={agentsLoading}
        disabled={disabled}
        onOpen={loadAgents}
        onPick={(userId) =>
          runBatch({ action: "assignPrimary", userId }, "assign")
        }
      />

      <MoveToFolderMenu
        currentFolderId={ticket?.agentFolderId ?? null}
        folders={agentFolders}
        disabled={disabled}
        onPick={(folderId) =>
          runBatch({ action: "moveToFolder", agentFolderId: folderId }, "moveToFolder")
        }
      />

      {busy && (
        <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Saving…
        </span>
      )}
      {error && !busy && (
        <span
          className="ml-2 truncate text-xs text-red-600 dark:text-red-300"
          title={error}
        >
          {error}
        </span>
      )}

      {/* Right-anchored "in <folder>" pill — derived from the ticket's
          own state (not the currently selected sidebar folder) so an
          agent arriving via deep-link or search still sees where this
          ticket actually lives. Also acts as the read/unread control:
          opens a dropdown with Mark as Read / Mark as Unread, defaulted
          to the current state. Works on any ticket (not just the "To
          Do · Read" bucket) so an agent can re-flag a Waiting or
          Archived ticket as unread without leaving the thread. */}
      <CurrentFolderPill
        ticket={ticket}
        disabled={disabled}
        busy={busy === "markRead"}
        pushRight={!embedded}
        onMarkRead={(isRead) =>
          runBatch({ action: "markRead", isRead }, "markRead")
        }
      />
    </div>
  );
}

// ─── Current-folder pill + read/unread dropdown ─────────────────────────────

/**
 * The "in <folder>" pill doubles as the per-ticket read/unread control.
 *
 * Why combine these two things:
 *   The folder label already encodes read state for the two "To Do"
 *   sub-buckets ("To Do · Read" / "To Do · Unread"). Splitting a second
 *   control off would duplicate that signal and eat toolbar real estate,
 *   so we fold the toggle into the same affordance — the label shows
 *   where the ticket currently sits, and the dropdown exposes the one
 *   state flip (read/unread) that can change that.
 *
 * Works for any ticket (not just To Do) because read/unread is
 * independent of folder routing: an agent may want to re-flag a
 * Waiting, Archived, or Resolved ticket as unread to pull it back onto
 * their radar even though its folder doesn't change.
 *
 * The small dot after the label mirrors the unread indicator shown in
 * the TicketTable "Latest Update" column — filled brand-coral = unread,
 * hollow ring = read. Keeps the affordance scannable without opening
 * the menu.
 *
 * Mirrors to eBay automatically: the markRead batch action invokes
 * mirrorReadStateToEbay under the hood (gated by
 * effectiveCanSyncReadState + safe mode), so toggling here keeps the
 * eBay web UI in lockstep.
 */
function CurrentFolderPill({
  ticket,
  disabled,
  busy,
  pushRight = true,
  onMarkRead,
}: {
  ticket: HelpdeskTicketDetail | null;
  disabled: boolean;
  busy: boolean;
  pushRight?: boolean;
  onMarkRead: (isRead: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const folderKey = useMemo(() => {
    if (!ticket) return null;
    return deriveTicketFolder({
      status: ticket.status,
      isArchived: ticket.isArchived,
      isSpam: ticket.isSpam,
      type: ticket.type,
      kind: ticket.kind,
      snoozedUntil: ticket.snoozedUntil,
      unreadCount: ticket.unreadCount,
      tags: ticket.tags,
    });
  }, [ticket]);

  if (!folderKey || !ticket) return null;

  const label = FOLDER_LABELS[folderKey];
  const display =
    folderKey === "all_to_do_unread"
      ? "To Do · Unread"
      : folderKey === "all_to_do_awaiting"
        ? "To Do · Read"
        : label;
  const isUnread = ticket.unreadCount > 0;

  return (
    <div ref={ref} className={cn("relative", pushRight && "ml-auto")}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-hairline bg-surface/60 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:border-brand/60 hover:bg-brand/10 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer",
          open && "border-brand/60 bg-brand/15 text-brand",
        )}
        title={`This ticket is in "${display}". Click to mark as ${
          isUnread ? "read" : "unread"
        }.`}
      >
        <Inbox className="h-3.5 w-3.5 opacity-70" />
        <span className="text-muted-foreground/80">in</span>
        <span className="text-foreground">{display}</span>
        <span
          className={cn(
            "ml-0.5 h-1.5 w-1.5 rounded-full",
            isUnread
              ? "bg-brand"
              : "border border-muted-foreground/50 bg-transparent",
          )}
          aria-hidden
        />
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-44 rounded-md border border-hairline bg-popover p-1 text-popover-foreground shadow-xl">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (isUnread) onMarkRead(true);
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-surface-2 cursor-pointer",
              !isUnread && "bg-surface-2 font-medium",
            )}
          >
            <span className="inline-flex items-center gap-2">
              <span
                className="h-1.5 w-1.5 rounded-full border border-muted-foreground/50"
                aria-hidden
              />
              Mark as Read
            </span>
            {!isUnread && <Check className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!isUnread) onMarkRead(false);
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-surface-2 cursor-pointer",
              isUnread && "bg-surface-2 font-medium",
            )}
          >
            <span className="inline-flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
              Mark as Unread
            </span>
            {isUnread && <Check className="h-3.5 w-3.5" />}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Type pill (Query ▾) ────────────────────────────────────────────────────

function TypeMenu({
  value,
  disabled,
  onPick,
}: {
  value: HelpdeskTicketType | null;
  disabled: boolean;
  onPick: (t: HelpdeskTicketType) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const label = value ? TYPE_LABELS[value] : "Query";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className={cn(
          // Brand-accented anchor for the toolbar — this is the agent's
          // primary identity classifier for the ticket so we paint it in
          // the reorG brand color (coral). Same hover/active rhythm as
          // the IconButton accent system below for visual consistency.
          "inline-flex h-8 items-center gap-1.5 rounded-md border border-brand/30 bg-surface px-2.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:border-brand/60 hover:bg-brand/10 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer",
          open && "border-brand/60 bg-brand/15 text-brand",
        )}
        title="Change ticket type"
      >
        {label}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-56 rounded-md border border-hairline bg-popover p-1 text-popover-foreground shadow-xl">
          {TYPE_ORDER.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                onPick(t);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-surface-2 cursor-pointer",
                value === t && "bg-surface-2 font-medium",
              )}
            >
              {TYPE_LABELS[t]}
              {value === t ? <Check className="h-3.5 w-3.5" /> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Snooze ─────────────────────────────────────────────────────────────────

function SnoozeMenu({
  snoozedUntil,
  disabled,
  onPick,
}: {
  snoozedUntil: string | null;
  disabled: boolean;
  onPick: (minutes: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const isSnoozed = !!snoozedUntil;

  return (
    <div ref={ref} className="relative">
      <IconButton
        title={isSnoozed ? "Snoozed — click to change" : "Snooze ticket"}
        disabled={disabled}
        active={isSnoozed}
        accent="amber"
        label={isSnoozed ? "Snoozed" : "Snooze"}
        onClick={() => setOpen((v) => !v)}
      >
        <Clock className="h-4 w-4" />
      </IconButton>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-52 rounded-md border border-hairline bg-popover p-1 text-popover-foreground shadow-xl">
          {SNOOZE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onPick(p.minutes);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-surface-2 cursor-pointer"
            >
              {p.label}
            </button>
          ))}
          {isSnoozed && (
            <>
              <div className="my-1 h-px bg-hairline" aria-hidden />
              <button
                type="button"
                onClick={() => {
                  onPick(null);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs text-red-600 hover:bg-surface-2 dark:text-red-300 cursor-pointer"
              >
                Wake now
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── More (⋯) — Favorite + Important ────────────────────────────────────────

function MoreMenu({
  ticket,
  disabled,
  onToggleFavorite,
  onToggleImportant,
}: {
  ticket: HelpdeskTicketDetail | null;
  disabled: boolean;
  onToggleFavorite: () => void;
  onToggleImportant: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <IconButton
        title="More actions"
        disabled={disabled}
        active={open}
        accent="violet"
        label="More"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </IconButton>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-44 rounded-md border border-hairline bg-popover p-1 text-popover-foreground shadow-xl">
          <button
            type="button"
            onClick={() => {
              onToggleFavorite();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-surface-2 cursor-pointer"
          >
            <Star
              className={cn(
                "h-3.5 w-3.5",
                ticket?.isFavorite
                  ? "fill-amber-500 text-amber-500"
                  : "text-muted-foreground",
              )}
            />
            {ticket?.isFavorite ? "Unfavorite" : "Favorite"}
          </button>
          <button
            type="button"
            onClick={() => {
              onToggleImportant();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-surface-2 cursor-pointer"
          >
            <Flag
              className={cn(
                "h-3.5 w-3.5",
                ticket?.isImportant
                  ? "fill-red-500 text-red-500"
                  : "text-muted-foreground",
              )}
            />
            {ticket?.isImportant ? "Clear important" : "Mark important"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Assign user ────────────────────────────────────────────────────────────

function AssignMenu({
  ticket,
  agents,
  agentsLoading,
  disabled,
  onOpen,
  onPick,
}: {
  ticket: HelpdeskTicketDetail | null;
  agents: AgentOption[] | null;
  agentsLoading: boolean;
  disabled: boolean;
  onOpen: () => void;
  onPick: (userId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const assigned = ticket?.primaryAssignee ?? null;
  const assignedId = assigned?.id ?? null;
  const assignedName =
    assigned?.name ?? assigned?.handle ?? assigned?.email ?? "Assigned";

  return (
    <div ref={ref} className="relative">
      <IconButton
        title={assignedId ? `Assigned to ${assignedName}. Click to reassign.` : "Assign to user"}
        disabled={disabled}
        active={!!assignedId}
        accent="brand"
        label={assignedId ? assignedName : "Assign"}
        onClick={() => {
          if (disabled) return;
          onOpen();
          setOpen((v) => !v);
        }}
      >
        {assigned ? (
          <AgentAvatar name={assignedName} url={assigned.avatarUrl ?? null} />
        ) : (
          <UserPlus className="h-4 w-4" />
        )}
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-60 rounded-md border border-hairline bg-popover p-1 text-popover-foreground shadow-xl">
          {agentsLoading && (
            <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading agents…
            </div>
          )}
          {!agentsLoading && agents && agents.length === 0 && (
            <div className="px-2.5 py-2 text-xs text-muted-foreground">
              No agents available.
            </div>
          )}
          {!agentsLoading &&
            agents &&
            agents.map((a) => {
              const name = a.name ?? a.email;
              const isCurrent = assignedId === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    onPick(a.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-surface-2 cursor-pointer",
                    isCurrent && "bg-surface-2 font-medium",
                  )}
                >
                  <AgentAvatar name={name} url={a.avatarUrl ?? null} />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  {isCurrent && <Check className="h-3.5 w-3.5" />}
                </button>
              );
            })}
          {assignedId && (
            <>
              <div className="my-1 h-px bg-hairline" aria-hidden />
              <button
                type="button"
                onClick={() => {
                  onPick(null);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-red-600 hover:bg-surface-2 dark:text-red-300 cursor-pointer"
              >
                Unassign
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AgentAvatar({ name, url }: { name: string; url: string | null }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={url}
        alt={name}
        className="h-5 w-5 rounded-full object-cover"
      />
    );
  }
  const initials =
    name
      .split(/\s+/)
      .map((s) => s[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?";
  return (
    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">
      {initials}
    </div>
  );
}

// ─── Move to Agent Folder ────────────────────────────────────────────────────

const FOLDER_COLORS: Record<string, string> = {
  violet: "bg-violet-500",
  blue: "bg-blue-500",
  green: "bg-green-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  pink: "bg-pink-500",
  cyan: "bg-cyan-500",
  orange: "bg-orange-500",
};

function MoveToFolderMenu({
  currentFolderId,
  folders,
  disabled,
  onPick,
}: {
  currentFolderId: string | null;
  folders: AgentFolderOption[];
  disabled: boolean;
  onPick: (folderId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const currentFolder = currentFolderId
    ? folders.find((f) => f.id === currentFolderId) ?? null
    : null;

  return (
    <div ref={ref} className="relative">
      <IconButton
        title={currentFolderId ? "Move to different folder" : "Move to folder"}
        disabled={disabled}
        active={!!currentFolderId}
        accent="violet"
        label={currentFolder?.name ?? "Folder"}
        onClick={() => setOpen((v) => !v)}
      >
        <FolderInput className="h-4 w-4" />
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-52 rounded-md border border-hairline bg-popover p-1 text-popover-foreground shadow-xl">
          {folders.length === 0 && (
            <div className="px-2.5 py-2 text-xs text-muted-foreground">
              No agent folders yet.
            </div>
          )}
          {folders.map((f) => {
            const isCurrent = currentFolderId === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  onPick(f.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-surface-2 cursor-pointer",
                  isCurrent && "bg-surface-2 font-medium",
                )}
              >
                <span
                  className={cn(
                    "h-2.5 w-2.5 shrink-0 rounded-full",
                    FOLDER_COLORS[f.color] ?? "bg-violet-500",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                {isCurrent && <Check className="h-3.5 w-3.5" />}
              </button>
            );
          })}
          {currentFolderId && (
            <>
              <div className="my-1 h-px bg-hairline" aria-hidden />
              <button
                type="button"
                onClick={() => {
                  onPick(null);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-red-600 hover:bg-surface-2 dark:text-red-300 cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
                Remove from folder
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Generic icon button used by snooze/spam/more/assign ────────────────────

/**
 * Per-action accent palette. We map each toolbar action to a reorG theme
 * color so the row reads as a chord (warm primary on the left, cool/cancel
 * on the right) instead of a uniform grey strip:
 *
 *   brand   — primary identity (Type pill, Assign menu trigger). Coral.
 *   amber   — caution / "wait" (Snooze).
 *   emerald — success / done   (Resolve).
 *   violet  — organizational   (Archive, More menu).
 *   red     — danger / refusal (Spam).
 *
 * Each accent has THREE state classes:
 *   • hover   — paints when the button is idle but the cursor is over it.
 *               Subtle tinted bg + colored icon, no border change.
 *   • active  — sticky state when the underlying flag is true (ticket is
 *               currently snoozed/resolved/archived/spam/assigned). Slightly
 *               heavier bg + colored border so the agent can scan the row
 *               and see at a glance "this ticket is archived" without
 *               opening any menus.
 *   • base    — colored border tint at rest, kept very faint (≤25% alpha)
 *               so the toolbar still looks calm, not Christmas-tree-y.
 */
type IconAccent = "brand" | "amber" | "emerald" | "violet" | "red";

const ACCENT_BASE: Record<IconAccent, string> = {
  brand:
    "border-brand/30 hover:border-brand/60 hover:bg-brand/10 hover:text-brand",
  amber:
    "border-amber-500/30 hover:border-amber-500/60 hover:bg-amber-500/10 hover:text-amber-500",
  emerald:
    "border-emerald-500/30 hover:border-emerald-500/60 hover:bg-emerald-500/10 hover:text-emerald-500",
  violet:
    "border-violet-500/30 hover:border-violet-500/60 hover:bg-violet-500/10 hover:text-violet-500",
  red: "border-red-500/30 hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-500",
};

const ACCENT_ACTIVE: Record<IconAccent, string> = {
  brand: "border-brand/60 bg-brand/15 text-brand",
  amber:
    "border-amber-500/60 bg-amber-500/15 text-amber-600 dark:text-amber-300",
  emerald:
    "border-emerald-500/60 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  violet:
    "border-violet-500/60 bg-violet-500/15 text-violet-600 dark:text-violet-300",
  red: "border-red-500/60 bg-red-500/15 text-red-600 dark:text-red-300",
};

function IconButton({
  title,
  label,
  active,
  success,
  disabled,
  accent = "brand",
  onClick,
  children,
}: {
  title: string;
  label?: string;
  active?: boolean;
  /**
   * When true, the button paints a brief green-tinted ring to confirm the
   * last action landed. The parent owns the timing (clears after ~1.5s).
   * Independent from `active` so the "success" pulse can fire even on a
   * toggle-off (un-archive, un-resolve) where `active` switches false.
   * Always renders in emerald regardless of the action's resting accent —
   * the pulse is a universal "done" signal so the agent learns one shape.
   */
  success?: boolean;
  disabled?: boolean;
  /**
   * Theme accent for this action. See ACCENT_BASE/ACCENT_ACTIVE above for
   * the per-color hover + sticky styling. Defaults to brand for symmetry
   * with the type pill / assign trigger.
   */
  accent?: IconAccent;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border bg-surface text-muted-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer",
        label
          ? "w-auto min-w-0 px-2.5 text-[12px] font-medium"
          : "w-8",
        // Resting accent: faint colored border + tinted hover. Becomes the
        // dominant style only when the agent hovers, so the toolbar still
        // looks calm at rest.
        ACCENT_BASE[accent],
        // Sticky active state: ticket currently has this flag set
        // (snoozed/resolved/archived/spam/assigned). Wins over hover so a
        // resolved ticket stays green even after the cursor leaves.
        active && ACCENT_ACTIVE[accent],
        // Universal "just succeeded" pulse — always emerald regardless of
        // the action's resting accent. Wins over both base and active so
        // the agent sees a consistent "done" signal across every button.
        success &&
          "border-emerald-500/60 bg-emerald-500/15 text-emerald-600 ring-2 ring-emerald-500/30 dark:text-emerald-300",
      )}
    >
      {children}
      {label ? <span className="max-w-[9rem] truncate">{label}</span> : null}
    </button>
  );
}
