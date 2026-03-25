"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Database,
  Download,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";

type BackupType = "DAILY" | "MANUAL" | "PRE_PUSH";
type BackupStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

interface BackupRow {
  id: string;
  type: BackupType;
  fileName: string;
  size: number | null;
  stores: string[];
  status: BackupStatus;
  expiresAt: string;
  createdAt: string;
  notes: string | null;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSize(bytes: number | null) {
  if (bytes == null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function daysUntil(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  return Math.max(
    0,
    Math.ceil((d.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
  );
}

export default function BackupsPage() {
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupLoading, setBackupLoading] = useState(false);
  const [fullBackupLoading, setFullBackupLoading] = useState(false);

  function refreshBackups() {
    return fetch("/api/backup")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to load"))))
      .then((json) => {
        setBackups(json.data?.backups ?? []);
      })
      .catch(() => setBackups([]));
  }

  useEffect(() => {
    refreshBackups().finally(() => setLoading(false));
  }, []);

  // Poll while any backup is IN_PROGRESS so the table updates automatically
  useEffect(() => {
    const hasPending = backups.some((b) => b.status === "IN_PROGRESS" || b.status === "PENDING");
    if (!hasPending) return;
    const timer = setInterval(() => void refreshBackups(), 5_000);
    return () => clearInterval(timer);
  }, [backups]);

  async function runBackupNow(mode: "standard" | "full_ebay") {
    if (mode === "full_ebay") setFullBackupLoading(true);
    else setBackupLoading(true);

    setBackupMessage(null);

    try {
      const res = await fetch("/api/backup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode }),
      });
      const json = await res.json();
      const msg =
        json.data?.message ??
        (res.ok ? "Backup request sent." : json.error ?? "Request failed.");
      setBackupMessage(msg);
      if (res.ok) refreshBackups();
    } catch {
      setBackupMessage("Request failed.");
    } finally {
      if (mode === "full_ebay") setFullBackupLoading(false);
      else setBackupLoading(false);
    }
  }

  function downloadBackup(backupId: string, format: "json" | "xlsx") {
    window.location.href = `/api/backup/${backupId}/download?format=${format}`;
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div data-tour="backups-header">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Backups
          </h1>
          <p className="text-sm text-muted-foreground">
            Disaster recovery - daily automated + manual backup management
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2" data-tour="backups-actions">
          <button
            type="button"
            disabled={backupLoading || fullBackupLoading}
            onClick={() => runBackupNow("standard")}
            className={cn(
              "inline-flex cursor-pointer shrink-0 items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground",
              "transition-colors hover:bg-primary/90 disabled:opacity-50",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            )}
            aria-label="Run backup now"
          >
            {backupLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Database className="h-4 w-4" aria-hidden />
            )}
            {backupLoading ? "Running..." : "Run Backup Now"}
          </button>
          <button
            type="button"
            disabled={backupLoading || fullBackupLoading}
            onClick={() => runBackupNow("full_ebay")}
            className={cn(
              "inline-flex cursor-pointer shrink-0 items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground",
              "transition-colors hover:bg-muted disabled:opacity-50",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            )}
            aria-label="Run full eBay backup"
          >
            {fullBackupLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Database className="h-4 w-4" aria-hidden />
            )}
            {fullBackupLoading ? "Fetching eBay..." : "Run Full eBay Backup"}
          </button>
        </div>
      </div>

      {backupMessage && (
        <div className="mb-6 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          {backupMessage}
        </div>
      )}

      <div className="mb-6 flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-500"
          aria-hidden
        />
        <p className="text-sm text-muted-foreground">
          Backups are retained for 30 days. v1 backups are download-only.
        </p>
      </div>

      <div className="mb-6 rounded-lg border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Run Full eBay Backup</span> fetches richer eBay listing detail at backup time,
        including fields useful for manual listing rebuilds.
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card" data-tour="backups-list">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-4 py-3 text-left text-sm font-medium text-foreground">
                  Date
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-foreground">
                  Type
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-foreground">
                  Stores
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-foreground">
                  Size
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-foreground">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-foreground">
                  Expires In
                </th>
                <th className="px-4 py-3 text-right text-sm font-medium text-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    <Loader2
                      className="mx-auto h-6 w-6 animate-spin"
                      aria-hidden
                    />
                  </td>
                </tr>
              ) : backups.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    No backups yet. Run a backup to create one.
                  </td>
                </tr>
              ) : (
                backups.map((backup) => {
                  const typeLabel =
                    backup.type === "DAILY"
                      ? "Daily"
                      : backup.type === "PRE_PUSH"
                        ? "Pre-Push"
                        : "Manual";
                  const statusLabel =
                    backup.status === "COMPLETED"
                      ? "Completed"
                      : backup.status === "IN_PROGRESS"
                        ? "In Progress"
                        : backup.status === "FAILED"
                          ? "Failed"
                          : "Pending";
                  const expiresIn = daysUntil(backup.expiresAt);

                  return (
                    <tr
                      key={backup.id}
                      className="border-b border-border last:border-b-0 transition-colors hover:bg-muted/30"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Clock
                            className="h-4 w-4 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="text-sm text-foreground">
                            {formatDate(backup.createdAt)}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex rounded border px-2 py-0.5 text-xs font-medium",
                            backup.type === "DAILY"
                              ? "border-blue-500/40 bg-blue-500/15 text-blue-600 dark:text-blue-400"
                              : backup.type === "PRE_PUSH"
                                ? "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400"
                                : "border-muted-foreground/40 bg-muted text-muted-foreground"
                          )}
                        >
                          {typeLabel}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {Array.isArray(backup.stores)
                          ? backup.stores.join(", ")
                          : "-"}
                      </td>
                      <td className="px-4 py-3 text-sm text-foreground">
                        {formatSize(backup.size)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium",
                            backup.status === "COMPLETED"
                              ? "border-green-500/40 bg-green-500/15 text-green-600 dark:text-green-400"
                              : backup.status === "IN_PROGRESS"
                                ? "border-blue-500/40 bg-blue-500/15 text-blue-600 dark:text-blue-400"
                                : backup.status === "FAILED"
                                  ? "border-red-500/40 bg-red-500/15 text-red-600 dark:text-red-400"
                                  : "border-muted-foreground/40 bg-muted text-muted-foreground"
                          )}
                        >
                          {backup.status === "COMPLETED" ? (
                            <CheckCircle className="h-3 w-3" aria-hidden />
                          ) : backup.status === "IN_PROGRESS" ? (
                            <Loader2
                              className="h-3 w-3 animate-spin"
                              aria-hidden
                            />
                          ) : null}
                          {statusLabel}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "text-sm",
                            expiresIn < 7
                              ? "font-medium text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground"
                          )}
                        >
                          {expiresIn} days
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            disabled={backup.status !== "COMPLETED"}
                            onClick={() => downloadBackup(backup.id, "json")}
                            aria-label={`Download JSON backup from ${formatDate(backup.createdAt)}`}
                            title={
                              backup.status !== "COMPLETED"
                                ? "Download available when backup completes"
                                : "Download raw JSON backup"
                            }
                            className={cn(
                              "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium",
                              "bg-background text-foreground transition-colors hover:bg-muted",
                              backup.status !== "COMPLETED" &&
                                "cursor-not-allowed opacity-50"
                            )}
                          >
                            <Download className="h-4 w-4" aria-hidden />
                            JSON
                          </button>
                          <button
                            type="button"
                            disabled={backup.status !== "COMPLETED"}
                            onClick={() => downloadBackup(backup.id, "xlsx")}
                            aria-label={`Download Excel backup from ${formatDate(backup.createdAt)}`}
                            title={
                              backup.status !== "COMPLETED"
                                ? "Download available when backup completes"
                                : "Download Excel repair workbook"
                            }
                            className={cn(
                              "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium",
                              "bg-background text-foreground transition-colors hover:bg-muted",
                              backup.status !== "COMPLETED" &&
                                "cursor-not-allowed opacity-50"
                            )}
                          >
                            <Download className="h-4 w-4" aria-hidden />
                            XLSX
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      <PageTour page="backups" steps={PAGE_TOUR_STEPS.backups} ready />
    </div>
  );
}
