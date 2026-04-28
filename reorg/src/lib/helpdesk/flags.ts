/**
 * Help Desk feature flags.
 *
 * All outbound-affecting behavior is gated. Defaults are SAFE: messaging is
 * blocked unless an admin explicitly turns it on per environment.
 *
 * Production rollout sequence:
 *   1. HELPDESK_SAFE_MODE=true   (default; sync-only, no sends, no Resend)
 *   2. HELPDESK_SAFE_MODE=false + HELPDESK_ENABLE_EBAY_SEND=true   (eBay replies live)
 *   3. HELPDESK_ENABLE_RESEND_EXTERNAL=true                         (External email composer live)
 *   4. HELPDESK_ENABLE_ATTACHMENTS=true                              (outbound attachments)
 *
 * SAFE MODE COUPLING:
 *   The Global Write Lock (Settings → Write Safety) is the master killswitch
 *   for ALL outbound marketplace traffic. When the lock is ON, Help Desk
 *   safe mode is ALSO on — no eBay sends, no ReviseMyMessages, no Resend
 *   email, no read-state mirroring. Sync (pulling messages, hydrating
 *   bodies, fetching order context) still works because pulls never mutate
 *   eBay state. Use `helpdeskFlagsSnapshotAsync()` for any code path that
 *   actually decides whether to call eBay; the synchronous snapshot is
 *   env-only and is only safe for displaying defaults.
 */
import { db } from "@/lib/db";

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return fallback;
}

export const helpdeskFlags = {
  /**
   * When true, all outbound paths are blocked (eBay sends + Resend emails).
   * Sync, internal notes, drafts, and read APIs continue to work.
   * Default: TRUE — must be explicitly disabled to ship messages.
   */
  get safeMode(): boolean {
    return readBool("HELPDESK_SAFE_MODE", true);
  },
  /** When true, eBay AAQToPartner / RTQ sends are allowed (subject to safeMode). */
  get enableEbaySend(): boolean {
    return readBool("HELPDESK_ENABLE_EBAY_SEND", false);
  },
  /** When true, the External composer mode (Resend email) is allowed. */
  get enableResendExternal(): boolean {
    return readBool("HELPDESK_ENABLE_RESEND_EXTERNAL", false);
  },
  /** When true, outbound attachments are allowed (still validated). */
  get enableAttachments(): boolean {
    return readBool("HELPDESK_ENABLE_ATTACHMENTS", false);
  },
  /**
   * When true, marking a ticket read in reorG also queues a `ReviseMyMessages`
   * call to mark the corresponding eBay messages read. Still subject to
   * `safeMode` — when safeMode is on the call is suppressed (queued only as a
   * no-op) so we never silently write to eBay during the staging window.
   *
   * Default: FALSE — opt-in. Most teams want reorG read-state to be its own
   * thing during initial rollout.
   */
  get enableEbayReadSync(): boolean {
    return readBool("HELPDESK_ENABLE_EBAY_READ_SYNC", false);
  },
};

export interface HelpdeskFlagsSnapshot {
  safeMode: boolean;
  /** True iff the env-level HELPDESK_SAFE_MODE is on. */
  envSafeMode: boolean;
  /** True iff the global write lock (DB AppSetting) is on. Always false in the sync snapshot. */
  globalWriteLock: boolean;
  enableEbaySend: boolean;
  enableResendExternal: boolean;
  enableAttachments: boolean;
  enableEbayReadSync: boolean;
  effectiveCanSendEbay: boolean;
  effectiveCanSendEmail: boolean;
  effectiveCanSyncReadState: boolean;
}

/**
 * Synchronous snapshot — env-only. Does NOT consult the DB write lock.
 *
 * Use this when you only need to display the env-level defaults (tests,
 * a stale UI fallback). For ANY decision about whether to call eBay you
 * must use {@link helpdeskFlagsSnapshotAsync} so the global write lock
 * (Settings → Write Safety) is honored.
 */
export function helpdeskFlagsSnapshot(): HelpdeskFlagsSnapshot {
  const envSafeMode = helpdeskFlags.safeMode;
  const enableEbaySend = helpdeskFlags.enableEbaySend;
  const enableResendExternal = helpdeskFlags.enableResendExternal;
  const enableEbayReadSync = helpdeskFlags.enableEbayReadSync;
  return {
    safeMode: envSafeMode,
    envSafeMode,
    globalWriteLock: false,
    enableEbaySend,
    enableResendExternal,
    enableAttachments: helpdeskFlags.enableAttachments,
    enableEbayReadSync,
    effectiveCanSendEbay: !envSafeMode && enableEbaySend,
    effectiveCanSendEmail: !envSafeMode && enableResendExternal,
    effectiveCanSyncReadState: !envSafeMode && enableEbayReadSync,
  };
}

