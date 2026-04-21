"use client";

/**
 * TicketTriageBar — eDesk-style per-ticket header.
 *
 *   [+ New Ticket ▾] [Type ▾] · [💤] [⚠ Spam] [⋯] [👤 Assign ▾]
 *
 * Sits between the ticket info row and the thread. Optimistic UX: we fire
 * the mutation, then call `onMutated()` so the parent (HelpDeskClient) can
 * invalidate the list/detail cache.
 *
 * All actions go through the existing batch endpoint so audit logging,
 * permission checks, and folder routing stay in one place. Snooze flips
 * to the dedicated /snooze route (its own audit path).
 */

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Clock,
  MoreHorizontal,
  Plus,
  Star,
  ChevronDown,
  Flag,
  UserPlus,
  Check,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  HelpdeskTicketDetail,
  HelpdeskTicketType,
} from "@/hooks/use-helpdesk";

const TYPE_LABELS: Record<HelpdeskTicketType, string> = {
  QUERY: "Query",
  PRE_SALES: "Pre-sales",
  RETURN_REQUEST: "Return Request",
  ITEM_NOT_RECEIVED: "Item Not Received",
  NEGATIVE_FEEDBACK: "Negative Feedback",
  REFUND: "Refund",
  SHIPPING_QUERY: "Shipping Query",
  CANCELLATION: "Cancellation",
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

interface TicketTriageBarProps {
  ticket: HelpdeskTicketDetail | null;
  onMutated: () => void;
  /**
   * Hook for the host to open its "compose new ticket" dialog. We don't
   * own that dialog yet; for now the button is rendered disabled if no
   * handler is supplied.
   */
  onNewTicket?: () => void;
}

export function TicketTriageBar({
  ticket,
  onMutated,
  onNewTicket,
}: TicketTriageBarProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-hairline bg-card px-3 sm:px-4">
      {/* New Ticket button — wraps eventual compose dialog. */}
      <button
        type="button"
        onClick={onNewTicket}
        disabled={!onNewTicket}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
        title="Create a new ticket"
      >
        <Plus className="h-3.5 w-3.5" />
        New Ticket
      </button>

      <div className="mx-1 h-5 w-px bg-hairline" aria-hidden />

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

      <IconButton
        title="Mark as spam"
        disabled={disabled}
        active={ticket?.status === "SPAM"}
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
          "inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer",
          open && "bg-surface-2",
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

  const assignedId = ticket?.primaryAssignee?.id ?? null;

  return (
    <div ref={ref} className="relative">
      <IconButton
        title={assignedId ? "Reassign ticket" : "Assign to user"}
        disabled={disabled}
        active={!!assignedId}
        onClick={() => {
          if (disabled) return;
          onOpen();
          setOpen((v) => !v);
        }}
      >
        <UserPlus className="h-4 w-4" />
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

// ─── Generic icon button used by snooze/spam/more/assign ────────────────────

function IconButton({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
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
        "inline-flex h-8 w-8 items-center justify-center rounded-md border border-hairline bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer",
        active && "bg-surface-2 text-foreground",
      )}
    >
      {children}
    </button>
  );
}
