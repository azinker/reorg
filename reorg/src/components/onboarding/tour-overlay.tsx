"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TourStep {
  id: string;
  /** `data-tour` attribute value on target element, or null for centered step */
  target: string | null;
  title: string;
  body: string;
}

interface TourOverlayProps {
  open: boolean;
  steps: TourStep[];
  stepIndex: number;
  onNext: () => void;
  onBack: () => void;
  onExit: () => void;
  onComplete: () => void;
}

const PADDING = 10;
const Z = 200;
const TOOLTIP_MAX_W = 440;

function queryTarget(tourId: string | null): HTMLElement | null {
  if (!tourId || typeof document === "undefined") return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(tourId)) return null;
  return document.querySelector(`[data-tour="${tourId}"]`) as HTMLElement | null;
}

export function TourOverlay({
  open,
  steps,
  stepIndex,
  onNext,
  onBack,
  onExit,
  onComplete,
}: TourOverlayProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number; maxWidth: number }>({
    top: 0,
    left: 0,
    maxWidth: 360,
  });

  const step = steps[stepIndex];
  const isLast = stepIndex >= steps.length - 1;
  const isFirst = stepIndex <= 0;

  const updatePositions = useCallback(() => {
    if (!open || !step) return;
    if (step.target == null) {
      setRect(null);
      const vw = typeof window !== "undefined" ? window.innerWidth : 800;
      const vh = typeof window !== "undefined" ? window.innerHeight : 600;
      setTooltipPos({
        top: vh / 2,
        left: vw / 2,
        maxWidth: Math.min(TOOLTIP_MAX_W, vw - 32),
      });
      return;
    }

    const el = queryTarget(step.target);
    if (!el) {
      setRect(null);
      const vw = typeof window !== "undefined" ? window.innerWidth : 800;
      const vh = typeof window !== "undefined" ? window.innerHeight : 600;
      setTooltipPos({
        top: vh / 2,
        left: vw / 2,
        maxWidth: Math.min(TOOLTIP_MAX_W, vw - 32),
      });
      return;
    }

    const r = el.getBoundingClientRect();
    if (r.width < 8 && r.height < 8) {
      setRect(null);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      setTooltipPos({
        top: vh / 2,
        left: vw / 2,
        maxWidth: Math.min(TOOLTIP_MAX_W, vw - 32),
      });
      return;
    }
    const padded = new DOMRect(
      r.left - PADDING,
      r.top - PADDING,
      r.width + PADDING * 2,
      r.height + PADDING * 2,
    );
    setRect(padded);

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardW = Math.min(TOOLTIP_MAX_W, vw - 24);
    const cardH = 280;
    let left = padded.left + padded.width / 2 - cardW / 2;
    let top = padded.bottom + 16;

    if (top + cardH > vh - 16) {
      top = Math.max(16, padded.top - cardH - 16);
    }
    left = Math.max(12, Math.min(left, vw - cardW - 12));
    top = Math.max(12, Math.min(top, vh - cardH - 12));

    setTooltipPos({ top, left, maxWidth: cardW });
  }, [open, step]);

  useLayoutEffect(() => {
    updatePositions();
  }, [updatePositions, stepIndex]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => updatePositions();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    const id = window.setInterval(updatePositions, 400);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      window.clearInterval(id);
    };
  }, [open, updatePositions]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || !step || typeof document === "undefined") return null;

  const handlePrimary = () => {
    if (isLast) onComplete();
    else onNext();
  };

  return createPortal(
    <div
      className="fixed inset-0 isolate"
      style={{ zIndex: Z }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-step-title"
      aria-describedby="tour-step-body"
    >
      {/* Full-screen dim when no spotlight target */}
      {!rect && (
        <div className="pointer-events-none absolute inset-0 z-[1] bg-black/75" aria-hidden />
      )}

      {/* Spotlight: ring + huge box-shadow = dim outside hole */}
      {rect && (
        <div
          className="pointer-events-none absolute z-[2] rounded-xl border-2 border-primary ring-2 ring-primary/30"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.75)",
          }}
          aria-hidden
        />
      )}

      {/* Block clicks on the app (tooltip is above and stops propagation) */}
      <button
        type="button"
        className="absolute inset-0 z-[3] cursor-default bg-transparent"
        aria-label="Tour backdrop"
        onClick={(e) => e.preventDefault()}
      />

      {/* Tooltip card */}
      <div
        id="tour-tooltip-card"
        className={cn(
          "absolute max-h-[min(72vh,560px)] overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-2xl",
          step.target == null && rect == null && "-translate-x-1/2 -translate-y-1/2",
        )}
        style={{
          top: step.target == null && rect == null ? "50%" : tooltipPos.top,
          left: step.target == null && rect == null ? "50%" : tooltipPos.left,
          maxWidth: tooltipPos.maxWidth,
          width:
            step.target == null && rect == null
              ? Math.min(TOOLTIP_MAX_W, tooltipPos.maxWidth)
              : tooltipPos.maxWidth,
          zIndex: Z + 10,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between gap-2">
          <h2 id="tour-step-title" className="text-base font-semibold text-foreground">
            {step.title}
          </h2>
          <button
            type="button"
            onClick={onExit}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            title="Exit tour"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p
          id="tour-step-body"
          className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground"
        >
          {step.body}
        </p>
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
          <span className="text-xs text-muted-foreground">
            Step {stepIndex + 1} of {steps.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onBack}
              disabled={isFirst}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40 cursor-pointer"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Back
            </button>
            <button
              type="button"
              onClick={handlePrimary}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer"
            >
              {isLast ? "Finish" : "Next"}
              {!isLast && <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