/**
 * Pure composition: given the env-only snapshot AND the current global
 * write lock value, return the effective snapshot. Exported separately so
 * tests can pin the boolean math without touching the DB.
 *
 * Truth table for `safeMode` and the `effectiveCan*` outputs:
 *
 *   envSafeMode | globalWriteLock | safeMode | can send eBay / email / sync read
 *   ------------+-----------------+----------+----------------------------------
 *   false       | false           | false    | follows individual enable flags
 *   true        | false           | true     | all FALSE
 *   false       | true            | true     | all FALSE   ← the new coupling
 *   true        | true            | true     | all FALSE
 *
 * The lock can ONLY tighten safety; it can never enable a send.
 */
export function applyGlobalWriteLock(
  base: HelpdeskFlagsSnapshot,
  globalWriteLock: boolean,
): HelpdeskFlagsSnapshot {
  const safeMode = base.envSafeMode || globalWriteLock;
  return {
    ...base,
    safeMode,
    globalWriteLock,
    effectiveCanSendEbay: !safeMode && base.enableEbaySend,
    effectiveCanSendEmail: !safeMode && base.enableResendExternal,
    effectiveCanSyncReadState: !safeMode && base.enableEbayReadSync,
  };
}

/**
 * Async snapshot that consults both the global write lock AND the
 * DB-stored Help Desk safe mode toggle (`AppSetting.helpdesk_safe_mode`).
 *
 * Priority: env `HELPDESK_SAFE_MODE` OR DB `helpdesk_safe_mode` OR
 * `global_write_lock` — ANY of these being true forces safe mode on.
 * The DB toggle lets admins flip safe mode from the UI without a redeploy.
 *
 * This is the snapshot every server route / cron worker / outbound worker
 * MUST call before talking to eBay.
 */
export async function helpdeskFlagsSnapshotAsync(): Promise<HelpdeskFlagsSnapshot> {
  const base = helpdeskFlagsSnapshot();
  let globalWriteLock = false;
  let dbSafeMode: boolean | null = null;
  let dbReadSync = false;
  let dbEbaySend: boolean | null = null;
  let dbResendExternal: boolean | null = null;
  let dbAttachments: boolean | null = null;
  try {
    const [
      lockRow,
      safeModeRow,
      readSyncRow,
      ebaySendRow,
      resendRow,
      attachmentsRow,
    ] = await Promise.all([
      db.appSetting.findUnique({ where: { key: "global_write_lock" } }),
      db.appSetting.findUnique({ where: { key: "helpdesk_safe_mode" } }),
      db.appSetting.findUnique({ where: { key: "helpdesk_read_sync" } }),
      db.appSetting.findUnique({ where: { key: "helpdesk_ebay_send" } }),
      db.appSetting.findUnique({ where: { key: "helpdesk_resend_external" } }),
      db.appSetting.findUnique({ where: { key: "helpdesk_attachments" } }),
    ]);
    globalWriteLock = lockRow?.value === true;
    dbSafeMode = safeModeRow ? safeModeRow.value === true : null;
    dbReadSync = readSyncRow?.value === true;
    dbEbaySend = ebaySendRow ? ebaySendRow.value === true : null;
    dbResendExternal = resendRow ? resendRow.value === true : null;
    dbAttachments = attachmentsRow ? attachmentsRow.value === true : null;
  } catch {
    globalWriteLock = true;
    dbSafeMode = true;
  }
  // DB toggle overrides the env var when it exists. This lets admins flip
  // flags from the UI without a redeploy. When no DB row exists we fall
  // back to the env default.
  const effectiveSafeMode = dbSafeMode !== null ? dbSafeMode : base.envSafeMode;
  const merged = {
    ...base,
    envSafeMode: effectiveSafeMode,
    safeMode: effectiveSafeMode,
    enableEbayReadSync: base.enableEbayReadSync || dbReadSync,
    enableEbaySend: dbEbaySend !== null ? dbEbaySend : base.enableEbaySend,
    enableResendExternal: dbResendExternal !== null ? dbResendExternal : base.enableResendExternal,
    enableAttachments: dbAttachments !== null ? dbAttachments : base.enableAttachments,
  };
  return applyGlobalWriteLock(merged, globalWriteLock);
}
