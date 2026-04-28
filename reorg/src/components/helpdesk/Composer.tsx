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
  AlertTriangle,
  Paperclip,
  Zap,
  ChevronDown,
  Check,
  GripHorizontal,
  Pin,
  PinOff,
  Clock3,
  Settings2,
  UserPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  HelpdeskPendingOutboundJob,
  HelpdeskTicketDetail,
  HelpdeskSyncStatus,
} from "@/hooks/use-helpdesk";
import { TemplatePicker } from "@/components/helpdesk/TemplatePicker";
import { QuickActionMenu, QUICK_ACTIONS } from "@/components/helpdesk/QuickActionMenu";
import { fillTemplate, type TemplateContext } from "@/lib/helpdesk/template-fill";
import {
  EBAY_IMAGE_ATTACHMENT_ACCEPT,
  MAX_EBAY_IMAGE_ATTACHMENTS,
  inferEbayImageMimeType,
  validateEbayImageAttachment,
} from "@/lib/helpdesk/outbound-attachments";
import {
  type HelpdeskQuickBarItem,
  updateHelpdeskPrefs,
  useHelpdeskPrefs,
} from "@/components/helpdesk/HelpdeskSettingsDialog";

type ComposerMode = "REPLY" | "NOTE" | "EXTERNAL";
type StatusChoice = "WAITING" | "RESOLVED" | "NONE";

const STATUS_LABEL: Record<StatusChoice, string> = {
  RESOLVED: "Send + Resolve",
  WAITING: "Send + Mark Waiting",
  NONE: "Send (keep status)",
};

const STATUS_SHORT: Record<StatusChoice, string> = {
  RESOLVED: "Send + Resolve",
  WAITING: "Send + Waiting",
  NONE: "Send",
};

const COMPOSER_HEIGHT_MIN = 72;
const COMPOSER_HEIGHT_MAX = 460;
const SEND_DELAY_MIN = 0;
const SEND_DELAY_MAX = 10;

interface ComposerProps {
  ticket: HelpdeskTicketDetail;
  syncStatus: HelpdeskSyncStatus | null;
  /**
   * Override the user-pref send delay. Generally leave undefined; the
   * Composer pulls `sendDelaySeconds` from useHelpdeskPrefs() so users can
   * tune it from the Settings dialog.
   */
  sendDelaySeconds?: number;
  onQueuedOutbound?: (job: HelpdeskPendingOutboundJob) => void;
  onSent: () => void;
}

interface PendingJob {
  id: string;
  scheduledAt: number;
  willBlockReason: string | null;
  bodyText: string;
  composerMode: ComposerMode;
  createdAt: string;
}

interface AgentOption {
  id: string;
  name: string | null;
  email: string | null;
  handle?: string | null;
  avatarUrl?: string | null;
}

interface TemplateRow {
  id: string;
  name: string;
  bodyText: string;
  isShared: boolean;
  isMine: boolean;
  shortcut: string | null;
  language: string | null;
  description: string | null;
}

interface ComposerAttachment {
  id: string;
  file: File;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string;
}

interface QuickBarResolvedItem {
  item: HelpdeskQuickBarItem;
  label: string;
  body: string | null;
  available: boolean;
}

