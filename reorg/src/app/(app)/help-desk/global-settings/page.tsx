"use client";

/**
 * Global Help Desk Settings — ADMIN ONLY (/help-desk/global-settings)
 *
 * This page is the single home for org-wide controls that DON'T live on a
 * per-agent basis. Per-agent toggles (send delay, density, layout, etc.) live
 * at /help-desk/profile and only affect that agent's own view.
 *
 * Sections (in order of "blast radius"):
 *
 *   1. Safe Mode + Outbound flags (read-only display).
 *      These are env-driven (HELPDESK_SAFE_MODE, HELPDESK_ENABLE_EBAY_SEND,
 *      HELPDESK_ENABLE_RESEND_EXTERNAL, HELPDESK_ENABLE_ATTACHMENTS) so the
 *      page shows the current effective state and links to the docs that
 *      explain how to flip them. We deliberately don't expose a UI toggle —
 *      a config change is a deploy event so it gets audit-logged for free.
 *
 *   2. Sync controls.
 *      - Manual full sync (POST /api/helpdesk/sync) — shows current sync
 *        status (last tick, last outcome, per-checkpoint state).
 *      - Retroactive auto-resolve (POST /api/helpdesk/auto-resolve) — used
 *        once after the initial 180-day backfill to close tickets where the
 *        agent already replied on eBay before reorG existed.
 *
 *   3. Write Locks (information panel — links into /integrations).
 *      Write locks live with the integration record; this page links there
 *      rather than duplicating that UI.
 *
 * All write actions on this page are gated by:
 *   - client check (redirects non-admins to /help-desk)
 *   - server check (every API route already enforces session.user.role==="ADMIN")
 *
 * The client check is a UX nicety. The server check is the source of truth.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ShieldCheck,
  ShieldAlert,
  Loader2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Lock,
  ExternalLink,
  Sparkles,
} from "lucide-react";
import type { HelpdeskSyncStatus } from "@/hooks/use-helpdesk";

interface MeProfile {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

interface AutoResolveResult {
  scanned: number;
  resolved: number;
  errors: number;
}

export default function HelpdeskGlobalSettingsPage() {
  const [me, setMe] = useState<MeProfile | null>(null);
  const [meLoading, setMeLoading] = useState(true);
  const [meError, setMeError] = useState<string | null>(null);

  const [sync, setSync] = useState<HelpdeskSyncStatus | null>(null);
  const [syncLoading, setSyncLoading] = useState(true);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const [autoResolveBusy, setAutoResolveBusy] = useState(false);
  const [autoResolveResult, setAutoResolveResult] = useState<AutoResolveResult | null>(null);
  const [autoResolveError, setAutoResolveError] = useState<string | null>(null);
  const [autoResolveConfirm, setAutoResolveConfirm] = useState(false);

  const [safeModeToggling, setSafeModeToggling] = useState(false);
  const [safeModeDb, setSafeModeDb] = useState<boolean | null>(null);

  // ── Initial load: who am I + current sync status ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [meRes, syncRes, smRes] = await Promise.all([
          fetch("/api/users/me", { cache: "no-store" }),
          fetch("/api/helpdesk/sync-status", { cache: "no-store" }),
          fetch("/api/settings?key=helpdesk_safe_mode", { cache: "no-store" }),
        ]);
        if (!meRes.ok) throw new Error(`me ${meRes.status}`);
        const meJson = (await meRes.json()) as { data: MeProfile };
        if (cancelled) return;
        setMe(meJson.data);
        if (syncRes.ok) {
          const sJson = (await syncRes.json()) as { data: HelpdeskSyncStatus };
          if (!cancelled) setSync(sJson.data);
        }
        if (smRes.ok) {
          const smJson = (await smRes.json()) as { data: boolean | null };
          if (!cancelled) setSafeModeDb(smJson.data ?? true);
        }
      } catch (e) {
        if (!cancelled) {
          setMeError(e instanceof Error ? e.message : "Failed to load");
        }
      } finally {
        if (!cancelled) {
          setMeLoading(false);
          setSyncLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshSyncStatus() {
    try {
      const res = await fetch("/api/helpdesk/sync-status", { cache: "no-store" });
      if (res.ok) {
        const j = (await res.json()) as { data: HelpdeskSyncStatus };
        setSync(j.data);
      }
    } catch {
      // best-effort
    }
  }

  async function onToggleSafeMode() {
    setSafeModeToggling(true);
    try {
      const newVal = !safeModeDb;
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "helpdesk_safe_mode", value: newVal }),
      });
      if (res.ok) {
        setSafeModeDb(newVal);
        await refreshSyncStatus();
      }
    } catch {
      // best-effort
    } finally {
      setSafeModeToggling(false);
    }
  }

  async function onManualSync() {
    setSyncBusy(true);
    setSyncMessage(null);
    setSyncError(null);
    try {
      const res = await fetch("/api/helpdesk/sync", { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !j.ok) {
        throw new Error(j.error ?? `Sync failed (${res.status})`);
      }
      setSyncMessage("Sync completed successfully.");
      await refreshSyncStatus();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncBusy(false);
    }
  }

  async function onAutoResolve() {
    setAutoResolveBusy(true);
    setAutoResolveError(null);
    setAutoResolveResult(null);
    try {
      const res = await fetch("/api/helpdesk/auto-resolve", { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as {
        data?: AutoResolveResult;
        error?: string;
      };
      if (!res.ok || !j.data) {
        throw new Error(j.error ?? `Auto-resolve failed (${res.status})`);
      }
      setAutoResolveResult(j.data);
      setAutoResolveConfirm(false);
    } catch (e) {
      setAutoResolveError(e instanceof Error ? e.message : "Auto-resolve failed");
    } finally {
      setAutoResolveBusy(false);
    }
  }

  // ── Render guards ─────────────────────────────────────────────────────────
  if (meLoading) {
    return (
      <div className="flex h-full min-h-[400px] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!me) {
    return (
      <div className="px-6 py-8 text-sm text-red-700 dark:text-red-300">
        {meError ?? "Failed to load your profile."}
      </div>
    );
  }
  if (me.role !== "ADMIN") {
    return (
      <div className="mx-auto max-w-2xl px-6 py-12">
        <div className="rounded-xl border border-hairline bg-card p-6 text-center">
          <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-amber-500" />
          <h1 className="text-lg font-semibold text-foreground">
            Admins only
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This page is restricted to Admin users. Per-agent preferences live
            on{" "}
            <Link href="/help-desk/profile" className="text-brand hover:underline">
              your profile
            </Link>{" "}
            instead.
          </p>
          <Link
            href="/help-desk"
            className="mt-4 inline-flex items-center gap-2 rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-foreground hover:bg-surface-2 cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Help Desk
          </Link>
        </div>
      </div>
    );
  }

  const flags = sync?.flags;
  const safeMode = flags?.safeMode ?? true;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/help-desk"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Help Desk
        </Link>
      </div>

      <header className="mb-6 flex items-start gap-3">
        <div className="rounded-lg bg-brand-muted p-2">
          <ShieldCheck className="h-5 w-5 text-brand" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            Global Settings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Org-wide controls. Affects every agent and every ticket. Per-agent
            preferences (send delay, layout, density) live on{" "}
            <Link href="/help-desk/profile" className="text-brand hover:underline">
              your profile
            </Link>
            .
          </p>
        </div>
      </header>

      {/* ─── 1. Safe Mode + outbound flags ─────────────────────────────────── */}
      <section className="mb-8 rounded-xl border border-hairline bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Outbound Safety
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Controls which channels can send messages and sync read state
              with eBay.
            </p>
          </div>
          <span
            className={
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold " +
              (safeMode
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300")
            }
          >
            {safeMode ? (
              <>
                <Lock className="h-3 w-3" /> Safe Mode ON
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3" /> Live
              </>
            )}
          </span>
        </div>

        {/* Safe Mode toggle */}
        <div className="mb-4 rounded-lg border border-hairline bg-surface p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-amber-500" />
                <span className="text-sm font-semibold text-foreground">
                  Help Desk Safe Mode
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                When ON, all outbound actions are blocked: no eBay replies, no
                email sends, and no read/unread sync between eBay and Help Desk.
                Incoming sync (pulling messages) still works normally. Turn this
                OFF when ready to go live.
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Also visible under{" "}
                <Link href="/settings" className="text-brand hover:underline">
                  Settings → Safety Controls
                </Link>
                . The Global Write Lock overrides this — if the write lock is ON,
                safe mode is forced ON regardless of this toggle.
              </p>
            </div>
            <button
              type="button"
              onClick={onToggleSafeMode}
              disabled={safeModeToggling}
              className={
                "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors cursor-pointer disabled:opacity-50 " +
                ((safeModeDb ?? true)
                  ? "bg-amber-500"
                  : "bg-zinc-300 dark:bg-zinc-600")
              }
            >
              <span
                className={
                  "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform " +
                  ((safeModeDb ?? true) ? "translate-x-5" : "translate-x-0.5")
                }
              />
            </button>
          </div>
        </div>

        {syncLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : flags ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <FlagRow
              label="eBay sends"
              value={flags.enableEbaySend}
              hint="Allow agents to send eBay buyer messages."
              good={(v) => v && !flags.safeMode}
              env="HELPDESK_ENABLE_EBAY_SEND"
            />
            <FlagRow
              label="External email"
              value={flags.enableResendExternal}
              hint="Allow the External composer mode (Resend email)."
              good={(v) => v && !flags.safeMode}
              env="HELPDESK_ENABLE_RESEND_EXTERNAL"
            />
            <FlagRow
              label="Outbound attachments"
              value={flags.enableAttachments}
              hint="Allow agents to attach files to outbound replies."
              good={(v) => v}
              env="HELPDESK_ENABLE_ATTACHMENTS"
            />
            <FlagRow
              label="eBay read sync"
              value={flags.enableEbayReadSync}
              hint="Sync read/unread state between eBay and Help Desk. FROM EBAY tickets are always excluded."
              good={(v) => v && !flags.safeMode}
              env="HELPDESK_ENABLE_EBAY_READ_SYNC"
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Could not read flag state.
          </p>
        )}
        {flags ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-3 text-xs">
            <EffectiveRow
              label="Effective: can send eBay"
              ok={flags.effectiveCanSendEbay}
            />
            <EffectiveRow
              label="Effective: can send email"
              ok={flags.effectiveCanSendEmail}
            />
            <EffectiveRow
              label="Effective: read sync"
              ok={flags.effectiveCanSyncReadState}
            />
          </div>
        ) : null}
        <p className="mt-4 text-[11px] text-muted-foreground">
          Channel flags (eBay sends, External email, Attachments, Read sync) are
          set via environment variables (Vercel → Settings → Environment
          Variables). Safe Mode can be toggled above or from{" "}
          <Link href="/settings" className="text-brand hover:underline">
            Settings
          </Link>
          .
        </p>
      </section>

      {/* ─── 2. Sync controls ──────────────────────────────────────────────── */}
      <section className="mb-8 rounded-xl border border-hairline bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Sync
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              eBay sync runs automatically every 5 minutes. You can also kick
              one off manually below.
            </p>
          </div>
          <button
            type="button"
            onClick={onManualSync}
            disabled={syncBusy}
            className="inline-flex items-center gap-2 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground hover:opacity-90 disabled:opacity-50 cursor-pointer"
          >
            {syncBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Run sync now
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <SyncStat
            label="Last tick"
            value={
              sync?.lastTickAt
                ? new Date(sync.lastTickAt).toLocaleString()
                : "Never"
            }
          />
          <SyncStat
            label="Last outcome"
            value={sync?.lastOutcome ?? "Unknown"}
            tone={sync?.lastOutcome === "OK" ? "good" : sync?.lastOutcome ? "warn" : undefined}
          />
          <SyncStat
            label="Checkpoints"
            value={sync ? `${sync.checkpoints.length} integration${sync.checkpoints.length === 1 ? "" : "s"}` : "—"}
          />
        </div>
        {sync && sync.checkpoints.length > 0 ? (
          <div className="mt-4 overflow-hidden rounded-md border border-hairline">
            <table className="w-full text-xs">
              <thead className="bg-surface text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Integration</th>
                  <th className="px-3 py-2 text-left font-medium">Folder</th>
                  <th className="px-3 py-2 text-left font-medium">Watermark</th>
                  <th className="px-3 py-2 text-left font-medium">Backfill</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {sync.checkpoints.map((c) => (
                  <tr key={`${c.integrationId}-${c.folder}`} className="bg-card">
                    <td className="px-3 py-2 text-foreground">
                      {c.integrationLabel ?? c.integrationId.slice(0, 8)}
                    </td>
                    <td className="px-3 py-2 text-foreground">{c.folder}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {c.lastWatermark
                        ? new Date(c.lastWatermark).toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {c.backfillDone ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                          <CheckCircle2 className="h-3 w-3" /> Done
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                          <Clock className="h-3 w-3" /> In progress
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {syncMessage ? (
          <p className="mt-3 inline-flex items-center gap-2 rounded-md bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" /> {syncMessage}
          </p>
        ) : null}
        {syncError ? (
          <p className="mt-3 inline-flex items-center gap-2 rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-300">
            <XCircle className="h-3.5 w-3.5" /> {syncError}
          </p>
        ) : null}
      </section>

      {/* ─── 3. Retroactive auto-resolve ───────────────────────────────────── */}
      <section className="mb-8 rounded-xl border border-hairline bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Retroactive Auto-Resolve
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          One-time maintenance job. Walks every open ticket and marks it
          RESOLVED when the most recent message is outbound — i.e. you already
          replied on eBay before reorG existed. Intended to be run once after
          the initial 180-day backfill finishes; the live sync handles new
          traffic automatically going forward. Safe to run multiple times
          (idempotent).
        </p>

        {autoResolveResult ? (
          <div className="mt-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
            Scanned {autoResolveResult.scanned} ticket
            {autoResolveResult.scanned === 1 ? "" : "s"}, resolved{" "}
            <strong>{autoResolveResult.resolved}</strong>.
            {autoResolveResult.errors > 0
              ? ` (${autoResolveResult.errors} error${autoResolveResult.errors === 1 ? "" : "s"})`
              : ""}
          </div>
        ) : null}
        {autoResolveError ? (
          <div className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
            {autoResolveError}
          </div>
        ) : null}

        <div className="mt-4 flex items-center gap-2">
          {autoResolveConfirm ? (
            <>
              <button
                type="button"
                onClick={onAutoResolve}
                disabled={autoResolveBusy}
                className="inline-flex items-center gap-2 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50 cursor-pointer"
              >
                {autoResolveBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                Yes, run it
              </button>
              <button
                type="button"
                onClick={() => setAutoResolveConfirm(false)}
                disabled={autoResolveBusy}
                className="inline-flex items-center gap-2 rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setAutoResolveConfirm(true)}
              className="inline-flex items-center gap-2 rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-foreground hover:bg-surface-2 cursor-pointer"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Run auto-resolve
            </button>
          )}
        </div>
      </section>

      {/* ─── 4. Write Locks (link to integrations) ─────────────────────────── */}
      <section className="mb-8 rounded-xl border border-hairline bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Write Locks
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Marketplace write safety. Per-integration write locks live with the
          integration record itself, so they're managed under{" "}
          <Link
            href="/integrations"
            className="text-brand hover:underline inline-flex items-center gap-1"
          >
            Integrations <ExternalLink className="h-3 w-3" />
          </Link>
          . When a write lock is enabled for an integration, no outbound
          messages or pushes will fire for that store, even if Safe Mode is
          off.
        </p>
      </section>

      <p className="mt-8 text-center text-[11px] text-muted-foreground">
        Logged in as <strong>{me.email}</strong> (Admin). All actions on this
        page are recorded in the audit log.
      </p>
    </div>
  );
}

function FlagRow({
  label,
  value,
  hint,
  good,
  env,
}: {
  label: string;
  value: boolean;
  hint: string;
  good: (v: boolean) => boolean;
  env: string;
}) {
  const isGood = good(value);
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-hairline bg-surface px-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {isGood ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <Lock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
        <code className="mt-1 inline-block rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {env}={String(value)}
        </code>
      </div>
    </div>
  );
}

function EffectiveRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div
      className={
        "inline-flex items-center justify-between rounded-md border px-3 py-2 " +
        (ok
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300")
      }
    >
      <span>{label}</span>
      <span className="font-semibold">{ok ? "Yes" : "No"}</span>
    </div>
  );
}

function SyncStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn";
}) {
  const toneCls =
    tone === "good"
      ? "text-emerald-700 dark:text-emerald-300"
      : tone === "warn"
        ? "text-amber-700 dark:text-amber-300"
        : "text-foreground";
  return (
    <div className="rounded-md border border-hairline bg-surface px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={"mt-0.5 text-sm font-medium " + toneCls}>{value}</div>
    </div>
  );
}
