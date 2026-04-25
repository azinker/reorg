"use client";

/**
 * Per-user Help Desk preferences. v1 stores everything in localStorage so
 * we don't need a server-side User table change for this small surface.
 *
 * Settings:
 *   - sendDelaySeconds  (1-10, default 5)  — composer countdown before sending
 *   - autoAdvance       (bool)             — after Resolve, jump to next ticket
 *   - autoMarkRead      (bool)             — clear unread on open (server already does)
 *   - density           ("comfortable" | "compact")
 *   - layout            ("split" | "list") — split is the classic 4-pane view
 *                                             list is full-width inbox + modal reader
 *   - threadWidthPct    (35-75, default 55) — % of the main area the thread+composer takes
 *                                              when in split layout. The remainder is the
 *                                              context panel; user-resizable via drag handle.
 *   - inboxWidthPct     (15-45, default 26) — % of the page main column the ticket list takes
 *                                              when in split layout. The remainder is the
 *                                              reader (thread + context). User-resizable.
 */

import { startTransition, useEffect, useState } from "react";
import { Settings, X } from "lucide-react";

const STORAGE_KEY = "helpdesk:prefs:v1";

export type HelpdeskLayout = "split" | "list";

/**
 * Action the composer's primary "Send" button performs after a successful
 * outbound message:
 *   - "RESOLVED" — close the ticket and (with autoAdvance) move on
 *   - "WAITING"  — keep the ticket open in WAITING (await buyer reply)
 *   - "NONE"     — leave the status untouched
 *
 * Mirrors the eDesk-style "send and mark as…" preference. Persisted on
 * the User row server-side via /api/helpdesk/me/prefs so it follows the
 * agent across browsers; localStorage acts as a synchronous cache so the
 * composer doesn't flash the wrong default during initial hydration.
 */
export type HelpdeskDefaultSendStatus = "RESOLVED" | "WAITING" | "NONE";

/**
 * Color theme applied to the agent's outbound message bubbles in the
 * thread. The original default was reorG brand red, but agents
 * overwhelmingly preferred a calmer purple — so "purple" is now the new
 * default and the rest of the palette is exposed as personal taste.
 *
 * Each value maps to a Tailwind color family in
 * `agentBubbleClasses()` below; we deliberately use Tailwind's stable
 * semantic colors (violet/blue/emerald/amber/rose) rather than minting
 * new CSS variables so dark-mode contrast Just Works.
 */
export type HelpdeskAgentBubbleAccent =
  | "purple"
  | "blue"
  | "emerald"
  | "amber"
  | "red";

export interface HelpdeskPrefs {
  sendDelaySeconds: number;
  autoAdvance: boolean;
  autoMarkRead: boolean;
  density: "comfortable" | "compact";
  layout: HelpdeskLayout;
  threadWidthPct: number;
  inboxWidthPct: number;
  defaultSendStatus: HelpdeskDefaultSendStatus;
  agentBubbleAccent: HelpdeskAgentBubbleAccent;
}

const DEFAULTS: HelpdeskPrefs = {
  sendDelaySeconds: 5,
  autoAdvance: true,
  autoMarkRead: true,
  density: "comfortable",
  layout: "split",
  threadWidthPct: 55,
  inboxWidthPct: 26,
  // v2 spec: replying to a buyer typically means "this is handled" —
  // close the ticket. Agents who want the old WAITING behaviour change
  // this once in Settings and it sticks (server-side persisted).
  defaultSendStatus: "RESOLVED",
  // Agents reported the brand-red outbound bubble felt "alarming" against
  // a long INBOUND thread. Purple is the reorG primary hue and reads as
  // "ours" without screaming "error".
  agentBubbleAccent: "purple",
};

