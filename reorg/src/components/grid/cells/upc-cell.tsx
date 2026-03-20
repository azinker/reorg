"use client";

import { useEffect, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import { AlertTriangle, Check, Copy, Loader2, X } from "lucide-react";
import { copySvgElementImage } from "@/lib/client-clipboard";
import { cn } from "@/lib/utils";

type UpcQuickPushPhase =
  | "idle"
  | "dry-run"
  | "ready"
  | "pushing"
  | "success"
  | "error"
  | "blocked";

interface UpcCellProps {
  upc: string | null;
  stagedUpc?: string | null;
  editable?: boolean;
  canPush?: boolean;
  pushTargets?: Array<{
    platform: string;
    label: string;
    listingId: string;
  }>;
  quickPushState?: {
    phase: UpcQuickPushPhase;
    detail?: string;
  };
  onSave?: (value: string, mode: "stage" | "push" | "fastPush") => void;
  onReviewPush?: () => void;
  onFastPush?: () => void;
  onReviewPushTarget?: (platform: string, listingId: string) => void;
  onFastPushTarget?: (platform: string, listingId: string) => void;
  onDiscard?: () => void;
}

function CopyNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="absolute -top-6 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-2 py-0.5 text-[10px] font-medium text-background shadow-lg">
      Copied!
    </span>
  );
}

function renderCompactButtonLabel(text: string) {
  const parts = text.split(" ");
  if (parts.length === 1) return <span>{text}</span>;
  return (
    <span className="flex flex-col items-center leading-[1.05]">
      {parts.map((part) => (
        <span key={part}>{part}</span>
      ))}
    </span>
  );
}

