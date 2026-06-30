"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, MessageSquare, X } from "lucide-react";
import { fillTemplate, findUnfilledPlaceholders, type TemplateContext } from "@/lib/helpdesk/template-fill";
import { cn } from "@/lib/utils";
import type { LabelFormatterSourceStore } from "@/lib/label-formatter/types";

export type MessageBuyersRow = {
  id: string;
  orderNumber: string;
  sourceStore: LabelFormatterSourceStore;
  sourceStoreLabel: string;
  buyerName: string;
  trackingNumber: string | null;
  status: string;
};

const SNIPPETS = [
  "{{first_name}}",
  "{{buyer_name}}",
  "{{order_number}}",
  "{{tracking_number}}",
  "{{store_name}}",
  "{{item_title}}",
  "{{buyer_username}}",
];

type QueueResult = {
  reshipRowId: string;
  orderNumber: string;
  buyerName: string;
  ticketId: string | null;
  jobId: string | null;
  scheduledAt: string | null;
  willBlockReason: string | null;
  filledPreview: string | null;
  status: "queued" | "skipped" | "error";
  error: string | null;
};

type RowProgress = QueueResult & {
  jobStatus: string | null;
  jobError: string | null;
  phase: "pending" | "queued" | "sending" | "sent" | "failed" | "skipped" | "blocked";
};

function previewContext(row: MessageBuyersRow): TemplateContext {
  const first = row.buyerName.trim().split(/\s+/)[0] ?? row.buyerName;
  return {
    deliveryName: row.buyerName,
    buyerName: row.buyerName,
    ebayOrderNumber: row.orderNumber,
    trackingNumber: row.trackingNumber,
    storeName: row.sourceStoreLabel,
    buyerUserId: first,
  };
}

function mapJobPhase(row: RowProgress): RowProgress["phase"] {
  if (row.status === "skipped") return "skipped";
  if (row.status === "error") return "failed";
  if (row.willBlockReason) return "blocked";
  if (!row.jobId) return "failed";
  switch (row.jobStatus) {
    case "SENT":
      return "sent";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "blocked";
    case "SENDING":
      return "sending";
    case "PENDING":
      return "queued";
    default:
      return row.jobStatus ? "sending" : "queued";
  }
}

function phaseLabel(phase: RowProgress["phase"]) {
  switch (phase) {
    case "pending":
      return "Pending";
    case "queued":
      return "Queued";
    case "sending":
      return "Sending…";
    case "sent":
      return "Sent";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "blocked":
      return "Blocked";
  }
}

