"use client";

/**
 * Two-pane horizontal split with a draggable divider. Used inside the Help Desk
 * to let agents balance the message thread (left) against the context panel
 * (right) when the window gets narrow.
 *
 * The split percentage is reported back via `onChange` (called on every drag
 * tick, throttled to one paint frame) and finalised via `onCommit` (called
 * once on pointer release / keyboard nudge release). The parent is expected
 * to persist `onCommit` and use `onChange` only for live preview if it wants
 * to — to avoid a re-render storm during the drag we render the live
 * percentage from internal state during the drag and only sync the parent's
 * value back in once the drag finishes.
 *
 * Why two callbacks: in the Help Desk the parent's `onChange` writes to
 * localStorage AND broadcasts a `helpdesk:prefs-changed` event that re-renders
 * the entire inbox tree (TicketList virtualization, ThreadView, ContextPanel).
 * Doing that 60–120× per second froze the page mid-drag. Driving the divider
 * from local state during the drag and committing once at the end keeps the
 * parent prefs subscription quiet until the user lets go.
 *
 * Constraints:
 *   - `min` / `max` clamp the left pane percentage; default 35–75
 *   - We measure the container on every drag tick so behaviour is stable when
 *     the parent itself resizes (e.g. when toggling the folder sidebar)
 *   - `setPointerCapture` is used so the divider keeps receiving move events
 *     even when a heavy frame stalls hit-testing
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { GripVertical } from "lucide-react";

interface HelpdeskSplitProps {
  /** % of horizontal space the left pane gets (0–100). */
  value: number;
  /**
   * Called continuously during the drag with the live percentage. Optional —
   * if you only care about the final value, pass `onCommit` and skip this.
   * The parent is responsible for keeping this handler cheap (no React state
   * churn that re-renders heavy subtrees).
   */
  onChange?: (pct: number) => void;
  /**
   * Called once when the drag ends (pointerup, keyboard release, lostpointercapture).
   * If `onChange` is not provided, this is the only callback you'll receive.
   */
  onCommit?: (pct: number) => void;
  min?: number;
  max?: number;
  left: React.ReactNode;
  right: React.ReactNode;
  className?: string;
}

export function HelpdeskSplit({
  value,
  onChange,
  onCommit,
  min = 35,
  max = 75,
  left,
  right,
  className,
}: HelpdeskSplitProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dividerRef = useRef<HTMLDivElement | null>(null);

  // `localPct` drives the layout while dragging. We seed it from `value`
  // and only sync back to `value` when not dragging, so a parent that
  // updates `value` from a debounced commit doesn't fight the drag.
  const [localPct, setLocalPct] = useState<number>(() =>
    clamp(value, min, max),
  );
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const pendingPctRef = useRef<number | null>(null);
  const activePointerIdRef = useRef<number | null>(null);

  // Sync external `value` → `localPct` only when we're not in the middle of a
  // drag. Otherwise the parent's stale value would yank the divider back.
  useEffect(() => {
    if (draggingRef.current) return;
    setLocalPct(clamp(value, min, max));
  }, [value, min, max]);

  const flushPending = useCallback(() => {
    rafRef.current = null;
    const next = pendingPctRef.current;
    if (next == null) return;
    pendingPctRef.current = null;
    setLocalPct(next);
    onChange?.(next);
  }, [onChange]);

  const scheduleUpdate = useCallback(
    (pct: number) => {
      pendingPctRef.current = pct;
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(flushPending);
    },
    [flushPending],
  );

  const computePctFromClientX = useCallback(
    (clientX: number): number | null => {
      const el = containerRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const raw = ((clientX - rect.left) / rect.width) * 100;
      return clamp(raw, min, max);
    },
    [min, max],
  );

  const endDrag = useCallback(
    (commitPct: number | null) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";

      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      const finalPct =
        commitPct ?? pendingPctRef.current ?? localPct;
      pendingPctRef.current = null;

      const divider = dividerRef.current;
      const pid = activePointerIdRef.current;
      if (divider && pid != null) {
        try {
          divider.releasePointerCapture(pid);
        } catch {
          // Already released (e.g. element unmounted) — fine.
        }
      }
      activePointerIdRef.current = null;

      setLocalPct(finalPct);
      onCommit?.(finalPct);
    },
    [localPct, onCommit],
  );

  // Cleanup on unmount: if the component goes away mid-drag, restore body styles.
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (draggingRef.current) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Only start on primary button (or any touch / pen contact).
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    const divider = dividerRef.current;
    if (divider) {
      try {
        divider.setPointerCapture(e.pointerId);
      } catch {
        // Older browsers / detached elements: drag still works via element-level events.
      }
    }
    activePointerIdRef.current = e.pointerId;
    draggingRef.current = true;
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    if (activePointerIdRef.current !== e.pointerId) return;
    const next = computePctFromClientX(e.clientX);
    if (next == null) return;
    scheduleUpdate(next);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    if (activePointerIdRef.current !== e.pointerId) return;
    const next = computePctFromClientX(e.clientX);
    endDrag(next);
  }

  function onPointerCancel(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    if (activePointerIdRef.current !== e.pointerId) return;
    endDrag(null);
  }

  function onLostPointerCapture(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    if (activePointerIdRef.current !== e.pointerId) return;
    endDrag(null);
  }

  // Keyboard accessibility — arrow keys nudge by 2%. Each press commits.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      const next = clamp(localPct - 2, min, max);
      setLocalPct(next);
      onChange?.(next);
      onCommit?.(next);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = clamp(localPct + 2, min, max);
      setLocalPct(next);
      onChange?.(next);
      onCommit?.(next);
    } else if (e.key === "Home") {
      e.preventDefault();
      setLocalPct(min);
      onChange?.(min);
      onCommit?.(min);
    } else if (e.key === "End") {
      e.preventDefault();
      setLocalPct(max);
      onChange?.(max);
      onCommit?.(max);
    }
  }

  const leftPct = clamp(localPct, min, max);
  const rightPct = 100 - leftPct;

  return (
    <div
      ref={containerRef}
      className={cn("relative flex h-full w-full", className)}
    >
      <div
        className="flex h-full min-w-0 flex-col"
        style={{ width: `${leftPct}%` }}
      >
        {left}
      </div>
      <div
        ref={dividerRef}
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(leftPct)}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onLostPointerCapture}
        onKeyDown={onKeyDown}
        className={cn(
          "group relative z-10 flex w-1.5 shrink-0 cursor-col-resize touch-none items-center justify-center bg-hairline transition-colors hover:bg-brand/40 focus-visible:bg-brand/40 focus-visible:outline-none",
          dragging && "bg-brand/60",
        )}
        title="Drag to resize"
      >
        <span className="pointer-events-none absolute inset-y-0 -left-1 -right-1" />
        <GripVertical className="pointer-events-none h-3 w-3 text-muted-foreground group-hover:text-foreground" />
      </div>
      <div
        className="flex h-full min-w-0 flex-col"
        style={{ width: `${rightPct}%` }}
      >
        {right}
      </div>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