export function Composer({
  ticket,
  syncStatus,
  sendDelaySeconds: sendDelayOverride,
  onQueuedOutbound,
  onSent,
}: ComposerProps) {
  const prefs = useHelpdeskPrefs();
  const sendDelaySeconds = sendDelayOverride ?? prefs.sendDelaySeconds;
  const sendDelaySecondsRef = useRef(sendDelaySeconds);
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
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [pendingSecondsLeft, setPendingSecondsLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [composerNotice, setComposerNotice] = useState<{
    at: number;
    text: string;
    tone: "success" | "info";
  } | null>(null);
  /**
   * eDesk-style behaviour: the composer collapses to a single-line "Reply…"
   * pill until an agent clicks it. Keeps the conversation pane breathing
   * room for messages until the agent actually wants to type. Expanded
   * automatically when the user starts typing or when they explicitly click.
   */
  const [expanded, setExpanded] = useState(false);
  const [composerHeight, setComposerHeight] = useState(prefs.composerHeightPx);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);

  // Tracking number for this ticket's related order. Populated lazily from
  // the same endpoint ContextPanel uses; the server keeps a 5-min in-memory
  // cache (`getOrderContextCached`) so even though both components fetch we
  // only hit eBay once. We store just the two fields the templates actually
  // need — keeping the Composer's footprint small.
  const [orderTracking, setOrderTracking] = useState<{
    number: string | null;
    carrier: string | null;
    deliveryName: string | null;
    buyerName: string | null;
  }>({ number: null, carrier: null, deliveryName: null, buyerName: null });

  const flags = syncStatus?.flags;
  const safeMode = flags?.safeMode ?? true;

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      for (const attachment of attachmentsRef.current) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  }, []);

  useEffect(() => {
    sendDelaySecondsRef.current = sendDelaySeconds;
  }, [sendDelaySeconds]);

  function updateSendDelaySeconds(value: number) {
    const next = clampNumber(value, SEND_DELAY_MIN, SEND_DELAY_MAX);
    sendDelaySecondsRef.current = next;
    updateHelpdeskPrefs({
      sendDelaySeconds: next,
    });
  }

  // Reset state when ticket changes
  useEffect(() => {
    setBody("");
    setError(null);
    setPending(null);
    setComposerNotice(null);
    setStatusChoice(prefs.defaultSendStatus);
    setStatusOverridden(false);
    setExpanded(prefs.composerSticky);
    setStatusMenuOpen(false);
    setAttachments((prev) => {
      for (const attachment of prev) URL.revokeObjectURL(attachment.previewUrl);
      return [];
    });
    setOrderTracking({ number: null, carrier: null, deliveryName: null, buyerName: null });
  }, [ticket.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode === "REPLY") return;
    setAttachments((prev) => {
      if (prev.length === 0) return prev;
      for (const attachment of prev) URL.revokeObjectURL(attachment.previewUrl);
      return [];
    });
  }, [mode]);

  useEffect(() => {
    setComposerHeight(prefs.composerHeightPx);
  }, [prefs.composerHeightPx]);

  useEffect(() => {
    if (prefs.composerSticky) setExpanded(true);
  }, [prefs.composerSticky]);

  function startComposerResize(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = composerHeight;
    let latest = startHeight;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    function onMove(ev: PointerEvent) {
      latest = Math.max(
        COMPOSER_HEIGHT_MIN,
        Math.min(COMPOSER_HEIGHT_MAX, Math.round(startHeight + startY - ev.clientY)),
      );
      setComposerHeight(latest);
    }
    function onUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      updateHelpdeskPrefs({ composerHeightPx: latest });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function nudgeComposerHeight(delta: number) {
    const next = clampNumber(
      composerHeight + delta,
      COMPOSER_HEIGHT_MIN,
      COMPOSER_HEIGHT_MAX,
    );
    setComposerHeight(next);
    updateHelpdeskPrefs({ composerHeightPx: next });
  }

  // Lazily pull the tracking number from the order-context endpoint so the
  // {{trackingNumber}} template token resolves correctly. We only fetch when
  // the ticket has an eBay order number — pre-sales / non-eBay channels
  // would just get a null payload back from the server and waste a round-
  // trip. Aborts cleanly on ticket change so a fast clicker doesn't see
  // stale tracking flash into a different ticket.
  useEffect(() => {
    if (!ticket.ebayOrderNumber) return;
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/helpdesk/tickets/${ticket.id}/order-context`,
          { cache: "no-store", signal: ac.signal },
        );
        if (!res.ok) return;
        const j = (await res.json()) as {
          data: {
            trackingNumber: string | null;
            trackingCarrier: string | null;
            buyerName: string | null;
            shippingAddress: { name: string | null } | null;
          } | null;
        };
        if (ac.signal.aborted || !j.data) return;
        setOrderTracking({
          number: j.data.trackingNumber ?? null,
          carrier: j.data.trackingCarrier ?? null,
          deliveryName: j.data.shippingAddress?.name ?? null,
          buyerName: j.data.buyerName ?? null,
        });
      } catch {
        // Best-effort: tracking is a nice-to-have for templates, not required.
      }
    })();
    return () => ac.abort();
  }, [ticket.id, ticket.ebayOrderNumber]);

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

  // Countdown for the pending job. The agent-facing message bubble is only
  // added after the undo window expires; until then the green bar is the
  // single source of truth and Undo can cancel the outbound job.
  useEffect(() => {
    if (!pending) {
      setPendingSecondsLeft(0);
      return;
    }
    let completed = false;
    const tick = () => {
      const left = Math.max(
        0,
        Math.ceil((pending.scheduledAt - Date.now()) / 1000),
      );
      setPendingSecondsLeft(left);
      if (left === 0) {
        if (completed) return;
        completed = true;
        setPending((p) => (p?.id === pending.id ? null : p));
        setComposerNotice({
          at: Date.now(),
          text: "Sending now.",
          tone: "info",
        });
        onQueuedOutbound?.({
          id: pending.id,
          composerMode: pending.composerMode,
          bodyText: pending.bodyText,
          status: "PENDING",
          scheduledAt: new Date(pending.scheduledAt).toISOString(),
          createdAt: pending.createdAt,
          willBlockReason: pending.willBlockReason,
          author: null,
        });
        onSent();
      }
    };
    tick();
    const handle = window.setInterval(tick, 250);
    return () => window.clearInterval(handle);
  }, [pending, onQueuedOutbound, onSent]);

  // Memoize so all three template-aware children (quick chips,
  // TemplatePicker, QuickActionMenu) share the same context object and
  // re-render only when something they actually consume changes.
  const templateCtx = useMemo(
    () => ticketToContext(ticket, orderTracking),
    [ticket, orderTracking],
  );

  function appendBodyText(text: string) {
    setBody((prev) => (prev.trim() ? `${prev}\n\n${text}` : text));
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  const ticketIsArchived = ticket.isArchived;

  // Archived tickets can still be replied to — the server will un-archive
  // the ticket on send (per user decision `unarchive_waiting`). We surface
  // an informational banner above the composer so the agent knows clicking
  // "Send" will pull the ticket back into Waiting; nothing is blocked.
  const attachmentFlagEnabled = Boolean(flags?.enableAttachments);
  const canAttachImages = mode === "REPLY" && attachmentFlagEnabled;
  const canSubmit =
    !submitting &&
    !pending &&
    body.trim().length > 0 &&
    (attachments.length === 0 || canAttachImages);

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

  const recoverableOutbound = useMemo(() => {
    const jobs = ticket.pendingOutboundJobs ?? [];
    const failed =
      jobs
        .filter((job) => job.status === "FAILED" || job.status === "CANCELED")
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )[0] ?? null;
    if (!failed) return null;

    const failedAt = new Date(failed.createdAt).getTime();
    const newerActiveJob = jobs.some((job) => {
      if (job.id === failed.id) return false;
      if (job.status !== "PENDING" && job.status !== "SENDING") return false;
      return new Date(job.createdAt).getTime() > failedAt;
    });
    if (newerActiveJob) return null;

    const newerConfirmedOutbound = ticket.messages.some((message) => {
      if (message.direction !== "OUTBOUND") return false;
      return new Date(message.sentAt).getTime() > failedAt;
    });
    return newerConfirmedOutbound ? null : failed;
  }, [ticket.messages, ticket.pendingOutboundJobs]);

  function restoreRecoverableOutbound(job: HelpdeskPendingOutboundJob) {
    setMode(job.composerMode === "NOTE" ? "REPLY" : job.composerMode);
    setBody(job.bodyText);
    setExpanded(true);
    setError(null);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function clearAttachments() {
    setAttachments((prev) => {
      for (const attachment of prev) URL.revokeObjectURL(attachment.previewUrl);
      return [];
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const target = prev.find((attachment) => attachment.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((attachment) => attachment.id !== id);
    });
  }

  function handleAttachmentFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    if (!canAttachImages) {
      setError("eBay image attachments are disabled.");
      return;
    }
    const incoming = Array.from(fileList);
    if (attachments.length + incoming.length > MAX_EBAY_IMAGE_ATTACHMENTS) {
      setError(`eBay allows up to ${MAX_EBAY_IMAGE_ATTACHMENTS} images per reply.`);
      return;
    }
    const next: ComposerAttachment[] = [];
    for (const file of incoming) {
      const mimeType = inferEbayImageMimeType(file.name, file.type);
      const validation = validateEbayImageAttachment({
        fileName: file.name,
        mimeType,
        sizeBytes: file.size,
      });
      if (validation) {
        for (const attachment of next) URL.revokeObjectURL(attachment.previewUrl);
        setError(validation);
        return;
      }
      next.push({
        id: makeClientId(),
        file,
        fileName: file.name,
        mimeType,
        sizeBytes: file.size,
        previewUrl: URL.createObjectURL(file),
      });
    }
    setError(null);
    setAttachments((prev) => [...prev, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    const draftBody = body.trim();
    const effectiveSendDelaySeconds =
      mode === "NOTE" ? 0 : sendDelaySecondsRef.current;
    setError(null);
    setSubmitting(true);
    try {
      const requestBody = {
        composerMode: mode,
        bodyText: draftBody,
        sendDelaySeconds: effectiveSendDelaySeconds,
        setStatus:
          mode === "NOTE" || statusChoice === "NONE" ? undefined : statusChoice,
      };
      const res =
        attachments.length > 0
          ? await fetch(`/api/helpdesk/tickets/${ticket.id}/messages`, {
              method: "POST",
              body: buildMessageFormData(requestBody, attachments),
            })
          : await fetch(`/api/helpdesk/tickets/${ticket.id}/messages`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(requestBody),
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
      clearAttachments();
      if (json.data.kind === "note") {
        setComposerNotice({
          at: Date.now(),
          text: "Note saved.",
          tone: "success",
        });
        onSent();
      } else {
        const queuedAt = new Date().toISOString();
        setPending({
          id: json.data.id,
          scheduledAt: Date.now() + effectiveSendDelaySeconds * 1000,
          willBlockReason: json.data.willBlockReason,
          bodyText: draftBody,
          composerMode: mode,
          createdAt: queuedAt,
        });
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
      setPendingSecondsLeft(0);
      setBody(pending.bodyText);
      // Tell the parent to refetch so the pending bubble vanishes from
      // the thread.
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Archived banner — informational only. The composer stays fully
  // functional; sending will un-archive and move the ticket to Waiting.
  const archivedBanner = ticketIsArchived ? (
    <div className="mx-5 mt-3 flex items-center gap-2 rounded-md border border-hairline bg-surface px-3 py-2 text-xs text-muted-foreground">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>
        Archived ticket — sending a reply will un-archive it and move it to
        Waiting. Notes leave the archive state alone.
      </span>
    </div>
  ) : null;

  const pendingBanner = pending ? (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-4 py-2 text-xs",
        pending.willBlockReason
          ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {pending.willBlockReason ? (
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="truncate">
          {pending.willBlockReason
            ? `Temporary send issue: ${pending.willBlockReason.replace(/_/g, " ")}`
            : `Sending in ${pendingSecondsLeft}s`}
        </span>
      </div>
      <button
        type="button"
        onClick={handleUndo}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-current/30 px-2 font-medium hover:bg-surface-2 cursor-pointer"
      >
        <X className="h-3 w-3" /> Undo
      </button>
    </div>
  ) : null;

  const recoverableBanner =
    !pending && recoverableOutbound ? (
      <div className="flex items-center justify-between gap-3 border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-700 dark:text-red-300">
        <div className="flex min-w-0 items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            Last reply {recoverableOutbound.status.toLowerCase()}:{" "}
            {recoverableOutbound.willBlockReason ?? "open it to edit and retry."}
          </span>
        </div>
        <button
          type="button"
          onClick={() => restoreRecoverableOutbound(recoverableOutbound)}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-current/30 px-2 font-medium transition-colors hover:bg-surface-2 cursor-pointer"
        >
          Edit draft
        </button>
      </div>
    ) : null;

  // Collapsed pill (eDesk-style). Click to expand into the full composer.
  // Renders at the bottom of the thread pane and replaces all the chrome
  // until the agent commits to typing.
  if (
    !prefs.composerSticky &&
    !expanded &&
    !pending &&
    !recoverableOutbound &&
    body.trim().length === 0
  ) {
    const placeholder =
      mode === "NOTE"
        ? "Add a private note…"
        : mode === "REPLY"
          ? "Reply…"
          : "Send external email…";
    return (
      <div className="shrink-0 border-t border-hairline bg-card/95 shadow-[0_-8px_24px_rgb(0_0_0_/_0.10)]">
        {archivedBanner}
        <div className="px-4 py-3">
          <button
            type="button"
            onClick={() => {
              setExpanded(true);
              window.setTimeout(() => textareaRef.current?.focus(), 0);
            }}
            className="block w-full cursor-text rounded-md border border-hairline-strong/70 bg-surface px-3 py-2 text-left text-sm text-foreground/70 shadow-sm transition-colors hover:border-brand/35 hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            title="Click to compose a reply"
          >
            {placeholder}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-hairline bg-card/95 shadow-[0_-8px_24px_rgb(0_0_0_/_0.10)]">
      {archivedBanner}
      {pendingBanner}
      {recoverableBanner}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize composer"
        aria-valuemin={COMPOSER_HEIGHT_MIN}
        aria-valuemax={COMPOSER_HEIGHT_MAX}
        aria-valuenow={composerHeight}
        tabIndex={0}
        title="Drag to resize composer"
        onPointerDown={startComposerResize}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault();
            nudgeComposerHeight(24);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            nudgeComposerHeight(-24);
          }
        }}
        className="flex h-3 cursor-row-resize items-center justify-center border-b border-hairline-strong/70 bg-surface/70 text-foreground/55 transition-colors hover:bg-brand/10 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        <GripHorizontal className="h-3 w-3" />
      </div>
      {/* Mode tabs */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-hairline bg-card/60 px-3 py-1.5 text-xs">
        <div className="inline-flex rounded-md border border-hairline bg-surface p-0.5">
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
        </div>
        <button
          type="button"
          onClick={() => updateHelpdeskPrefs({ composerSticky: !prefs.composerSticky })}
          className={cn(
            "ml-auto inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[10px] font-medium transition-colors cursor-pointer",
            prefs.composerSticky
              ? "border-brand/40 bg-brand-muted text-brand"
              : "border-hairline-strong/70 bg-surface text-foreground/70 hover:bg-surface-2 hover:text-foreground",
          )}
          title={prefs.composerSticky ? "Composer stays open between tickets" : "Keep composer open between tickets"}
          aria-pressed={prefs.composerSticky}
        >
          {prefs.composerSticky ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
          Sticky
        </button>
        <button
          type="button"
          onClick={() => updateHelpdeskPrefs({ autoAdvance: !prefs.autoAdvance })}
          className={cn(
            "inline-flex h-6 items-center rounded-md border px-2 text-[10px] font-medium transition-colors cursor-pointer",
            prefs.autoAdvance
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-hairline-strong/70 bg-surface text-foreground/70 hover:bg-surface-2 hover:text-foreground",
          )}
          title="After Send + Resolve, jump to the next ticket"
          aria-pressed={prefs.autoAdvance}
        >
          Auto-advance {prefs.autoAdvance ? "On" : "Off"}
        </button>
        <span className="hidden text-[10px] text-foreground/60 lg:inline">
          Plain text only · Markdown is not rendered
        </span>
        {body.trim().length === 0 && !pending && !prefs.composerSticky && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="ml-2 inline-flex h-6 items-center gap-1 rounded-md border border-hairline-strong/70 bg-surface px-2 text-[10px] text-foreground/70 hover:bg-surface-2 hover:text-foreground cursor-pointer"
            title="Hide composer"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Composer status toast */}
      {!pending && composerNotice && Date.now() - composerNotice.at < 4000 && (
        <div
          className={cn(
            "flex items-center gap-2 border-b px-4 py-1.5 text-[11px]",
            composerNotice.tone === "success"
              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
          )}
        >
          <CheckCircle2 className="h-3 w-3" /> {composerNotice.text}
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
        <div className="bg-surface px-4 py-1.5 text-[11px] text-foreground/65">
          {modeMeta.disabledReason}
        </div>
      )}

      {mode !== "NOTE" && !pending && !modeMeta.disabled && (
        <QuickBar
          ctx={templateCtx}
          items={prefs.quickBarItems}
          onPick={appendBodyText}
          onChange={(quickBarItems) => updateHelpdeskPrefs({ quickBarItems })}
        />
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
        style={{ height: composerHeight }}
        disabled={modeMeta.disabled || !!pending}
        className="block w-full resize-none border-0 bg-transparent px-4 py-2 text-sm leading-6 text-foreground placeholder:text-foreground/55 transition-colors focus:bg-background/20 focus:outline-none focus:ring-0 disabled:opacity-50"
      />

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-hairline bg-surface/35 px-4 py-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="group relative flex items-center gap-2 rounded-md border border-hairline bg-card px-2 py-1.5 text-xs shadow-sm"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={attachment.previewUrl}
                alt=""
                className="h-9 w-9 rounded border border-hairline object-cover"
              />
              <div className="min-w-0 max-w-[12rem]">
                <p className="truncate font-medium text-foreground">
                  {attachment.fileName}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {formatBytes(attachment.sizeBytes)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => removeAttachment(attachment.id)}
                className="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
                title="Remove image"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Footer: template picker + status selector + send button */}
      <div className="flex flex-wrap items-center gap-2 border-t border-hairline bg-card/80 px-3 py-1.5 text-xs">
        {mode !== "NOTE" && (
          <>
            <TemplatePicker
              ctx={templateCtx}
              disabled={!!pending || modeMeta.disabled}
              onPick={appendBodyText}
            />
            <QuickActionMenu
              ctx={templateCtx}
              disabled={!!pending || modeMeta.disabled}
              onPick={appendBodyText}
            />
            {mode === "REPLY" && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={EBAY_IMAGE_ATTACHMENT_ACCEPT}
                  multiple
                  className="hidden"
                  onChange={(e) => handleAttachmentFiles(e.currentTarget.files)}
                />
                <button
                  type="button"
                  disabled={
                    !!pending ||
                    attachments.length >= MAX_EBAY_IMAGE_ATTACHMENTS
                  }
                  aria-disabled={!attachmentFlagEnabled}
                  onClick={() => {
                    if (!attachmentFlagEnabled) {
                      setError("Image attachments are disabled in Help Desk Global Settings.");
                      return;
                    }
                    fileInputRef.current?.click();
                  }}
                  title={
                    attachmentFlagEnabled
                      ? "Attach eBay-supported images"
                      : "Outbound image attachments are disabled in Global Settings."
                  }
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 text-xs text-foreground shadow-sm transition-colors hover:border-brand/35 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer",
                    !attachmentFlagEnabled && "opacity-60",
                  )}
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  Image
                </button>
              </>
            )}
            <QuickAssignControl
              ticket={ticket}
              disabled={!!pending}
              onAssigned={onSent}
            />
            <label className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline-strong/70 bg-surface px-2 text-[11px] text-foreground/70">
              <Clock3 className="h-3.5 w-3.5" />
              Delay
              <input
                type="number"
                min={SEND_DELAY_MIN}
                max={SEND_DELAY_MAX}
                value={sendDelaySeconds}
                onChange={(e) => updateSendDelaySeconds(Number(e.target.value))}
                disabled={sendDelayOverride != null || !!pending}
                className="h-5 w-9 rounded border border-hairline bg-card px-1 text-center text-[11px] text-foreground outline-none focus:border-brand/50 disabled:opacity-50"
                aria-label="Send delay seconds"
              />
              <span>s</span>
            </label>
          </>
        )}
        <span className="ml-auto text-[10px] text-foreground/60">
          {modeMeta.icon} {modeMeta.label}
          {mode !== "NOTE" && (
            <>
              {" · "}
              {sendDelaySeconds === 0
                ? "sends immediately"
                : `queues for ${sendDelaySeconds}s`}
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
                "inline-flex h-9 min-w-[12rem] items-center justify-center gap-1.5 rounded-l-md border border-r-0 border-brand px-5 text-sm font-semibold transition-colors cursor-pointer",
                canSubmit && !modeMeta.disabled
                  ? "bg-brand text-brand-foreground hover:opacity-90"
                  : "border-hairline bg-surface-2 text-muted-foreground",
              )}
              title={STATUS_LABEL[statusChoice]}
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {STATUS_SHORT[statusChoice]}
            </button>
            <button
              type="button"
              onClick={() => setStatusMenuOpen((v) => !v)}
              disabled={!!pending || modeMeta.disabled}
              aria-label="Choose send action"
              className={cn(
                "inline-flex h-9 w-9 items-center justify-center rounded-r-md border text-xs cursor-pointer",
                canSubmit && !modeMeta.disabled
                  ? "border-brand bg-brand text-brand-foreground hover:opacity-90"
                  : "border-hairline bg-surface-2 text-muted-foreground",
              )}
            >
              <ChevronDown className="h-3.5 w-3.5" />
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

function QuickBar({
  ctx,
  items,
  onPick,
  onChange,
}: {
  ctx: TemplateContext;
  items: HelpdeskQuickBarItem[];
  onPick: (body: string) => void;
  onChange: (items: HelpdeskQuickBarItem[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const templateFetchRef = useRef<AbortController | null>(null);
  const needsTemplates =
    open || items.some((item) => item.kind === "template");

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

  useEffect(() => {
    return () => templateFetchRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!needsTemplates || templates.length > 0 || templateFetchRef.current) return;
    const ac = new AbortController();
    templateFetchRef.current = ac;
    setLoadingTemplates(true);
    fetch("/api/helpdesk/templates", { cache: "no-store", signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`templates ${r.status}`);
        return r.json() as Promise<{ data?: TemplateRow[] }>;
      })
      .then((json) => {
        if (ac.signal.aborted) return;
        setTemplates(
          (json.data ?? []).slice().sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
          ),
        );
      })
      .catch(() => {
        if (!ac.signal.aborted) setTemplates([]);
      })
      .finally(() => {
        if (templateFetchRef.current === ac) templateFetchRef.current = null;
        if (!ac.signal.aborted) setLoadingTemplates(false);
      });
  }, [needsTemplates, templates.length]);

  const selectedKeys = new Set(items.map((item) => quickBarKey(item)));
  const selected: QuickBarResolvedItem[] = items
    .flatMap((item): QuickBarResolvedItem[] => {
      if (item.kind === "quick") {
        const quick = QUICK_ACTIONS.find((q) => q.id === item.id);
        return quick
          ? [{ item, label: item.label, body: quick.body, available: true }]
          : [];
      }
      const template = templates.find((t) => t.id === item.id);
      return [{
        item,
        label: template?.name ?? item.label,
        body: template?.bodyText ?? null,
        available: Boolean(template),
      }];
    });
  const q = search.trim().toLowerCase();
  const filteredTemplates = q
    ? templates.filter((t) =>
        [t.name, t.shortcut, t.description, t.bodyText]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
    : templates;

  function toggle(item: HelpdeskQuickBarItem) {
    const key = quickBarKey(item);
    if (selectedKeys.has(key)) {
      onChange(items.filter((existing) => quickBarKey(existing) !== key));
      return;
    }
    onChange([...items, item].slice(0, 8));
  }

  return (
    <div
      ref={ref}
      className="relative flex flex-wrap items-center gap-1.5 border-b border-hairline bg-surface/40 px-4 py-1.5"
    >
      {selected.map((entry) => (
        <button
          key={quickBarKey(entry.item)}
          type="button"
          disabled={!entry.available}
          onClick={() => {
            if (!entry.body) return;
            onPick(fillTemplate(entry.body, ctx));
          }}
          className="inline-flex h-6 items-center gap-1 rounded-full border border-hairline-strong/70 bg-surface px-2.5 text-[11px] font-medium text-foreground/80 shadow-sm transition-colors hover:border-brand/45 hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
          title={entry.available ? entry.label : "Loading template"}
        >
          <Zap className="h-3 w-3 text-brand/80" />
          {entry.label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors cursor-pointer",
          open
            ? "border-brand/40 bg-brand-muted text-brand"
            : "border-hairline-strong/70 bg-surface text-foreground/70 hover:bg-surface-2 hover:text-foreground",
        )}
      >
        <Settings2 className="h-3 w-3" />
        {items.length === 0 ? "Customize quick bar" : "Edit"}
      </button>

      {open && (
        <div className="absolute bottom-full left-3 z-30 mb-1 w-[min(34rem,calc(100vw-2rem))] rounded-md border border-hairline bg-popover p-2 text-popover-foreground shadow-2xl shadow-black/30">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Quick bar
            </p>
            <span className="text-[10px] text-muted-foreground">
              {items.length}/8
            </span>
          </div>
          <div className="mb-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates"
              className="h-7 w-full rounded-md border border-hairline bg-surface px-2 text-xs text-foreground outline-none focus:border-brand/50"
            />
          </div>
          <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
            <div>
              <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Quick replies
              </p>
              {QUICK_ACTIONS.map((quick) => {
                const item: HelpdeskQuickBarItem = {
                  kind: "quick",
                  id: quick.id,
                  label: quick.label,
                };
                const active = selectedKeys.has(quickBarKey(item));
                return (
                  <QuickBarToggle
                    key={quick.id}
                    active={active}
                    label={quick.label}
                    onClick={() => toggle(item)}
                  />
                );
              })}
            </div>
            <div>
              <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Templates
              </p>
              {loadingTemplates ? (
                <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading templates
                </div>
              ) : filteredTemplates.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  No templates match.
                </p>
              ) : (
                filteredTemplates.slice(0, 40).map((template) => {
                  const item: HelpdeskQuickBarItem = {
                    kind: "template",
                    id: template.id,
                    label: template.name,
                  };
                  const active = selectedKeys.has(quickBarKey(item));
                  return (
                    <QuickBarToggle
                      key={template.id}
                      active={active}
                      label={template.name}
                      onClick={() => toggle(item)}
                    />
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function QuickBarToggle({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 cursor-pointer",
        active ? "bg-brand-muted text-brand" : "text-foreground",
      )}
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-hairline bg-surface">
        {active ? <Check className="h-3 w-3" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function quickBarKey(item: HelpdeskQuickBarItem): string {
  return `${item.kind}:${item.id}`;
}

function QuickAssignControl({
  ticket,
  disabled,
  onAssigned,
}: {
  ticket: HelpdeskTicketDetail;
  disabled?: boolean;
  onAssigned: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [assigned, setAssigned] = useState(ticket.primaryAssignee);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setAssigned(ticket.primaryAssignee);
  }, [ticket.id, ticket.primaryAssignee]);

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

  async function loadAgents() {
    if (agents !== null || loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/helpdesk/agents", { cache: "no-store" });
      if (!res.ok) throw new Error(`agents ${res.status}`);
      const json = (await res.json()) as { data?: AgentOption[] };
      setAgents(json.data ?? []);
    } catch {
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }

  async function assign(userId: string | null) {
    setSaving(true);
    try {
      const res = await fetch("/api/helpdesk/tickets/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticketIds: [ticket.id],
          action: "assignPrimary",
          userId,
        }),
      });
      if (!res.ok) throw new Error(`assign ${res.status}`);
      setAssigned(userId ? agents?.find((a) => a.id === userId) ?? null : null);
      setOpen(false);
      onAssigned();
    } finally {
      setSaving(false);
    }
  }

  const assignedLabel = assigned
    ? assigned.name ?? assigned.handle ?? assigned.email ?? "Assigned"
    : "Assign";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled || saving}
        onClick={() => {
          setOpen((v) => !v);
          void loadAgents();
        }}
        title={
          assigned
            ? `Assigned to ${assignedLabel}. Click to reassign.`
            : "Assign agent"
        }
        className={cn(
          "inline-flex h-7 max-w-[11rem] items-center gap-1 rounded-md border border-hairline-strong/70 bg-surface px-2 text-[11px] text-foreground/75 transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer",
          assigned && "border-brand/35 bg-brand-muted/60 text-brand",
        )}
      >
        {saving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : assigned ? (
          <SmallAgentAvatar user={assigned} />
        ) : (
          <UserPlus className="h-3.5 w-3.5" />
        )}
        <span className="min-w-0 truncate">{assignedLabel}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-56 rounded-md border border-hairline bg-popover p-1 text-popover-foreground shadow-xl">
          {loading ? (
            <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading agents
            </div>
          ) : agents && agents.length > 0 ? (
            agents.map((agent) => {
              const label = agent.name ?? agent.handle ?? agent.email ?? "Agent";
              const active = assigned?.id === agent.id;
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => void assign(agent.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-surface-2 cursor-pointer",
                    active && "bg-surface-2 font-medium",
                  )}
                >
                  <SmallAgentAvatar user={agent} />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {active ? <Check className="h-3.5 w-3.5" /> : null}
                </button>
              );
            })
          ) : (
            <div className="px-2.5 py-2 text-xs text-muted-foreground">
              No agents available.
            </div>
          )}
          {assigned ? (
            <>
              <div className="my-1 h-px bg-hairline" aria-hidden />
              <button
                type="button"
                onClick={() => void assign(null)}
                className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs text-red-600 hover:bg-surface-2 dark:text-red-300 cursor-pointer"
              >
                Unassign
              </button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

function SmallAgentAvatar({ user }: { user: AgentOption }) {
  const label = user.name ?? user.handle ?? user.email ?? "Agent";
  if (user.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={user.avatarUrl}
        alt=""
        className="h-4 w-4 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[9px] font-semibold uppercase text-brand">
      {agentInitials(label)}
    </span>
  );
}

function agentInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const chars =
    parts.length >= 2
      ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`
      : name.slice(0, 2);
  return chars.toUpperCase() || "?";
}

function buildMessageFormData(
  body: {
    composerMode: ComposerMode;
    bodyText: string;
    sendDelaySeconds: number;
    setStatus?: "WAITING" | "RESOLVED";
  },
  attachments: ComposerAttachment[],
): FormData {
  const form = new FormData();
  form.set("composerMode", body.composerMode);
  form.set("bodyText", body.bodyText);
  form.set("sendDelaySeconds", String(body.sendDelaySeconds));
  if (body.setStatus) form.set("setStatus", body.setStatus);
  for (const attachment of attachments) {
    form.append("attachments", attachment.file, attachment.fileName);
  }
  return form;
}

function makeClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function ticketToContext(
  ticket: HelpdeskTicketDetail,
  tracking: {
    number: string | null;
    carrier: string | null;
    deliveryName?: string | null;
    buyerName?: string | null;
  } = {
    number: null,
    carrier: null,
  },
): TemplateContext {
  return {
    buyerName: tracking.buyerName ?? ticket.buyerName,
    buyerUserId: ticket.buyerUserId,
    deliveryName: tracking.deliveryName,
    ebayItemId: ticket.ebayItemId,
    ebayItemTitle: ticket.ebayItemTitle,
    ebayOrderNumber: ticket.ebayOrderNumber,
    storeName: ticket.integrationLabel,
    // Pulled lazily from the order-context endpoint (see useEffect above).
    // Stays null for pre-sales tickets and non-eBay channels — templates
    // that reference {{trackingNumber}} render the empty fallback in that
    // case (matches AutoResponder template-fill behaviour).
    trackingNumber: tracking.number,
  };
}

function canReply(ticket: HelpdeskTicketDetail): boolean {
  // Replies now send through the Commerce Message API. That path can target
  // an existing conversation when we have one, or fall back to the buyer's
  // eBay username. Do not block RESOLVED tickets just because their original
  // inbound row came from a legacy/source-mismatched sync path.
  const ebayChannel = ticket.channel === "TPP_EBAY" || ticket.channel === "TT_EBAY";
  return ebayChannel && Boolean(ticket.buyerUserId);
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
          : "text-foreground/70 hover:text-foreground hover:bg-surface-2",
        disabled && "opacity-45 cursor-not-allowed hover:bg-transparent",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