export function MessageBuyersModal({
  rows,
  onClose,
}: {
  rows: MessageBuyersRow[];
  onClose: () => void;
}) {
  const [bodyText, setBodyText] = useState("");
  const [sendDelaySeconds, setSendDelaySeconds] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<RowProgress[] | null>(null);
  const [flagsWarning, setFlagsWarning] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const previewRow = rows[0];
  const previewBody = previewRow
    ? fillTemplate(bodyText, previewContext(previewRow))
    : "";
  const unfilled = useMemo(() => findUnfilledPlaceholders(bodyText), [bodyText]);

  useEffect(() => {
    void fetch("/api/helpdesk/sync-status", { cache: "no-store" })
      .then((res) => res.json())
      .then((json: { data?: { safeMode?: boolean; effectiveCanSendEbay?: boolean; globalWriteLock?: boolean } }) => {
        const data = json.data;
        if (!data) return;
        if (data.safeMode || data.globalWriteLock) {
          setFlagsWarning(
            data.globalWriteLock
              ? "Global write lock is ON — messages will queue but will not send until unlocked."
              : "Help Desk safe mode is ON — messages will queue but will not send until safe mode is off.",
          );
        } else if (!data.effectiveCanSendEbay) {
          setFlagsWarning("eBay send is disabled — messages will queue but will not send until enabled.");
        }
      })
      .catch(() => undefined);
  }, []);

  const pollJobs = useCallback(async (items: RowProgress[]) => {
    const jobIds = items.map((row) => row.jobId).filter(Boolean) as string[];
    if (jobIds.length === 0) return items;

    const res = await fetch(
      `/api/label-formatter/message-buyers/status?jobIds=${encodeURIComponent(jobIds.join(","))}`,
      { cache: "no-store" },
    );
    const json = (await res.json()) as {
      data?: Array<{
        jobId: string;
        status: string;
        errorMessage: string | null;
      }>;
    };
    const byId = new Map((json.data ?? []).map((row) => [row.jobId, row]));

    return items.map((row) => {
      if (!row.jobId) return row;
      const job = byId.get(row.jobId);
      return {
        ...row,
        jobStatus: job?.status ?? row.jobStatus,
        jobError: job?.errorMessage ?? row.jobError,
      };
    });
  }, []);

  useEffect(() => {
    if (!progress) return;
    const hasActiveJobs = progress.some(
      (row) =>
        row.jobId &&
        row.jobStatus !== "SENT" &&
        row.jobStatus !== "FAILED" &&
        row.jobStatus !== "CANCELLED",
    );
    if (!hasActiveJobs) return;

    const timer = window.setInterval(() => {
      void pollJobs(progress).then((next) => {
        setProgress(next.map((row) => ({ ...row, phase: mapJobPhase(row) })));
      });
    }, 2000);

    return () => window.clearInterval(timer);
  }, [pollJobs, progress]);

  async function handleSend() {
    if (!bodyText.trim()) {
      setSubmitError("Message body is required.");
      return;
    }
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/label-formatter/message-buyers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bodyText,
          sendDelaySeconds,
          targets: rows.map((row) => ({
            reshipRowId: row.id,
            orderNumber: row.orderNumber,
            sourceStore: row.sourceStore,
            buyerName: row.buyerName,
            trackingNumber: row.trackingNumber,
          })),
        }),
      });
      const json = (await res.json()) as {
        data?: { results: QueueResult[] };
        error?: string;
      };
      if (!res.ok || !json.data) {
        throw new Error(typeof json.error === "string" ? json.error : "Failed to queue messages.");
      }

      const initial: RowProgress[] = json.data.results.map((row) => ({
        ...row,
        jobStatus: row.jobId ? "PENDING" : null,
        jobError: row.error,
        phase: mapJobPhase({
          ...row,
          jobStatus: row.jobId ? "PENDING" : null,
          jobError: row.error,
          phase: "queued",
        }),
      }));
      setProgress(initial);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to queue messages.");
    } finally {
      setSubmitting(false);
    }
  }

  const done =
    progress !== null &&
    progress.every((row) =>
      ["sent", "failed", "skipped", "blocked"].includes(row.phase),
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Message Buyers</h2>
            <span className="text-xs text-muted-foreground">({rows.length} selected)</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded p-1 hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {flagsWarning ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {flagsWarning}
            </div>
          ) : null}

          {!progress ? (
            <>
              <p className="text-xs text-muted-foreground">
                Messages reply on each buyer&apos;s active Help Desk ticket thread (eBay TPP / TT only).
                Snippets are replaced per buyer before send.
              </p>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Snippets</label>
                <div className="flex flex-wrap gap-1.5">
                  {SNIPPETS.map((snippet) => (
                    <button
                      key={snippet}
                      type="button"
                      onClick={() => setBodyText((current) => `${current}${current ? " " : ""}${snippet}`)}
                      className="cursor-pointer rounded border border-border bg-muted/40 px-2 py-1 font-mono text-[11px] hover:bg-accent"
                    >
                      {snippet}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Message</label>
                <textarea
                  value={bodyText}
                  onChange={(event) => setBodyText(event.target.value)}
                  rows={8}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  placeholder="Hi {{first_name}}, your order {{order_number}} has shipped. Tracking: {{tracking_number}}"
                />
                {unfilled.length > 0 ? (
                  <p className="mt-1 text-xs text-amber-300">
                    Unfilled snippets: {unfilled.map((key) => `{{${key}}}`).join(", ")}
                  </p>
                ) : null}
              </div>

              {previewRow ? (
                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    Preview for {previewRow.buyerName} ({previewRow.orderNumber})
                  </p>
                  <p className="whitespace-pre-wrap text-sm">{previewBody || "—"}</p>
                </div>
              ) : null}

              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground">Send delay (seconds)</label>
                <input
                  type="number"
                  min={0}
                  max={60}
                  value={sendDelaySeconds}
                  onChange={(event) => setSendDelaySeconds(Number(event.target.value) || 0)}
                  className="h-8 w-20 rounded-md border border-border bg-background px-2 text-sm"
                />
              </div>

              {submitError ? (
                <p className="text-xs text-red-300">{submitError}</p>
              ) : null}
            </>
          ) : (
            <div className="space-y-2">
              {progress.map((row) => (
                <div
                  key={row.reshipRowId}
                  className="rounded-md border border-border px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="font-mono">{row.orderNumber}</span>
                      <span className="mx-2 text-muted-foreground">·</span>
                      <span>{row.buyerName}</span>
                    </div>
                    <span
                      className={cn(
                        "font-medium",
                        row.phase === "sent" && "text-emerald-400",
                        row.phase === "failed" && "text-red-300",
                        row.phase === "blocked" && "text-amber-300",
                        row.phase === "skipped" && "text-muted-foreground",
                        (row.phase === "queued" || row.phase === "sending") && "text-sky-300",
                      )}
                    >
                      {phaseLabel(row.phase)}
                    </span>
                  </div>
                  {row.error || row.jobError ? (
                    <p className="mt-1 text-red-300">{row.error ?? row.jobError}</p>
                  ) : null}
                  {row.willBlockReason ? (
                    <p className="mt-1 text-amber-200">Blocked: {row.willBlockReason}</p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          {!progress ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={submitting}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
                Queue {rows.length} Message{rows.length === 1 ? "" : "s"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
            >
              {done ? <Check className="h-3.5 w-3.5" /> : null}
              {done ? "Done" : "Close"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
