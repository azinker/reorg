"use client";

import { useState, useRef } from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Search,
  Truck,
  AlertTriangle,
  RotateCcw,
  PackageCheck,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  Copy,
  Check,
  MessageSquareText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { IdentifyResult, ShipResult } from "@/lib/services/ship-orders";
import type { Platform } from "@prisma/client";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Orders sent per execute API call. Gives real progress ticks without too many round-trips. */
const SHIP_CHUNK_SIZE = 25;

// ─── Platform badges ──────────────────────────────────────────────────────────

const PLATFORM_META: Record<Platform, { label: string; color: string }> = {
  TPP_EBAY: { label: "TPP eBay", color: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30" },
  TT_EBAY: { label: "TT eBay", color: "bg-orange-500/20 text-orange-300 border-orange-500/30" },
  BIGCOMMERCE: { label: "BigCommerce", color: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  SHOPIFY: { label: "Shopify", color: "bg-green-500/20 text-green-300 border-green-500/30" },
  AMAZON: { label: "Amazon", color: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
};

function PlatformBadge({ platform }: { platform: Platform }) {
  const meta = PLATFORM_META[platform];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium",
        meta.color,
      )}
    >
      {meta.label}
    </span>
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

type ProgressState = {
  phase: "identifying" | "shipping";
  done: number;
  total: number;
};

function ProgressBar({ progress }: { progress: ProgressState }) {
  const pct =
    progress.phase === "identifying" || progress.total === 0
      ? null
      : Math.round((progress.done / progress.total) * 100);

  const label =
    progress.phase === "identifying"
      ? "Identifying orders…"
      : progress.done === 0
        ? `Preparing ${progress.total} orders…`
        : `${progress.done} / ${progress.total} orders shipped`;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-white/60 flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" />
          {label}
        </span>
        {pct !== null && (
          <span className="text-white/40 tabular-nums">{pct}%</span>
        )}
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        {pct !== null ? (
          // Determinate
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        ) : (
          // Indeterminate — sliding shimmer
          <div className="h-full w-full relative overflow-hidden rounded-full">
            <div
              className="absolute inset-y-0 w-full bg-gradient-to-r from-emerald-600 to-emerald-400"
              style={{ animation: "indeterminate 1.6s ease-in-out infinite" }}
            />
          </div>
        )}
      </div>
    </div>
  );
}


// ─── Types ────────────────────────────────────────────────────────────────────

type IdentifyApiResult = IdentifyResult & { __type?: never };
type ShipApiResult = ShipResult;

type RowState =
  | { phase: "identified"; data: IdentifyResult }
  | { phase: "shipping"; orderNumber: string }
  | { phase: "shipped"; data: ShipApiResult }
  | { phase: "failed"; data: ShipApiResult };

// ─── Retry callout ────────────────────────────────────────────────────────────

function CopyableRetryBox({
  title,
  icon,
  colorClass,
  entries,
}: {
  title: string;
  icon: React.ReactNode;
  colorClass: string; // e.g. "border-red-500/30 bg-red-500/10 text-red-300"
  entries: Array<{ orderNumber: string; trackingNumber: string }>;
}) {
  const [copied, setCopied] = useState(false);
  const text = entries.map((e) => `${e.orderNumber}  ${e.trackingNumber}`).join("\n");

  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className={cn("rounded border px-4 py-3 space-y-2", colorClass)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied!" : "Copy to retry"}
        </button>
      </div>
      <pre className="font-mono text-xs leading-relaxed opacity-80 select-all">{text}</pre>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ShipOrdersPanel() {
  const [rawInput, setRawInput] = useState("");
  const [identifying, setIdentifying] = useState(false);
  const [shipping, setShipping] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [identifyError, setIdentifyError] = useState<string | null>(null);
  const [arStatus, setArStatus] = useState<{ queued: number; skipped: number; error?: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const identified = rows
    .filter((r): r is { phase: "identified"; data: IdentifyResult } => r.phase === "identified")
    .map((r) => r.data);
  const readyToShip = identified.filter((d) => d.status === "found");
  const notFoundOrders = identified.filter(
    (d): d is { orderNumber: string; trackingNumber: string; status: "not_found" | "ambiguous" | "error"; error?: string } =>
      d.status !== "found",
  );
  const hasResults = rows.length > 0;
  const allDone =
    rows.length > 0 &&
    rows.some((r) => r.phase === "shipped" || r.phase === "failed") &&
    rows.every(
      (r) => r.phase === "shipped" || r.phase === "failed" || r.phase === "identified",
    );

  const shippedRows = rows.filter((r): r is { phase: "shipped"; data: ShipApiResult } => r.phase === "shipped");
  const failedRows = rows.filter((r): r is { phase: "failed"; data: ShipApiResult } => r.phase === "failed");
  const verifiedCount = shippedRows.filter((r) => r.data.verificationStatus === "verified").length;
  const mismatchCount = shippedRows.filter((r) => r.data.verificationStatus === "mismatch").length;

  // ─── Identify ─────────────────────────────────────────────────────────────

  async function handleIdentify() {
    if (!rawInput.trim()) return;
    setIdentifyError(null);
    setIdentifying(true);
    setProgress({ phase: "identifying", done: 0, total: 0 });
    setRows([]);

    try {
      const res = await fetch("/api/ship-orders/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: rawInput }),
      });
      const json = (await res.json()) as {
        data?: { results: IdentifyApiResult[] };
        error?: string;
      };

      if (!res.ok || !json.data) {
        setIdentifyError(json.error ?? "Failed to identify orders");
        return;
      }

      setRows(json.data.results.map((r) => ({ phase: "identified" as const, data: r })));
    } catch {
      setIdentifyError("Network error — could not reach server");
    } finally {
      setIdentifying(false);
      setProgress(null);
    }
  }

  // ─── Ship (chunked for progress) ──────────────────────────────────────────

  async function handleShip() {
    const toShip = identified.filter(
      (d): d is Extract<IdentifyResult, { status: "found" }> => d.status === "found",
    );
    if (toShip.length === 0) return;

    setShipping(true);
    setArStatus(null);
    setProgress({ phase: "shipping", done: 0, total: toShip.length });

    const batchId = `ship-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Mark every "found" row as shipping immediately
    setRows((prev) =>
      prev.map((r) => {
        if (r.phase === "identified" && r.data.status === "found") {
          return { phase: "shipping" as const, orderNumber: r.data.orderNumber };
        }
        return r;
      }),
    );

    let done = 0;
    let totalArQueued = 0;

    try {
      for (let i = 0; i < toShip.length; i += SHIP_CHUNK_SIZE) {
        const chunk = toShip.slice(i, i + SHIP_CHUNK_SIZE);
        const chunkOrderNumbers = new Set(chunk.map((o) => o.orderNumber));

        try {
          const res = await fetch("/api/ship-orders/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orders: chunk, batchId }),
          });
          const json = (await res.json()) as {
            data?: { results: ShipApiResult[]; autoResponderStatus?: { queued: number; skipped: number; error?: string } };
            error?: string;
          };

          if (res.ok && json.data) {
            if (json.data.autoResponderStatus) {
              totalArQueued += json.data.autoResponderStatus.queued ?? 0;
              setArStatus((prev) => {
                if (!prev) return json.data!.autoResponderStatus!;
                return {
                  queued: prev.queued + (json.data!.autoResponderStatus!.queued ?? 0),
                  skipped: prev.skipped + (json.data!.autoResponderStatus!.skipped ?? 0),
                  error: json.data!.autoResponderStatus!.error ?? prev.error,
                };
              });
            }
            const resultMap = new Map(json.data.results.map((r) => [r.orderNumber, r]));
            setRows((prev) =>
              prev.map((r) => {
                if (r.phase !== "shipping") return r;
                const result = resultMap.get(r.orderNumber);
                if (!result) return r;
                return result.success
                  ? { phase: "shipped" as const, data: result }
                  : { phase: "failed" as const, data: result };
              }),
            );
          } else {
            // Chunk-level API failure — mark this chunk's rows as failed
            setRows((prev) =>
              prev.map((r) => {
                if (r.phase !== "shipping" || !chunkOrderNumbers.has(r.orderNumber)) return r;
                return {
                  phase: "failed" as const,
                  data: {
                    orderNumber: r.orderNumber,
                    trackingNumber: "",
                    platform: null,
                    success: false,
                    error: json.error ?? "Execute request failed",
                  },
                };
              }),
            );
          }
        } catch {
          setRows((prev) =>
            prev.map((r) => {
              if (r.phase !== "shipping" || !chunkOrderNumbers.has(r.orderNumber)) return r;
              return {
                phase: "failed" as const,
                data: {
                  orderNumber: r.orderNumber,
                  trackingNumber: "",
                  platform: null,
                  success: false,
                  error: "Network error",
                },
              };
            }),
          );
        }

        done += chunk.length;
        setProgress({ phase: "shipping", done, total: toShip.length });
      }

      // Fire kick immediately — don't depend on the tracker component mounting
      if (totalArQueued > 0) {
        fetch("/api/auto-responder/kick", { method: "POST" }).catch(() => {});
      }
    } finally {
      setShipping(false);
      setProgress(null);
    }
  }

  // ─── Reset ─────────────────────────────────────────────────────────────────

  function handleReset() {
    setRows([]);
    setRawInput("");
    setIdentifyError(null);
    setArStatus(null);
    textareaRef.current?.focus();
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Input area */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm text-white/60 font-medium uppercase tracking-wide">
          <Truck className="h-4 w-4" />
          Paste Order Numbers &amp; Tracking Numbers
        </div>

        <p className="text-sm text-white/50">
          One order per line. Separate the order number and tracking number with a tab or two spaces.
          eBay orders are auto-detected between TPP and TT. Shopify and BigCommerce orders are numeric.
        </p>

        <div className="rounded border border-white/10 bg-black/20 p-3 text-xs text-white/40 font-mono leading-relaxed">
          <div>01-14458-12363{"  "}9401903308745112568932</div>
          <div>01-14458-66715{"  "}9401903308744844057769</div>
          <div>27111{"  "}9401903308746939131293</div>
          <div>4641862{"  "}9401903308748816824953</div>
        </div>

        <textarea
          ref={textareaRef}
          value={rawInput}
          onChange={(e) => setRawInput(e.target.value)}
          placeholder="Paste order + tracking pairs here..."
          rows={8}
          className={cn(
            "w-full resize-y rounded border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-white",
            "placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-white/20",
            "disabled:opacity-50",
          )}
          disabled={identifying || shipping}
        />

        {identifyError && (
          <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {identifyError}
          </div>
        )}

        {progress && <ProgressBar progress={progress} />}

        <div className="flex items-center gap-3">
          <button
            onClick={handleIdentify}
            disabled={!rawInput.trim() || identifying || shipping}
            className={cn(
              "flex items-center gap-2 rounded px-4 py-2 text-sm font-medium transition-colors cursor-pointer",
              "bg-white/10 hover:bg-white/20 text-white disabled:opacity-40 disabled:cursor-not-allowed",
            )}
          >
            {identifying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            {identifying ? "Identifying…" : "Identify Orders"}
          </button>

          {hasResults && (
            <button
              onClick={handleReset}
              disabled={identifying || shipping}
              className="flex items-center gap-2 rounded px-3 py-2 text-sm text-white/50 hover:text-white/80 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Not-found retry callout — shown while still in identify phase (before shipping) */}
      {notFoundOrders.length > 0 && !allDone && (
        <CopyableRetryBox
          title={`${notFoundOrders.length} order${notFoundOrders.length !== 1 ? "s" : ""} not found — paste back to retry`}
          icon={<XCircle className="h-4 w-4 shrink-0" />}
          colorClass="border-red-500/30 bg-red-500/10 text-red-300"
          entries={notFoundOrders}
        />
      )}

      {/* Failed retry callout — shown after shipping attempt */}
      {allDone && failedRows.length > 0 && (
        <CopyableRetryBox
          title={`${failedRows.length} order${failedRows.length !== 1 ? "s" : ""} failed — paste back to retry`}
          icon={<AlertTriangle className="h-4 w-4 shrink-0" />}
          colorClass="border-amber-500/30 bg-amber-500/10 text-amber-300"
          entries={failedRows.map((r) => ({
            orderNumber: r.data.orderNumber,
            trackingNumber: r.data.trackingNumber,
          }))}
        />
      )}

      {/* Results table */}
      {hasResults && (
        <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
            <div className="text-sm font-medium text-white/80">
              {rows.length} order{rows.length !== 1 ? "s" : ""} identified
              {readyToShip.length > 0 && !allDone && (
                <span className="ml-2 text-white/50">
                  — {readyToShip.length} ready to ship
                </span>
              )}
              {allDone && shippedRows.length > 0 && (
                <span className="ml-2">
              {mismatchCount > 0 ? (
                  <span className="text-amber-400">
                    — {verifiedCount > 0 ? `${verifiedCount} verified, ` : ""}{mismatchCount} not confirmed
                    {rows.filter((r) => r.phase === "failed").length > 0
                      ? `, ${rows.filter((r) => r.phase === "failed").length} failed`
                      : ""}
                  </span>
                ) : (
                  <span className="text-emerald-400">
                    — {verifiedCount > 0 ? `${verifiedCount} verified` : `${shippedRows.length} submitted`}
                    {rows.filter((r) => r.phase === "failed").length > 0
                      ? `, ${rows.filter((r) => r.phase === "failed").length} failed`
                      : ""}
                  </span>
                )}
                </span>
              )}
            </div>

            {!allDone && readyToShip.length > 0 && (
              <button
                onClick={handleShip}
                disabled={shipping || identifying}
                className={cn(
                  "flex items-center gap-2 rounded px-4 py-1.5 text-sm font-medium transition-colors cursor-pointer",
                  "bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 disabled:cursor-not-allowed",
                )}
              >
                {shipping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <PackageCheck className="h-4 w-4" />
                )}
                {shipping
                  ? "Shipping & Verifying…"
                  : `Ship ${readyToShip.length} Order${readyToShip.length !== 1 ? "s" : ""}`}
              </button>
            )}
          </div>

          {allDone && arStatus && (
            <div className="px-5 py-2 border-b border-white/10 text-xs flex items-center gap-2">
              <MessageSquareText className="h-3.5 w-3.5 text-white/40 shrink-0" />
              {arStatus.error ? (
                <span className="text-amber-400">
                  Auto Responder: {arStatus.queued} queued, {arStatus.skipped} skipped — {arStatus.error}
                </span>
              ) : arStatus.queued > 0 ? (
                <span className="text-emerald-400/80">
                  Auto Responder: {arStatus.queued} message{arStatus.queued !== 1 ? "s" : ""} queued — track progress on the{" "}
                  <a href="/auto-responder" className="underline hover:text-emerald-300 transition-colors">Auto Responder</a> page
                </span>
              ) : (
                <span className="text-white/40">
                  Auto Responder: no eligible eBay orders
                </span>
              )}
            </div>
          )}

          <div className="divide-y divide-white/5">
            {rows.map((row, i) => (
              <OrderRow key={i} row={row} />
            ))}
          </div>

          {allDone && (
            <div className="px-5 py-3 border-t border-white/10 flex justify-end">
              <button
                onClick={handleReset}
                className="flex items-center gap-2 rounded px-3 py-1.5 text-sm text-white/60 hover:text-white/90 transition-colors cursor-pointer bg-white/5 hover:bg-white/10"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Start new batch
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Row component ────────────────────────────────────────────────────────────

function OrderRow({ row }: { row: RowState }) {
  if (row.phase === "identified") {
    const d = row.data;
    return (
      <div className="flex items-center gap-4 px-5 py-3 text-sm">
        <StatusDot status={d.status === "found" ? "pending" : "error"} />
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="font-mono text-white/90 text-xs">{d.orderNumber}</div>
          <div className="font-mono text-white/40 text-xs truncate">{d.trackingNumber}</div>
        </div>
        <div className="shrink-0">
          {d.status === "found" ? (
            <PlatformBadge platform={(d as { platform: Platform }).platform} />
          ) : (
            <span className="text-xs text-red-400">
              {d.status === "not_found"
                ? "Not found on any store"
                : d.status === "ambiguous"
                  ? "Ambiguous"
                  : (d as { error?: string }).error ?? "Error"}
            </span>
          )}
        </div>
      </div>
    );
  }

  if (row.phase === "shipping") {
    return (
      <div className="flex items-center gap-4 px-5 py-3 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-white/30 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-white/50 text-xs">{row.orderNumber}</div>
          <div className="text-white/30 text-xs italic">Queued…</div>
        </div>
      </div>
    );
  }

  const d = row.data;
  const isShipped = row.phase === "shipped";

  return (
    <div className="flex items-start gap-4 px-5 py-3 text-sm">
      <StatusDot status={isShipped ? "success" : "error"} />
      <div className="flex-1 min-w-0 space-y-1">
        <div className="font-mono text-white/90 text-xs">{d.orderNumber}</div>
        {isShipped ? (
          <VerificationInfo result={d} />
        ) : (
          <div className="font-mono text-white/40 text-xs truncate">{d.trackingNumber}</div>
        )}
        {!isShipped && d.error && (
          <div className="text-xs text-red-400 max-w-sm">{d.error}</div>
        )}
        {isShipped && d.ebayWarnings && d.ebayWarnings.length > 0 && (
          <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 space-y-0.5">
            {d.ebayWarnings.map((w, i) => (
              <div key={i} className="text-xs text-amber-300 flex items-start gap-1">
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                {w}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right space-y-1">
        {d.platform && <PlatformBadge platform={d.platform} />}
        {isShipped && <VerificationBadge status={d.verificationStatus} />}
      </div>
    </div>
  );
}

// ─── Verification display ─────────────────────────────────────────────────────

function VerificationInfo({ result }: { result: ShipResult }) {
  const { trackingNumber, verifiedTrackingNumber, verificationStatus } = result;

  if (verificationStatus === "verified") {
    return (
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-xs text-emerald-300">{verifiedTrackingNumber ?? trackingNumber}</span>
        <span className="text-xs text-emerald-400/70">confirmed on eBay</span>
      </div>
    );
  }

  if (verificationStatus === "mismatch" && verifiedTrackingNumber) {
    // eBay has a completely different tracking number — unexpected
    return (
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-white/40">Submitted:</span>
          <span className="font-mono text-xs text-white/60">{trackingNumber}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-amber-400/80">On eBay:</span>
          <span className="font-mono text-xs text-amber-300">{verifiedTrackingNumber}</span>
        </div>
      </div>
    );
  }

  if (verificationStatus === "mismatch" && !verifiedTrackingNumber) {
    // CompleteSale had warnings — tracking likely not applied
    return (
      <div className="font-mono text-xs text-amber-300/80">{trackingNumber}</div>
    );
  }

  // unverified — submitted OK but GetOrders didn't return tracking (BC, Shopify, or eBay read-back timing)
  return (
    <div className="font-mono text-xs text-white/50">{trackingNumber}</div>
  );
}

function VerificationBadge({ status }: { status?: "verified" | "mismatch" | "unverified" }) {
  if (status === "verified") {
    return (
      <div className="flex items-center justify-end gap-1 text-xs text-emerald-400">
        <ShieldCheck className="h-3.5 w-3.5" />
        Verified
      </div>
    );
  }
  if (status === "mismatch") {
    return (
      <div className="flex items-center justify-end gap-1 text-xs text-amber-400">
        <ShieldAlert className="h-3.5 w-3.5" />
        Not confirmed
      </div>
    );
  }
  // unverified
  return (
    <div className="flex items-center justify-end gap-1 text-xs text-emerald-400/60">
      <ShieldOff className="h-3.5 w-3.5" />
      Submitted
    </div>
  );
}

function StatusDot({ status }: { status: "pending" | "success" | "error" }) {
  if (status === "success") {
    return <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />;
  }
  if (status === "error") {
    return <XCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />;
  }
  return <div className="h-2 w-2 rounded-full bg-white/30 shrink-0 mx-1 mt-1" />;
}