function readPrefs(): HelpdeskPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<HelpdeskPrefs>;
    return {
      sendDelaySeconds: clampInt(parsed.sendDelaySeconds, 1, 10, DEFAULTS.sendDelaySeconds),
      autoAdvance: typeof parsed.autoAdvance === "boolean" ? parsed.autoAdvance : DEFAULTS.autoAdvance,
      autoMarkRead: typeof parsed.autoMarkRead === "boolean" ? parsed.autoMarkRead : DEFAULTS.autoMarkRead,
      density: parsed.density === "compact" ? "compact" : "comfortable",
      layout: parsed.layout === "list" ? "list" : "split",
      threadWidthPct: clampInt(parsed.threadWidthPct, 35, 90, DEFAULTS.threadWidthPct),
      inboxWidthPct: clampInt(parsed.inboxWidthPct, 15, 45, DEFAULTS.inboxWidthPct),
      defaultSendStatus:
        parsed.defaultSendStatus === "WAITING" ||
        parsed.defaultSendStatus === "NONE" ||
        parsed.defaultSendStatus === "RESOLVED"
          ? parsed.defaultSendStatus
          : DEFAULTS.defaultSendStatus,
      agentBubbleAccent:
        parsed.agentBubbleAccent === "purple" ||
        parsed.agentBubbleAccent === "blue" ||
        parsed.agentBubbleAccent === "emerald" ||
        parsed.agentBubbleAccent === "amber" ||
        parsed.agentBubbleAccent === "red"
          ? parsed.agentBubbleAccent
          : DEFAULTS.agentBubbleAccent,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Imperative setter for prefs (used by header layout toggle, drag-handle persist). */
export function updateHelpdeskPrefs(patch: Partial<HelpdeskPrefs>) {
  const prev = readPrefs();
  const next = { ...prev, ...patch };
  writePrefs(next, prev);
}

/**
 * Persist + (conditionally) broadcast prefs.
 *
 * The broadcast is what wakes up every `useHelpdeskPrefs` consumer (header,
 * sidebar, list, composer, modal, settings dialog) and forces a re-render.
 * Suppressing it on no-op writes prevents a chain reaction whenever any
 * caller pessimistically re-saves the same prefs (e.g. on every drag
 * `commit` even when the value didn't change at the integer-percent level).
 */
function writePrefs(p: HelpdeskPrefs, previous?: HelpdeskPrefs) {
  if (typeof window === "undefined") return;
  const prev = previous ?? readPrefs();
  const changed =
    prev.sendDelaySeconds !== p.sendDelaySeconds ||
    prev.autoAdvance !== p.autoAdvance ||
    prev.autoMarkRead !== p.autoMarkRead ||
    prev.density !== p.density ||
    prev.layout !== p.layout ||
    prev.threadWidthPct !== p.threadWidthPct ||
    prev.inboxWidthPct !== p.inboxWidthPct ||
    prev.defaultSendStatus !== p.defaultSendStatus ||
    prev.agentBubbleAccent !== p.agentBubbleAccent;
  if (!changed) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  window.dispatchEvent(new CustomEvent("helpdesk:prefs-changed", { detail: p }));
}

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number.parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/**
 * One-shot server hydration: pulls `defaultSendStatus` from
 * /api/helpdesk/me/prefs and merges it into localStorage so future reads
 * are synchronous. Failures are non-fatal — we just stay on whatever
 * value localStorage had (or the DEFAULTS fallback).
 */
let serverHydrationPromise: Promise<void> | null = null;
function hydrateFromServerOnce(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (serverHydrationPromise) return serverHydrationPromise;
  serverHydrationPromise = (async () => {
    try {
      const res = await fetch("/api/helpdesk/me/prefs", {
        credentials: "same-origin",
      });
      if (!res.ok) return;
      const json = (await res.json()) as {
        data?: { defaultSendStatus?: HelpdeskDefaultSendStatus };
      };
      const next = json?.data?.defaultSendStatus;
      if (next !== "RESOLVED" && next !== "WAITING" && next !== "NONE") return;
      const prev = readPrefs();
      if (prev.defaultSendStatus === next) return;
      writePrefs({ ...prev, defaultSendStatus: next }, prev);
    } catch {
      // Network failure / unauthenticated. The composer already has a
      // sensible default; nothing to do.
    }
  })();
  return serverHydrationPromise;
}

/**
 * Tailwind class triplet for the agent message bubble, keyed by the
 * agent's chosen accent. Returns:
 *   - bubble    : border + background + text classes for the chat bubble
 *   - name      : text color for the displayed agent name above the bubble
 *   - dotBg     : muted background for fallback avatar / accent dots
 *   - swatch    : solid swatch class used in the settings dialog preview
 *
 * We hard-code each combination (instead of `border-${color}-500/50`) so
 * Tailwind's JIT picks them up at build time — interpolated class names
 * silently get tree-shaken away in production.
 */
export function agentBubbleClasses(accent: HelpdeskAgentBubbleAccent): {
  bubble: string;
  name: string;
  dotBg: string;
  swatch: string;
} {
  switch (accent) {
    case "purple":
      return {
        bubble:
          "border-violet-500/50 bg-violet-500/10 text-foreground dark:bg-violet-500/15",
        name: "text-violet-700 dark:text-violet-300",
        dotBg: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
        swatch: "bg-violet-500",
      };
    case "blue":
      return {
        bubble:
          "border-sky-500/50 bg-sky-500/10 text-foreground dark:bg-sky-500/15",
        name: "text-sky-700 dark:text-sky-300",
        dotBg: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
        swatch: "bg-sky-500",
      };
    case "emerald":
      return {
        bubble:
          "border-emerald-500/50 bg-emerald-500/10 text-foreground dark:bg-emerald-500/15",
        name: "text-emerald-700 dark:text-emerald-300",
        dotBg: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        swatch: "bg-emerald-500",
      };
    case "amber":
      return {
        bubble:
          "border-amber-500/50 bg-amber-500/10 text-foreground dark:bg-amber-500/15",
        name: "text-amber-700 dark:text-amber-300",
        dotBg: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
        swatch: "bg-amber-500",
      };
    case "red":
    default:
      return {
        bubble: "border-brand/50 bg-brand-muted text-foreground",
        name: "text-brand",
        dotBg: "bg-brand-muted text-brand",
        swatch: "bg-brand",
      };
  }
}

/** Imperative server-side persist for the defaultSendStatus pref. */
export function persistDefaultSendStatusToServer(
  value: HelpdeskDefaultSendStatus,
): void {
  if (typeof window === "undefined") return;
  void fetch("/api/helpdesk/me/prefs", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ defaultSendStatus: value }),
  }).catch(() => {
    // Server-side write failed; the local pref still applies for this
    // session and will be retried next time the agent edits it.
  });
}

