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
 */

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

/**
 * Returns the public-safe snapshot of helpdesk flags. Safe to send to the
 * client (used by Settings page to display current mode).
 */
export function helpdeskFlagsSnapshot(): {
  safeMode: boolean;
  enableEbaySend: boolean;
  enableResendExternal: boolean;
  enableAttachments: boolean;
  enableEbayReadSync: boolean;
  effectiveCanSendEbay: boolean;
  effectiveCanSendEmail: boolean;
  effectiveCanSyncReadState: boolean;
} {
  const safeMode = helpdeskFlags.safeMode;
  const enableEbaySend = helpdeskFlags.enableEbaySend;
  const enableResendExternal = helpdeskFlags.enableResendExternal;
  const enableEbayReadSync = helpdeskFlags.enableEbayReadSync;
  return {
    safeMode,
    enableEbaySend,
    enableResendExternal,
    enableAttachments: helpdeskFlags.enableAttachments,
    enableEbayReadSync,
    effectiveCanSendEbay: !safeMode && enableEbaySend,
    effectiveCanSendEmail: !safeMode && enableResendExternal,
    effectiveCanSyncReadState: !safeMode && enableEbayReadSync,
  };
}