export function UpcCell({
  upc,
  stagedUpc = null,
  editable = false,
  canPush = false,
  pushTargets = [],
  quickPushState,
  onSave,
  onReviewPush,
  onFastPush,
  onReviewPushTarget,
  onFastPushTarget,
  onDiscard,
}: UpcCellProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [copied, setCopied] = useState(false);
  const [imageCopied, setImageCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [showActions, setShowActions] = useState(false);
  const [selectorMode, setSelectorMode] = useState<"review" | "fast" | null>(null);
  const quickPhase = quickPushState?.phase ?? "idle";
  const displayedUpc = stagedUpc ?? upc;
  const effectiveUpc = stagedUpc ?? upc ?? "";
  const hasMultipleTargets = pushTargets.length > 1;

  useEffect(() => {
    if (!stagedUpc) {
      setSelectorMode(null);
    }
  }, [stagedUpc]);

  useEffect(() => {
    if (quickPhase === "success") {
      setSelectorMode(null);
    }
  }, [quickPhase]);

  useEffect(() => {
    if (editing) return;
    if (!svgRef.current) return;

    if (!displayedUpc) {
      const svg = svgRef.current;
      svg.setAttribute("viewBox", "0 0 160 55");
      svg.innerHTML = `
        <rect width="160" height="55" fill="transparent"/>
        <line x1="10" y1="28" x2="150" y2="28" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>
        <text x="80" y="22" text-anchor="middle" fill="currentColor" font-size="12" font-family="monospace" opacity="0.5">NO UPC</text>
        <text x="80" y="42" text-anchor="middle" fill="currentColor" font-size="9" font-family="monospace" opacity="0.35">AVAILABLE</text>
      `;
      return;
    }

    const opts = {
      width: 1.8,
      height: 48,
      displayValue: false,
      margin: 4,
      background: "transparent",
      lineColor: "currentColor",
    };

    let format = "CODE128";
    if (displayedUpc.length === 12) format = "UPC";
    else if (displayedUpc.length === 13) format = "EAN13";

    try {
      JsBarcode(svgRef.current, displayedUpc, { ...opts, format });
    } catch {
      try {
        JsBarcode(svgRef.current!, displayedUpc, { ...opts, format: "CODE128" });
      } catch {
        if (svgRef.current) svgRef.current.innerHTML = "";
      }
    }
  }, [displayedUpc, editing]);

  function handleCopy() {
    if (!displayedUpc) return;
    void navigator.clipboard.writeText(displayedUpc);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleCopyImage() {
    if (!displayedUpc || !svgRef.current) return;
    try {
      await copySvgElementImage(svgRef.current);
      setImageCopied(true);
      setTimeout(() => setImageCopied(false), 1500);
    } catch (error) {
      console.error("[upc-cell] failed to copy barcode image", error);
    }
  }

  function renderFastPushLabel() {
    if (quickPhase === "dry-run" || quickPhase === "ready") {
      return (
        <>
          <Loader2 className="h-3 w-3 animate-spin" />
          Checking
        </>
      );
    }
    if (quickPhase === "pushing") {
      return (
        <>
          <Loader2 className="h-3 w-3 animate-spin" />
          Pushing
        </>
      );
    }
    if (quickPhase === "success") {
      return (
        <>
          <Check className="h-3 w-3" />
          Pushed
        </>
      );
    }
    if (quickPhase === "error" || quickPhase === "blocked") {
      return (
        <>
          <AlertTriangle className="h-3 w-3" />
          Retry
        </>
      );
    }
    return "Fast Push";
  }

  function startEdit() {
    if (!editable) return;
    setDraft(stagedUpc ?? upc ?? "");
    setShowActions(false);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setShowActions(false);
  }

  function normalizedDraft() {
    return draft.trim();
  }

  function hasDraftChange() {
    return normalizedDraft().length > 0 && normalizedDraft() !== effectiveUpc;
  }

  function renderPushTargetLabel(label: string) {
    return (
      <span className="flex items-center justify-center gap-1">
        <span>{label}</span>
      </span>
    );
  }

  if (editing) {
    const valid = hasDraftChange();
    return (
      <div className="w-full rounded border border-amber-500/40 bg-background/40 px-2 py-2">
        <div className="flex items-center gap-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/\s+/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Escape") cancelEdit();
              if (e.key === "Enter" && valid) setShowActions(true);
            }}
            className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-xs font-mono text-foreground outline-none focus:ring-1 focus:ring-ring"
            autoFocus
          />
          <button
            onClick={() => {
              if (valid) setShowActions(true);
            }}
            disabled={!valid}
            className={cn(
              "rounded p-0.5 cursor-pointer",
              valid ? "text-emerald-400 hover:text-emerald-300" : "text-muted-foreground/30 cursor-not-allowed",
            )}
            title="Confirm"
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            onClick={cancelEdit}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
            title="Cancel"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        {showActions ? (
          <div className="mt-1 grid w-full grid-cols-3 gap-1">
            <button
              onClick={() => {
                onSave?.(normalizedDraft(), "stage");
                setEditing(false);
                setShowActions(false);
              }}
              className="inline-flex min-w-0 items-center justify-center rounded bg-[var(--staged)] px-1.5 py-1.5 text-[9px] font-bold leading-none text-[var(--staged-foreground)] hover:opacity-80 cursor-pointer"
            >
              {renderCompactButtonLabel("Stage")}
            </button>
            <button
              onClick={() => {
                if (hasMultipleTargets) {
                  onSave?.(normalizedDraft(), "stage");
                  setEditing(false);
                  setShowActions(false);
                  setSelectorMode("review");
                  return;
                }
                setEditing(false);
                setShowActions(false);
                onSave?.(normalizedDraft(), "push");
              }}
              className="inline-flex min-w-0 items-center justify-center rounded bg-emerald-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-white hover:bg-emerald-600 cursor-pointer"
            >
              {renderCompactButtonLabel("Review Push")}
            </button>
            <button
              onClick={() => {
                if (hasMultipleTargets) {
                  onSave?.(normalizedDraft(), "stage");
                  setEditing(false);
                  setShowActions(false);
                  setSelectorMode("fast");
                  return;
                }
                setEditing(false);
                setShowActions(false);
                onSave?.(normalizedDraft(), "fastPush");
              }}
              className="inline-flex min-w-0 items-center justify-center rounded bg-blue-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-white hover:bg-blue-600 cursor-pointer"
            >
              {renderCompactButtonLabel("Fast Push")}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative flex flex-col items-center gap-1 text-foreground">
      <CopyNotice show={copied || imageCopied} />
      <svg
        ref={svgRef}
        className="h-[48px] w-full max-w-[160px] cursor-pointer"
        onClick={() => {}}
        onContextMenu={(e) => {
          e.preventDefault();
          void handleCopyImage();
        }}
        role="img"
        aria-label={displayedUpc ? `UPC barcode: ${displayedUpc}` : "No UPC available"}
      />

      {displayedUpc ? (
        <div className="flex w-full items-start justify-center gap-1">
          <div className="min-w-0 text-center">
            {stagedUpc ? (
              <>
                <div className="flex items-center justify-center gap-1 font-mono text-xs font-semibold text-amber-300">
                  <span className="truncate">{stagedUpc}</span>
                  <span className="rounded-sm bg-amber-500 px-1 py-px text-[9px] font-bold text-black">
                    STAGED
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-center gap-1 font-mono text-[11px] font-semibold text-emerald-400">
                  <span className="truncate">{upc ?? "No live UPC"}</span>
                  <span className="rounded-sm bg-emerald-500 px-1 py-px text-[9px] font-bold text-white">
                    LIVE
                  </span>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center gap-1 font-mono text-xs font-semibold text-emerald-400">
                <span className="truncate">{upc}</span>
                <span className="rounded-sm bg-emerald-500 px-1 py-px text-[9px] font-bold text-white">
                  LIVE
                </span>
              </div>
            )}
          </div>
          <button
            onClick={handleCopy}
            className="rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-foreground cursor-pointer"
            title="Copy UPC"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      ) : (
        <span className="text-[10px] font-medium text-muted-foreground/40 italic">No UPC</span>
      )}

      {stagedUpc && canPush ? (
        quickPhase !== "idle" ? (
          <div
            className={cn(
              "mt-1 inline-flex min-w-[92px] items-center justify-center gap-1 rounded px-2 py-1 text-[10px] font-bold leading-none text-white",
              quickPhase === "success"
                ? "bg-emerald-500"
                : quickPhase === "error" || quickPhase === "blocked"
                  ? "bg-amber-500"
                  : "bg-blue-500",
            )}
            title={quickPushState?.detail ?? undefined}
          >
            {renderFastPushLabel()}
          </div>
        ) : selectorMode ? (
          <div className="mt-1 w-full space-y-1">
            <div className="rounded border border-border bg-background/40 px-2 py-1 text-center text-[10px] font-medium text-muted-foreground">
              Choose marketplace
            </div>
            <div className="grid grid-cols-2 gap-1">
              {pushTargets.map((target) => (
                <button
                  key={`${target.platform}:${target.listingId}`}
                  onClick={() => {
                    if (selectorMode === "review") {
                      onReviewPushTarget?.(target.platform, target.listingId);
                    } else {
                      onFastPushTarget?.(target.platform, target.listingId);
                    }
                    setSelectorMode(null);
                  }}
                  className="inline-flex min-w-0 items-center justify-center rounded bg-primary/15 px-1.5 py-1.5 text-[9px] font-bold leading-none text-primary hover:bg-primary/25 cursor-pointer"
                  title={`Push UPC to ${target.label}`}
                >
                  {renderPushTargetLabel(target.label)}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-1">
              <button
                onClick={() => setSelectorMode(null)}
                className="inline-flex min-w-0 items-center justify-center rounded bg-muted px-1.5 py-1.5 text-[9px] font-medium leading-none text-muted-foreground hover:text-foreground cursor-pointer"
              >
                {renderCompactButtonLabel("Back")}
              </button>
              <button
                onClick={onDiscard}
                className="inline-flex min-w-0 items-center justify-center rounded bg-muted px-1.5 py-1.5 text-[9px] font-medium leading-none text-muted-foreground hover:text-foreground cursor-pointer"
              >
                {renderCompactButtonLabel("Discard")}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-1 grid w-full grid-cols-2 gap-1">
            <button
              onClick={() => {
                if (hasMultipleTargets) {
                  setSelectorMode("review");
                  return;
                }
                onReviewPush?.();
              }}
              className="inline-flex min-w-0 items-center justify-center rounded bg-emerald-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-white hover:bg-emerald-600 cursor-pointer"
              title="Review the guarded live push flow for this staged UPC"
            >
              {renderCompactButtonLabel("Review Push")}
            </button>
            <button
              onClick={() => {
                if (hasMultipleTargets) {
                  setSelectorMode("fast");
                  return;
                }
                onFastPush?.();
              }}
              className="inline-flex min-w-0 items-center justify-center rounded bg-blue-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-white hover:bg-blue-600 cursor-pointer"
              title="Run the guarded fast push for this staged UPC"
            >
              {renderCompactButtonLabel("Fast Push")}
            </button>
            <button
              onClick={onDiscard}
              className="col-span-2 inline-flex min-w-0 items-center justify-center rounded bg-muted px-1.5 py-1.5 text-[9px] font-medium leading-none text-muted-foreground hover:text-foreground cursor-pointer"
              title="Discard staged UPC and revert to live"
            >
              {renderCompactButtonLabel("Discard")}
            </button>
          </div>
        )
      ) : editable && quickPhase === "idle" ? (
        <button
          onClick={startEdit}
          className="mt-1 rounded border border-border bg-background/40 px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
        >
          Edit
        </button>
      ) : null}
    </div>
  );
}
