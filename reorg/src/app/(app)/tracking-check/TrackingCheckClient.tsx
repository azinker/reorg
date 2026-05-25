"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  MapPinned,
  Puzzle,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Summary = {
  rows: number;
  deliveredMatched: number;
  deliveredNoMatch: number;
  inTransit: number;
  nonEbay: number;
  needsReview: number;
};

function fileListLabel(files: File[]) {
  if (files.length === 0) return "No files selected";
  if (files.length === 1) return files[0]?.name ?? "1 file selected";
  return `${files.length} files selected`;
}

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function TrackingCheckClient() {
  const [xlsxFiles, setXlsxFiles] = useState<File[]>([]);
  const [curlFiles, setCurlFiles] = useState<File[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [lastFilename, setLastFilename] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const xlsxInputRef = useRef<HTMLInputElement>(null);
  const curlInputRef = useRef<HTMLInputElement>(null);

  const canRun = useMemo(
    () => xlsxFiles.length > 0 && curlFiles.length > 0 && !running,
    [curlFiles.length, running, xlsxFiles.length],
  );

  const estimatedDurationMs = useMemo(() => {
    const totalBytes = xlsxFiles.reduce((sum, file) => sum + file.size, 0);
    const totalMb = totalBytes / 1_000_000;
    return Math.round(
      Math.min(
        12 * 60_000,
        Math.max(45_000, 35_000 + xlsxFiles.length * 28_000 + curlFiles.length * 4_000 + totalMb * 8_000),
      ),
    );
  }, [curlFiles.length, xlsxFiles]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [running]);

  const progress = useMemo(() => {
    if (!running || !startedAt) {
      return {
        percent: 0,
        elapsedMs: 0,
        remainingMs: estimatedDurationMs,
        label: "Ready",
      };
    }
    const elapsedMs = Math.max(0, now - startedAt);
    const ratio = elapsedMs / estimatedDurationMs;
    const percent = Math.min(95, Math.max(3, Math.round((1 - Math.exp(-ratio * 2.4)) * 100)));
    const remainingMs = Math.max(0, estimatedDurationMs - elapsedMs);
    return {
      percent,
      elapsedMs,
      remainingMs,
      label: elapsedMs >= estimatedDurationMs ? "Finalizing workbook..." : "Checking eBay tracking scans...",
    };
  }, [estimatedDurationMs, now, running, startedAt]);

  async function runCheck() {
    if (!canRun) return;
    setRunning(true);
    const start = Date.now();
    setStartedAt(start);
    setNow(start);
    setError(null);
    setSummary(null);
    setLastFilename(null);

    try {
      const form = new FormData();
      xlsxFiles.forEach((file) => form.append("files", file));
      curlFiles.forEach((file) => form.append("curlFiles", file));
      const response = await fetch("/api/tracking-check", {
        method: "POST",
        body: form,
        credentials: "include",
      });

      if (!response.ok) {
        const json = await response.json().catch(() => ({}));
        throw new Error(typeof json?.error === "string" ? json.error : `Tracking Check failed (${response.status})`);
      }

      const header = response.headers.get("X-Tracking-Check-Summary");
      if (header) {
        try {
          setSummary(JSON.parse(decodeURIComponent(header)) as Summary);
        } catch {
          setSummary(null);
        }
      }

      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] ?? `tracking-check-${Date.now()}.xlsx`;
      setLastFilename(filename);

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tracking Check failed.");
    } finally {
      setRunning(false);
      setStartedAt(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="border-b border-border px-6 py-5">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
          <MapPinned className="h-6 w-6 shrink-0 text-[#C43E3E]" aria-hidden />
          Tracking Check
        </h1>
        <p className="mt-2 max-w-4xl text-sm text-muted-foreground">
          Upload LabelCrow workbooks, add the TPP and TT eBay tracking session files, and export a
          categorized delivery-location audit.
        </p>
      </div>

      <div className="mx-auto grid w-full max-w-6xl gap-6 px-6 py-6 xl:grid-cols-[1fr_360px]">
        <section className="space-y-5">
          <div className="rounded-lg border border-border bg-card/40 p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-md bg-muted p-2">
                <FileSpreadsheet className="h-5 w-5 text-[#C43E3E]" aria-hidden />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">LabelCrow files</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Select one or more `.xlsx` files. Each file must have the `orderNumber` column.
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <input
                ref={xlsxInputRef}
                type="file"
                multiple
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(event) => setXlsxFiles(Array.from(event.currentTarget.files ?? []))}
              />
              <button
                type="button"
                onClick={() => xlsxInputRef.current?.click()}
                className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md bg-[#C43E3E] px-3 text-sm font-semibold text-white transition-colors hover:bg-[#a83434]"
              >
                <Upload className="h-4 w-4" aria-hidden />
                Choose files
              </button>
              <span className="text-sm text-muted-foreground">{fileListLabel(xlsxFiles)}</span>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card/40 p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-md bg-muted p-2">
                <ShieldCheck className="h-5 w-5 text-[#C43E3E]" aria-hidden />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">eBay session files</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Add the TPP and TT `.txt` files from the Tracking Check Helper extension. They are
                  used only for this request and are not saved in reorG.
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <input
                ref={curlInputRef}
                type="file"
                multiple
                accept=".txt,text/plain"
                className="hidden"
                onChange={(event) => setCurlFiles(Array.from(event.currentTarget.files ?? []))}
              />
              <button
                type="button"
                onClick={() => curlInputRef.current?.click()}
                className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
              >
                <Upload className="h-4 w-4" aria-hidden />
                Add session files
              </button>
              <span className="text-sm text-muted-foreground">{fileListLabel(curlFiles)}</span>
            </div>
          </div>

          {error ? (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          ) : null}

          {summary ? (
            <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
              {[
                ["Rows", summary.rows],
                ["Matched", summary.deliveredMatched],
                ["No Match", summary.deliveredNoMatch],
                ["In Transit", summary.inTransit],
                ["Non eBay", summary.nonEbay],
                ["Review", summary.needsReview],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md border border-border bg-card/30 p-3">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
                  <div className="mt-1 text-xl font-semibold text-foreground">{value}</div>
                </div>
              ))}
            </div>
          ) : null}

          {running ? (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-foreground">{progress.label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Estimate scales with selected files: {xlsxFiles.length} workbook
                    {xlsxFiles.length === 1 ? "" : "s"} selected.
                  </div>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <div>
                    Elapsed <span className="font-mono text-foreground">{formatDuration(progress.elapsedMs)}</span>
                  </div>
                  <div>
                    ETA{" "}
                    <span className="font-mono text-foreground">
                      {progress.remainingMs > 0 ? formatDuration(progress.remainingMs) : "finalizing"}
                    </span>
                  </div>
                </div>
              </div>
              <div className="mt-3 h-3 overflow-hidden rounded-full bg-background">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-out"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                <span>{progress.percent}%</span>
                <span>Estimated total {formatDuration(estimatedDurationMs)}</span>
              </div>
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={!canRun}
              onClick={() => void runCheck()}
              className={cn(
                "inline-flex h-11 cursor-pointer items-center gap-2 rounded-md px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                "bg-emerald-600 text-white hover:bg-emerald-700",
              )}
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Download className="h-4 w-4" aria-hidden />
              )}
              {running ? "Checking tracking..." : "Run Tracking Check"}
            </button>
            {lastFilename ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-emerald-400">
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                Downloaded {lastFilename}
              </span>
            ) : null}
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-lg border border-border bg-card/40 p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Puzzle className="h-4 w-4 text-[#C43E3E]" aria-hidden />
              Browser setup
            </h2>
            <ol className="mt-4 space-y-3 text-sm text-muted-foreground">
              <li>Use normal Chrome for TPP eBay.</li>
              <li>Use Incognito for TT eBay.</li>
              <li>Enable the helper extension in Incognito.</li>
              <li>Download one session file from each browser.</li>
              <li>Upload both session files here with the `.xlsx` files.</li>
            </ol>
          </section>

          <section className="rounded-lg border border-border bg-card/40 p-5">
            <h2 className="text-sm font-semibold text-foreground">Output tabs</h2>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>`Delivered and Matched`</li>
              <li>`Delivered No Match`</li>
              <li>`In Transit` with latest scan in column F</li>
              <li>`Non eBay Orders`</li>
              <li>`Full Audit`</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
