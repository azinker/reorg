"use client";

import { useState } from "react";
import { ShieldAlert, Loader2, ArrowLeft } from "lucide-react";

/**
 * Persistent banner shown across every page while an admin is impersonating
 * an operator via "Login as". Two responsibilities:
 *
 *   1. Make it visually impossible to forget you're driving someone else's
 *      session (saturated amber bar across the entire viewport, can't be
 *      dismissed).
 *   2. Provide a one-click way back to the admin's own account by hitting
 *      `DELETE /api/users/impersonate` and reloading.
 *
 * The actual identity swap happens server-side via a signed cookie; this
 * component only reflects state and offers the exit button.
 */
interface Props {
  /** The admin who started this session (always shown — for trust). */
  realName: string;
  realEmail: string;
  /** Who the admin is currently appearing as. */
  targetName: string;
  targetEmail: string;
}

export function ImpersonationBanner({
  realName,
  realEmail,
  targetName,
  targetEmail,
}: Props) {
  const [exiting, setExiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function returnToAdmin() {
    setExiting(true);
    setError(null);
    try {
      const res = await fetch("/api/users/impersonate", { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(
          (j as { error?: string }).error ?? "Failed to stop impersonating.",
        );
      }
      // Hard reload so the server-side actor is re-evaluated and the entire
      // app shell re-renders with the admin's permissions.
      window.location.assign("/users");
    } catch (err) {
      setExiting(false);
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  return (
    <div
      role="status"
      className="flex w-full items-center gap-3 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-amber-900 dark:text-amber-100"
    >
      <ShieldAlert className="h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 text-sm">
        <span className="font-semibold">Logged in as {targetName}</span>
        <span className="ml-2 text-xs text-amber-800/80 dark:text-amber-100/80">
          ({targetEmail}) — your real account is{" "}
          <span className="font-medium">{realName}</span> ({realEmail}).
        </span>
        {error ? (
          <span className="ml-2 text-xs text-red-700 dark:text-red-300">
            {error}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        onClick={returnToAdmin}
        disabled={exiting}
        className="inline-flex items-center gap-1.5 rounded-md border border-amber-600/40 bg-amber-600/20 px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-600/30 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-300/30 dark:bg-amber-300/10 dark:text-amber-100 dark:hover:bg-amber-300/20"
      >
        {exiting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ArrowLeft className="h-3.5 w-3.5" />
        )}
        Return to my account
      </button>
    </div>
  );
}
