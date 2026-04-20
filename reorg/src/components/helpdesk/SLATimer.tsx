"use client";

/**
 * Small SLA chip rendered next to a ticket. Re-evaluates client-side every
 * 30s so the bucket flips without a full reload. Pure visual — no actions.
 */

import { useEffect, useState } from "react";
import { Clock, AlertTriangle, CheckCircle2 } from "lucide-react";
import { computeSla, type SlaResult } from "@/lib/helpdesk/sla";
import { cn } from "@/lib/utils";

interface SLATimerProps {
  lastBuyerMessageAt: string | Date | null;
  firstResponseAt: string | Date | null;
  /** Optional per-ticket override. */
  timezone?: string;
  /** Compact (icon + count) or expanded (with label) display. */
  variant?: "compact" | "full";
}

export function SLATimer({
  lastBuyerMessageAt,
  firstResponseAt,
  timezone,
  variant = "compact",
}: SLATimerProps) {
  const [result, setResult] = useState<SlaResult>(() =>
    computeSla({
      lastBuyerMessageAt: toDate(lastBuyerMessageAt),
      firstResponseAt: toDate(firstResponseAt),
    }, timezone ? { timezone } : {}),
  );

  useEffect(() => {
    function tick() {
      setResult(
        computeSla(
          {
            lastBuyerMessageAt: toDate(lastBuyerMessageAt),
            firstResponseAt: toDate(firstResponseAt),
          },
          timezone ? { timezone } : {},
        ),
      );
    }
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [lastBuyerMessageAt, firstResponseAt, timezone]);

  if (result.bucket === "NA") return null;
  const palette = colorFor(result.bucket);
  const Icon = iconFor(result.bucket);
  const label = labelFor(result);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
        palette,
      )}
      title={tooltipFor(result)}
    >
      <Icon className="h-3 w-3" />
      {variant === "full" ? label : compactLabel(result)}
    </span>
  );
}

function toDate(v: string | Date | null): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

function colorFor(bucket: SlaResult["bucket"]): string {
  switch (bucket) {
    case "GREEN":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "AMBER":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "RED":
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
    case "MET":
      return "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300";
    default:
      return "border-hairline bg-surface text-muted-foreground";
  }
}

function iconFor(bucket: SlaResult["bucket"]) {
  if (bucket === "RED" || bucket === "AMBER") return AlertTriangle;
  if (bucket === "MET") return CheckCircle2;
  return Clock;
}

function labelFor(r: SlaResult): string {
  if (r.bucket === "MET") return "SLA met";
  if (r.bucket === "RED") return `${formatHours(-r.remainingBusinessMs)} over`;
  return `${formatHours(r.remainingBusinessMs)} left`;
}

function compactLabel(r: SlaResult): string {
  if (r.bucket === "MET") return "OK";
  if (r.bucket === "RED") return "OVER";
  return formatHours(r.remainingBusinessMs);
}

function formatHours(ms: number): string {
  const abs = Math.max(0, Math.abs(ms));
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  if (h >= 1) return `${h}h`;
  return `${m}m`;
}

function tooltipFor(r: SlaResult): string {
  const lines = [
    `Bucket: ${r.bucket}`,
    `Elapsed: ${formatHours(r.elapsedBusinessMs)} business hours`,
    `Due: ${r.dueAt ? r.dueAt.toLocaleString() : "—"}`,
  ];
  return lines.join("\n");
}
