"use client";

/**
 * Help Desk message composer.
 *
 * Three modes:
 *   - REPLY    → eBay member message (requires existing buyer thread)
 *   - NOTE     → internal note, never sent externally
 *   - EXTERNAL → email via Resend (requires buyer email + flag)
 *
 * Send pipeline:
 *   1. POST /api/helpdesk/tickets/[id]/messages → returns jobId + scheduledAt
 *   2. Local countdown timer ticks down. Undo issues DELETE on the job.
 *   3. After countdown reaches 0 the cron worker fires (we just refresh state).
 *
 * Status selector:
 *   - Send + mark Waiting (default for replies)
 *   - Send + mark Resolved
 *   - Send only (leave status untouched)
 *
 * NOTES never go through outbound queue. They write immediately.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  MessageSquareText,
  StickyNote,
  Mail,
  Send,
  X,
  ShieldAlert,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Paperclip,
  Zap,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { HelpdeskTicketDetail, HelpdeskSyncStatus } from "@/hooks/use-helpdesk";
import { TemplatePicker } from "@/components/helpdesk/TemplatePicker";
import { QuickActionMenu, QUICK_ACTIONS } from "@/components/helpdesk/QuickActionMenu";
import { fillTemplate, type TemplateContext } from "@/lib/helpdesk/template-fill";
import { useHelpdeskPrefs } from "@/components/helpdesk/HelpdeskSettingsDialog";

type ComposerMode = "REPLY" | "NOTE" | "EXTERNAL";
type StatusChoice = "WAITING" | "RESOLVED" | "NONE";

const STATUS_LABEL: Record<StatusChoice, string> = {
  RESOLVED: "Send + Resolve",
  WAITING: "Send + Mark Waiting",
  NONE: "Send (keep status)",
};

const STATUS_SHORT: Record<StatusChoice, string> = {
  RESOLVED: "Resolve",
  WAITING: "Waiting",
  NONE: "Send",
};

interface ComposerProps {
  ticket: HelpdeskTicketDetail;
  syncStatus: HelpdeskSyncStatus | null;
  /**
   * Override the user-pref send delay. Generally leave undefined; the
   * Composer pulls `sendDelaySeconds` from useHelpdeskPrefs() so users can
   * tune it from the Settings dialog.
   */
  sendDelaySeconds?: number;
  onSent: () => void;
}

interface PendingJob {
  id: string;
  scheduledAt: number;
  willBlockReason: string | null;
}