/** Hook for components that want to read live prefs and react to changes. */
export function useHelpdeskPrefs(): HelpdeskPrefs {
  const [prefs, setPrefs] = useState<HelpdeskPrefs>(() => readPrefs());
  useEffect(() => {
    setPrefs(readPrefs());
    void hydrateFromServerOnce();
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as HelpdeskPrefs | undefined;
      if (!detail) return;
      // The most expensive prefs change by far is `layout` — flipping
      // between split and list re-shapes the entire help-desk tree
      // (TicketList moves in/out of the resizable split, TicketReader
      // gets a new parent). React treats that as a full unmount→remount
      // of both subtrees, which on a production thread with long eBay
      // HTML messages can take tens of seconds of synchronous work.
      //
      // Marking the layout change as a React 18 transition lets the
      // click handler that triggered it resolve immediately and allows
      // the heavy re-render to be interrupted by subsequent user input,
      // so the page never feels frozen while the work is in flight.
      // Density / drag-handle / autoAdvance changes are cheap and stay
      // synchronous so they apply visually on the next frame.
      const layoutChanged = detail.layout !== prefs.layout;
      if (layoutChanged) {
        startTransition(() => setPrefs(detail));
      } else {
        setPrefs(detail);
      }
    };
    window.addEventListener("helpdesk:prefs-changed", onChange);
    return () => window.removeEventListener("helpdesk:prefs-changed", onChange);
    // We intentionally only subscribe once on mount; the closure reads
    // `prefs` for the layout-change comparison via React's stale-closure
    // capture. That's fine because `setPrefs` itself is the trigger and
    // any miss just falls back to a synchronous update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return prefs;
}

interface HelpdeskSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function HelpdeskSettingsDialog({ open, onClose }: HelpdeskSettingsDialogProps) {
  const [prefs, setPrefs] = useState<HelpdeskPrefs>(DEFAULTS);

  useEffect(() => {
    if (open) setPrefs(readPrefs());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function update<K extends keyof HelpdeskPrefs>(key: K, value: HelpdeskPrefs[K]) {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    writePrefs(next, prefs);
    // Server-side prefs need an explicit network write — localStorage
    // alone wouldn't survive a browser change.
    if (key === "defaultSendStatus") {
      persistDefaultSendStatusToServer(value as HelpdeskDefaultSendStatus);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
        className="w-full max-w-md rounded-lg border border-hairline bg-card p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-brand" />
            <h2 className="text-base font-semibold text-foreground">
              Help Desk preferences
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
            aria-label="Close settings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 text-sm">
          <Field
            label="Send delay"
            description="Seconds the composer waits before actually sending. Click Undo to cancel."
          >
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={1}
                max={10}
                value={prefs.sendDelaySeconds}
                onChange={(e) => update("sendDelaySeconds", Number(e.target.value))}
                className="flex-1 cursor-pointer accent-brand"
              />
              <span className="w-10 text-right text-foreground">
                {prefs.sendDelaySeconds}s
              </span>
            </div>
          </Field>

          <Field
            label="Auto-advance"
            description="After resolving a ticket, jump to the next one in the list."
          >
            <Toggle
              checked={prefs.autoAdvance}
              onChange={(v) => update("autoAdvance", v)}
            />
          </Field>

          <Field
            label="Auto-mark read"
            description="Clear the unread badge as soon as you open a ticket."
          >
            <Toggle
              checked={prefs.autoMarkRead}
              onChange={(v) => update("autoMarkRead", v)}
            />
          </Field>

          <Field
            label="Density"
            description="Affects the ticket list row height."
          >
            <select
              value={prefs.density}
              onChange={(e) =>
                update("density", e.target.value as HelpdeskPrefs["density"])
              }
              className="h-8 rounded-md border border-hairline bg-surface px-2 text-foreground"
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </Field>

          <Field
            label="Default Send action"
            description="What happens to the ticket when you press the composer's primary Send button."
          >
            <select
              value={prefs.defaultSendStatus}
              onChange={(e) =>
                update(
                  "defaultSendStatus",
                  e.target.value as HelpdeskDefaultSendStatus,
                )
              }
              className="h-8 rounded-md border border-hairline bg-surface px-2 text-foreground"
            >
              <option value="RESOLVED">Send + Resolve</option>
              <option value="WAITING">Send + Mark Waiting</option>
              <option value="NONE">Send only (keep status)</option>
            </select>
          </Field>

          <Field
            label="Agent message color"
            description="Background color of your outgoing messages in the thread."
          >
            <div className="flex items-center gap-1.5">
              {(
                [
                  { value: "purple", label: "Purple" },
                  { value: "blue", label: "Blue" },
                  { value: "emerald", label: "Green" },
                  { value: "amber", label: "Amber" },
                  { value: "red", label: "Red" },
                ] as const
              ).map((opt) => {
                const cls = agentBubbleClasses(opt.value);
                const active = prefs.agentBubbleAccent === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => update("agentBubbleAccent", opt.value)}
                    title={opt.label}
                    aria-label={opt.label}
                    aria-pressed={active}
                    className={
                      "relative h-6 w-6 rounded-full border-2 transition-all cursor-pointer " +
                      cls.swatch +
                      " " +
                      (active
                        ? "border-foreground scale-110 shadow-md"
                        : "border-transparent hover:scale-105")
                    }
                  />
                );
              })}
            </div>
          </Field>
        </div>

        <p className="mt-5 text-[10px] text-muted-foreground">
          Layout, density, separator widths, and accent color are saved on this browser per agent.
          Default Send action is saved across browsers.
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-start gap-3">
      <div>
        <div className="font-medium text-foreground">{label}</div>
        {description && (
          <p className="text-[11px] text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex items-center justify-end pt-0.5">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer " +
        (checked ? "bg-brand" : "bg-surface-2 border border-hairline")
      }
      aria-pressed={checked}
    >
      <span
        className={
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform " +
          (checked ? "translate-x-4" : "translate-x-0.5")
        }
      />
    </button>
  );
}
