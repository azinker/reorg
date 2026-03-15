"use client";

import { Database, Download, Clock, CheckCircle, Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

const sampleBackups = [
  {
    id: "1",
    date: "2025-03-15 02:00",
    type: "Daily" as const,
    stores: "TPP, TT, BC, SHPFY",
    size: "4.2 MB",
    status: "Completed" as const,
    expiresIn: 28,
  },
  {
    id: "2",
    date: "2025-03-14 02:00",
    type: "Daily" as const,
    stores: "TPP, TT, BC, SHPFY",
    size: "4.1 MB",
    status: "Completed" as const,
    expiresIn: 5,
  },
  {
    id: "3",
    date: "2025-03-13 14:32",
    type: "Pre-Push" as const,
    stores: "TPP, TT",
    size: "2.1 MB",
    status: "In Progress" as const,
    expiresIn: 25,
  },
];

export default function BackupsPage() {
  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Backups
          </h1>
          <p className="text-sm text-muted-foreground">
            Disaster recovery — daily automated + manual backup management
          </p>
        </div>
        <button
          type="button"
          className={cn(
            "inline-flex cursor-pointer shrink-0 items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground",
            "transition-colors hover:bg-primary/90",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          )}
          aria-label="Run backup now"
        >
          <Database className="h-4 w-4" aria-hidden />
          Run Backup Now
        </button>
      </div>

      {/* Info banner */}
      <div className="mb-6 flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden />
        <p className="text-sm text-muted-foreground">
          Backups are retained for 30 days. v1 backups are download-only.
        </p>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px]">
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
              {sampleBackups.map((backup) => (
                <tr
                  key={backup.id}
                  className="border-b border-border last:border-b-0 transition-colors hover:bg-muted/30"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="text-sm text-foreground">{backup.date}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "inline-flex rounded border px-2 py-0.5 text-xs font-medium",
                        backup.type === "Daily"
                          ? "border-blue-500/40 bg-blue-500/15 text-blue-600 dark:text-blue-400"
                          : backup.type === "Pre-Push"
                            ? "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400"
                            : "border-muted-foreground/40 bg-muted text-muted-foreground"
                      )}
                    >
                      {backup.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {backup.stores}
                  </td>
                  <td className="px-4 py-3 text-sm text-foreground">
                    {backup.size}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium",
                        backup.status === "Completed"
                          ? "border-green-500/40 bg-green-500/15 text-green-600 dark:text-green-400"
                          : "border-blue-500/40 bg-blue-500/15 text-blue-600 dark:text-blue-400"
                      )}
                    >
                      {backup.status === "Completed" ? (
                        <CheckCircle className="h-3 w-3" aria-hidden />
                      ) : (
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                      )}
                      {backup.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "text-sm",
                        backup.expiresIn < 7
                          ? "font-medium text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground"
                      )}
                    >
                      {backup.expiresIn} days
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      disabled={backup.status === "In Progress"}
                      aria-label={`Download backup from ${backup.date}`}
                      className={cn(
                        "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium",
                        "bg-background text-foreground transition-colors hover:bg-muted",
                        backup.status === "In Progress" && "cursor-not-allowed opacity-50"
                      )}
                    >
                      <Download className="h-4 w-4" aria-hidden />
                      Download
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
