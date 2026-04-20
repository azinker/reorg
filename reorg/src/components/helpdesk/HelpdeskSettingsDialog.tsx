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

export interface HelpdeskPrefs {
  sendDelaySeconds: number;
  autoAdvance: boolean;
  autoMarkRead: boolean;
  density: "comfortable" | "compact";
  layout: HelpdeskLayout;
  threadWidthPct: number;
  inboxWidthPct: number;
}

const DEFAULTS: HelpdeskPrefs = {
  sendDelaySeconds: 5,
  autoAdvance: true,
  autoMarkRead: true,
  density: "comfortable",
  layout: "split",
  threadWidthPct: 55,
  inboxWidthPct: 26,
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
      threadWidthPct: clampInt(parsed.threadWidthPct, 35, 75, DEFAULTS.threadWidthPct),
      inboxWidthPct: clampInt(parsed.inboxWidthPct, 15, 45, DEFAULTS.inboxWidthPct),
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
    prev.inboxWidthPct !== p.inboxWidthPct;
  if (!changed) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  window.dispatchEvent(new CustomEvent("helpdesk:prefs-changed", { detail: p }));
}

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number.parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/** Hook for components that want to read live prefs and react to changes. */
export function useHelpdeskPrefs(): HelpdeskPrefs {
  const [prefs, setPrefs] = useState<HelpdeskPrefs>(DEFAULTS);
  useEffect(() => {
    setPrefs(readPrefs());
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
        </div>

        <p className="mt-5 text-[10px] text-muted-foreground">
          Stored locally in your browser. Changes apply immediately.
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