export function Composer({
  ticket,
  syncStatus,
  sendDelaySeconds: sendDelayOverride,
  onSent,
}: ComposerProps) {
  const prefs = useHelpdeskPrefs();
  const sendDelaySeconds = sendDelayOverride ?? prefs.sendDelaySeconds;
  const [mode, setMode] = useState<ComposerMode>("REPLY");
  const [body, setBody] = useState("");
  // Per-agent default lives in prefs (server-synced via /api/helpdesk/me/prefs).
  // Local state lets the agent pick a non-default action for THIS one send
  // without the menu pick getting nuked by the prefs hook ticking.
  const [statusChoice, setStatusChoice] = useState<StatusChoice>(
    prefs.defaultSendStatus,
  );
  const [statusOverridden, setStatusOverridden] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const statusMenuRef = useRef<HTMLDivElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<PendingJob | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  /**
   * eDesk-style behaviour: the composer collapses to a single-line "Reply…"
   * pill until an agent clicks it. Keeps the conversation pane breathing
   * room for messages until the agent actually wants to type. Expanded
   * automatically when the user starts typing or when they explicitly click.
   */
  const [expanded, setExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const flags = syncStatus?.flags;
  const safeMode = flags?.safeMode ?? true;

  // Reset state when ticket changes
  useEffect(() => {
    setBody("");
    setError(null);
    setPending(null);
    setStatusChoice(prefs.defaultSendStatus);
    setStatusOverridden(false);
    setExpanded(false);
    setStatusMenuOpen(false);
  }, [ticket.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track preference changes from Settings dialog while the composer is
  // open. We deliberately skip this when the agent has explicitly picked
  // a different action for the current draft — they obviously want THAT
  // action, not whatever the new default is.
  useEffect(() => {
    if (statusOverridden) return;
    setStatusChoice(prefs.defaultSendStatus);
  }, [prefs.defaultSendStatus, statusOverridden]);

  // Close the status split-button dropdown when clicking outside it.
  useEffect(() => {
    if (!statusMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (
        statusMenuRef.current &&
        !statusMenuRef.current.contains(e.target as Node)
      ) {
        setStatusMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [statusMenuOpen]);

  // Choose default mode the first time we see this ticket
  useEffect(() => {
    if (mode === "REPLY" && !canReply(ticket)) {
      setMode(canEmail(ticket, flags?.enableResendExternal ?? false) ? "EXTERNAL" : "NOTE");
    }
  }, [ticket.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Countdown for the pending job
  useEffect(() => {
    if (!pending) {
      setSecondsLeft(0);
      return;
    }
    const tick = () => {
      const left = Math.max(
        0,
        Math.ceil((pending.scheduledAt - Date.now()) / 1000),
      );
      setSecondsLeft(left);
      if (left === 0) {
        // Worker should pick it up shortly. Keep the banner visible 3s as
        // confirmation, then clear.
        window.setTimeout(() => {
          setPending((p) => (p?.id === pending.id ? null : p));
          setLastSentAt(Date.now());
          onSent();
        }, 1200);
      }
    };
    tick();
    const handle = window.setInterval(tick, 250);
    return () => window.clearInterval(handle);
  }, [pending, onSent]);

  const ticketIsArchived = ticket.isArchived;

  const canSubmit =
    !submitting &&
    !pending &&
    body.trim().length > 0 &&
    (mode === "NOTE" ? !ticketIsArchived || true : !ticketIsArchived);

  const modeMeta = useMemo(() => {
    if (mode === "REPLY") {
      const eligible = canReply(ticket);
      return {
        label: "Reply via eBay",
        icon: <MessageSquareText className="h-3.5 w-3.5" />,
        disabled: !eligible,
        disabledReason: eligible ? null : "No buyer message to reply to.",
      };
    }
    if (mode === "EXTERNAL") {
      const eligible = canEmail(ticket, flags?.enableResendExternal ?? false);
      return {
        label: "External email (Resend)",
        icon: <Mail className="h-3.5 w-3.5" />,
        disabled: !eligible,
        disabledReason: eligible
          ? null
          : !ticket.buyerEmail
            ? "No buyer email on this ticket."
            : "Resend external sending is disabled.",
      };
    }
    return {
      label: "Internal note",
      icon: <StickyNote className="h-3.5 w-3.5" />,
      disabled: false,
      disabledReason: null,
    };
  }, [mode, ticket, flags?.enableResendExternal]);

  async function handleSubmit() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/helpdesk/tickets/${ticket.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          composerMode: mode,
          bodyText: body.trim(),
          sendDelaySeconds: mode === "NOTE" ? 0 : sendDelaySeconds,
          setStatus:
            mode === "NOTE" || statusChoice === "NONE" ? undefined : statusChoice,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(
          typeof j.error === "string" ? j.error : `Send failed (${res.status})`,
        );
      }
      const json = (await res.json()) as {
        data:
          | { kind: "note"; id: string }
          | {
              kind: "outbound_job";
              id: string;
              scheduledAt: string;
              willBlockReason: string | null;
            };
      };
      setBody("");
      if (json.data.kind === "note") {
        setLastSentAt(Date.now());
        onSent();
      } else {
        setPending({
          id: json.data.id,
          scheduledAt: new Date(json.data.scheduledAt).getTime(),
          willBlockReason: json.data.willBlockReason,
        });
        // Refetch the ticket detail right away so the thread renders a
        // "Sending in 5s" bubble immediately. Without this, the bubble
        // wouldn't appear until the 5s undo window expired and the
        // existing onSent() inside the countdown effect fired.
        onSent();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUndo() {
    if (!pending) return;
    try {
      const res = await fetch(`/api/helpdesk/outbound/${pending.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Cancel failed (${res.status})`);
      }
      setPending(null);
      // restore body so the user can edit and resend
      // (we cleared it on submit; fetch it back from elsewhere if needed)
      // Tell the parent to refetch so the pending bubble vanishes from
      // the thread.
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (ticketIsArchived) {
    return (
      <div className="shrink-0 border-t border-hairline bg-card px-5 py-3">
        <div className="flex items-center gap-2 rounded-md border border-hairline bg-surface px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Archived ticket — read only. New buyer messages will reopen it
            automatically.
          </span>
        </div>
      </div>
    );
  }

  // Collapsed pill (eDesk-style). Click to expand into the full composer.
  // Renders at the bottom of the thread pane and replaces all the chrome
  // until the agent commits to typing.
  if (!expanded && !pending && body.trim().length === 0) {
    const placeholder =
      mode === "NOTE"
        ? "Add a private note…"
        : mode === "REPLY"
          ? "Reply…"
          : "Send external email…";
    return (
      <div className="shrink-0 border-t border-hairline bg-card px-4 py-3">
        <button
          type="button"
          onClick={() => {
            setExpanded(true);
            window.setTimeout(() => textareaRef.current?.focus(), 0);
          }}
          className="block w-full cursor-text rounded-md border border-hairline bg-surface px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          title="Click to compose a reply"
        >
          {placeholder}
        </button>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-hairline bg-card">
      {/* Mode tabs */}
      <div className="flex items-center gap-1 border-b border-hairline px-3 py-1.5 text-xs">
        <ModeTab
          active={mode === "REPLY"}
          disabled={!canReply(ticket)}
          onClick={() => setMode("REPLY")}
          icon={<MessageSquareText className="h-3 w-3" />}
        >
          Reply
        </ModeTab>
        <ModeTab
          active={mode === "NOTE"}
          onClick={() => setMode("NOTE")}
          icon={<StickyNote className="h-3 w-3" />}
        >
          Note
        </ModeTab>
        <ModeTab
          active={mode === "EXTERNAL"}
          disabled={!canEmail(ticket, flags?.enableResendExternal ?? false)}
          onClick={() => setMode("EXTERNAL")}
          icon={<Mail className="h-3 w-3" />}
        >
          External
        </ModeTab>
        <span className="ml-auto text-[10px] text-muted-foreground">
          Plain text only · Markdown is not rendered
        </span>
        {body.trim().length === 0 && !pending && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="ml-2 inline-flex h-6 items-center gap-1 rounded-md border border-hairline bg-surface px-2 text-[10px] text-muted-foreground hover:bg-surface-2 hover:text-foreground cursor-pointer"
            title="Hide composer"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Pending undo banner */}
      {pending && (
        <div
          className={cn(
            "flex items-center justify-between gap-3 px-4 py-2 text-xs",
            pending.willBlockReason
              ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
          )}
        >
          <div className="flex items-center gap-2">
            {pending.willBlockReason ? (
              <ShieldAlert className="h-3.5 w-3.5" />
            ) : (
              <Clock className="h-3.5 w-3.5" />
            )}
            <span>
              {pending.willBlockReason
                ? `Queued but will be blocked by ${pending.willBlockReason.replace(/_/g, " ")}`
                : `Sending in ${secondsLeft}s…`}
            </span>
          </div>
          <button
            type="button"
            onClick={handleUndo}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-current/30 px-2 font-medium hover:bg-surface-2 cursor-pointer"
          >
            <X className="h-3 w-3" /> Undo
          </button>
        </div>
      )}

      {/* Just-sent toast */}
      {!pending && lastSentAt && Date.now() - lastSentAt < 4000 && (
        <div className="flex items-center gap-2 bg-emerald-500/10 px-4 py-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-3 w-3" /> Sent.
        </div>
      )}

      {/* Safe-mode banner (only for outbound modes) */}
      {safeMode && mode !== "NOTE" && (
        <div className="flex items-center gap-2 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          <ShieldAlert className="h-3 w-3 shrink-0" />
          <span>
            <strong>Safe Mode is ON.</strong> Outbound sends are blocked by env
            flag <code>HELPDESK_SAFE_MODE</code>. Notes still post normally.
          </span>
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 px-4 py-1.5 text-[11px] text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {modeMeta.disabled && modeMeta.disabledReason && (
        <div className="bg-surface px-4 py-1.5 text-[11px] text-muted-foreground">
          {modeMeta.disabledReason}
        </div>
      )}

      {/*
        eDesk-style "always-visible" quick chips. We surface the three most
        common one-click replies right above the textarea so the agent doesn't
        have to expand the QuickActionMenu dropdown for the 80% case. Note mode
        hides them — internal notes don't have a tracking number to share.
      */}
      {mode !== "NOTE" && !pending && !modeMeta.disabled && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-hairline bg-surface/40 px-4 py-2">
          {QUICK_ACTIONS.slice(0, 3).map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                const filled = fillTemplate(a.body, ticketToContext(ticket));
                setBody((prev) => (prev.trim() ? `${prev}\n\n${filled}` : filled));
                window.setTimeout(() => textareaRef.current?.focus(), 0);
              }}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-hairline bg-card px-2.5 text-[11px] text-muted-foreground hover:bg-surface-2 hover:text-foreground cursor-pointer"
              title={a.label}
            >
              <Zap className="h-3 w-3" />
              {a.label}
            </button>
          ))}
        </div>
      )}

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
            e.preventDefault();
            void handleSubmit();
          }
        }}
        placeholder={
          mode === "NOTE"
            ? "Internal note (not sent to buyer)…"
            : mode === "REPLY"
              ? "Reply to buyer (sent via eBay messaging)…"
              : "External email body (plain text)…"
        }
        rows={5}
        disabled={modeMeta.disabled || !!pending}
        className="block w-full resize-none border-0 bg-transparent px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-0 disabled:opacity-50"
      />

      {/* Footer: template picker + status selector + send button */}
      <div className="flex items-center gap-2 border-t border-hairline px-3 py-2 text-xs">
        {mode !== "NOTE" && (
          <>
            <TemplatePicker
              ctx={ticketToContext(ticket)}
              disabled={!!pending || modeMeta.disabled}
              onPick={(filled) => {
                setBody((prev) =>
                  prev.trim() ? `${prev}\n\n${filled}` : filled,
                );
                window.setTimeout(() => textareaRef.current?.focus(), 0);
              }}
            />
            <QuickActionMenu
              ctx={ticketToContext(ticket)}
              disabled={!!pending || modeMeta.disabled}
              onPick={(filled) => {
                setBody((prev) =>
                  prev.trim() ? `${prev}\n\n${filled}` : filled,
                );
                window.setTimeout(() => textareaRef.current?.focus(), 0);
              }}
            />
            {/*
              Outbound attachments: feature-flag gated and v1 limited to External
              (Resend) mode. eBay's RTQ API does not support file attachments —
              only inline-image URLs in the body — so Reply mode hides this entirely.
            */}
            {flags?.enableAttachments && mode === "EXTERNAL" && (
              <button
                type="button"
                disabled
                title="Attachment upload UI coming in v1.1 — Resend transport already supported."
                className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 text-muted-foreground cursor-not-allowed opacity-60"
              >
                <Paperclip className="h-3.5 w-3.5" />
                Attach
              </button>
            )}
          </>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {modeMeta.icon} {modeMeta.label}
          {mode !== "NOTE" && (
            <>
              {" · "}
              {sendDelaySeconds}s send delay
            </>
          )}
          {" · ⌘/Ctrl+Enter to send"}
        </span>
        {mode === "NOTE" ? (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || modeMeta.disabled}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md px-3 text-xs font-semibold transition-colors cursor-pointer",
              canSubmit && !modeMeta.disabled
                ? "bg-amber-600 text-white hover:bg-amber-500"
                : "bg-surface-2 text-muted-foreground",
            )}
          >
            {submitting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            Add note
          </button>
        ) : (
          /*
            Split-button send.
              - Primary face does the agent's preferred action (defaultSendStatus
                from prefs, or whatever they picked from the dropdown for THIS
                send). Default for new accounts is RESOLVED.
              - Chevron opens a small menu with the other two actions, so
                "Send + Mark Waiting" is one click away when an agent expects
                the buyer to reply but doesn't want to flip their global pref.
          */
          <div ref={statusMenuRef} className="relative inline-flex">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit || modeMeta.disabled}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-l-md border border-r-0 border-brand px-3 text-xs font-semibold transition-colors cursor-pointer",
                canSubmit && !modeMeta.disabled
                  ? "bg-brand text-brand-foreground hover:opacity-90"
                  : "border-hairline bg-surface-2 text-muted-foreground",
              )}
              title={STATUS_LABEL[statusChoice]}
            >
              {submitting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              {STATUS_SHORT[statusChoice]}
            </button>
            <button
              type="button"
              onClick={() => setStatusMenuOpen((v) => !v)}
              disabled={!!pending || modeMeta.disabled}
              aria-label="Choose send action"
              className={cn(
                "inline-flex h-7 w-6 items-center justify-center rounded-r-md border text-xs cursor-pointer",
                canSubmit && !modeMeta.disabled
                  ? "border-brand bg-brand text-brand-foreground hover:opacity-90"
                  : "border-hairline bg-surface-2 text-muted-foreground",
              )}
            >
              <ChevronDown className="h-3 w-3" />
            </button>
            {statusMenuOpen && (
              <div className="absolute bottom-full right-0 z-20 mb-1 min-w-[10rem] rounded-md border border-hairline bg-card p-1 text-xs shadow-md">
                {(["RESOLVED", "WAITING", "NONE"] as StatusChoice[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setStatusChoice(s);
                      setStatusOverridden(true);
                      setStatusMenuOpen(false);
                    }}
                    className={cn(
                      "block w-full rounded px-2 py-1 text-left transition-colors cursor-pointer",
                      s === statusChoice
                        ? "bg-brand-muted text-brand"
                        : "text-foreground hover:bg-surface-2",
                    )}
                  >
                    {STATUS_LABEL[s]}
                    {s === prefs.defaultSendStatus && (
                      <span className="ml-2 text-[9px] uppercase tracking-wider text-muted-foreground">
                        default
                      </span>
                    )}
                  </button>
                ))}
                <div className="mt-1 border-t border-hairline px-2 py-1 text-[10px] text-muted-foreground">
                  Change the default in Help Desk settings.
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ticketToContext(ticket: HelpdeskTicketDetail): TemplateContext {
  return {
    buyerName: ticket.buyerName,
    buyerUserId: ticket.buyerUserId,
    ebayItemId: ticket.ebayItemId,
    ebayItemTitle: ticket.ebayItemTitle,
    ebayOrderNumber: ticket.ebayOrderNumber,
    storeName: ticket.integrationLabel,
    trackingNumber: null, // TODO: lookup from related order in Phase 4
  };
}

function canReply(ticket: HelpdeskTicketDetail): boolean {
  // Need at least one inbound eBay message with an ebayMessageId so we can RTQ.
  // Source EBAY (Trading API) is what we can reply to. EBAY_UI may also be
  // valid since GetMyMessages returns messages sent on eBay's web UI too.
  return ticket.messages.some(
    (m) =>
      m.direction === "INBOUND" &&
      (m.source === "EBAY" || m.source === "EBAY_UI"),
  );
}

function canEmail(
  ticket: HelpdeskTicketDetail,
  enableResendExternal: boolean,
): boolean {
  if (!enableResendExternal) return false;
  return Boolean(ticket.buyerEmail);
}

function ModeTab({
  active,
  disabled,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium transition-colors cursor-pointer",
        active
          ? "bg-surface-2 text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-surface-2",
        disabled && "opacity-40 cursor-not-allowed hover:bg-transparent",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
