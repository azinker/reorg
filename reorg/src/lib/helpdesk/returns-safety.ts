/**
 * Returns live-write safety gate.
 *
 * This is the SINGLE chokepoint every return write route must pass through
 * before it is allowed to call an eBay write wrapper. It layers the returns
 * feature's own master toggle on top of the existing global write-safety chain
 * so a return write is blocked unless EVERY condition is satisfied:
 *
 *   1. Caller is an ADMIN (v1 authorization).
 *   2. Environment is not staging (staging blocks writes by default).
 *   3. Global write lock is OFF.
 *   4. The eBay integration exists, is enabled, and is not write-locked.
 *   5. The returns-specific master toggle `returns_live_writes` is ON.
 *      Absent/false ⇒ LOCKED (the safe default — no migration needed to ship
 *      with writes off).
 *   6. The specific action is currently offered by eBay on a FRESHLY re-fetched
 *      return (the route passes in the just-fetched sellerAvailableOptions) and
 *      is not policy-blocked (e.g. paid eBay-label purchase).
 *
 * The pure decision function {@link evaluateReturnWriteGate} contains the
 * boolean math and is unit-tested in isolation. {@link assertReturnWriteAllowed}
 * is the DB-consulting wrapper used by routes.
 */

import { getAppEnv } from "@/lib/env";
import { checkWriteSafety } from "@/lib/safety";
import {
  isActionExecutable,
  POLICY_BLOCKED_ACTIONS,
  type EbayAvailableOption,
  type ReturnActionKey,
} from "@/lib/helpdesk/returns";
import type { Platform } from "@prisma/client";

export interface ReturnWriteGateContext {
  isAdmin: boolean;
  /** staging | production (writes blocked in staging). */
  appEnv: string;
  /** From checkWriteSafety: global lock + per-integration lock + enabled. */
  globalAndIntegrationAllowed: boolean;
  globalAndIntegrationReason?: string;
  /** The returns_live_writes AppSetting value (absent ⇒ false ⇒ LOCKED). */
  returnsLiveWritesEnabled: boolean;
  /** Action the caller wants to perform. */
  action: ReturnActionKey;
  /** sellerAvailableOptions from a JUST-fetched Get Return (advisory cache is never trusted). */
  freshSellerOptions: EbayAvailableOption[] | null;
}

export interface ReturnWriteGateResult {
  allowed: boolean;
  /** Stable code for audit + UI. */
  code:
    | "OK"
    | "NOT_ADMIN"
    | "STAGING_BLOCKED"
    | "WRITE_LOCK"
    | "RETURNS_LOCKED"
    | "ACTION_UNAVAILABLE"
    | "ACTION_POLICY_BLOCKED";
  reason: string;
}

/**
 * Pure gate evaluation. No I/O — the route gathers the inputs (admin flag, env,
 * write-safety result, toggle, fresh options) and this decides.
 */
export function evaluateReturnWriteGate(
  ctx: ReturnWriteGateContext,
): ReturnWriteGateResult {
  if (!ctx.isAdmin) {
    return {
      allowed: false,
      code: "NOT_ADMIN",
      reason: "Only admins can perform return actions in v1.",
    };
  }
  if (ctx.appEnv === "staging") {
    return {
      allowed: false,
      code: "STAGING_BLOCKED",
      reason: "Return writes are blocked in the staging environment.",
    };
  }
  if (!ctx.globalAndIntegrationAllowed) {
    return {
      allowed: false,
      code: "WRITE_LOCK",
      reason:
        ctx.globalAndIntegrationReason ??
        "A write lock is enabled. Disable it to allow live return writes.",
    };
  }
  if (!ctx.returnsLiveWritesEnabled) {
    return {
      allowed: false,
      code: "RETURNS_LOCKED",
      reason:
        "Live return writes are locked. Turn on “Live Return Writes” in Help Desk settings to enable them.",
    };
  }
  // Policy-blocked actions (paid/ambiguous) are never executable even when eBay
  // offers them. isActionExecutable encodes both the policy block AND the
  // availability check against the fresh options.
  const executable = isActionExecutable(ctx.action, ctx.freshSellerOptions);
  if (!executable) {
    // Distinguish "we refuse by policy" from "eBay isn't offering it right now"
    // so the audit + UI message is precise.
    const present = (ctx.freshSellerOptions ?? []).some((o) => !!o?.actionType);
    if (POLICY_BLOCKED_ACTIONS.includes(ctx.action)) {
      return {
        allowed: false,
        code: "ACTION_POLICY_BLOCKED",
        reason: "This action is disabled by policy in reorG. Handle it in eBay Seller Hub.",
      };
    }
    return {
      allowed: false,
      code: "ACTION_UNAVAILABLE",
      reason: present
        ? "eBay is not currently offering this action on this return. Refresh and try again."
        : "This action is not available on the current return state.",
    };
  }
  return { allowed: true, code: "OK", reason: "Allowed." };
}

/**
 * Returns-portal live writes are permanently ON (live production). The
 * per-portal on/off toggle was removed — return writes are gated only by the
 * broader safety chain (admin, non-staging env, the global/per-integration
 * write lock, and eBay action availability/policy), plus the mandatory
 * per-action preview → typed-confirm → commit flow. This always resolves true
 * so the returns master gate never blocks; flip the GLOBAL write lock in
 * Integrations if you need to stop all marketplace writes.
 */
export async function getReturnsLiveWritesEnabled(): Promise<boolean> {
  return true;
}

export interface AssertReturnWriteArgs {
  isAdmin: boolean;
  platform: Platform;
  action: ReturnActionKey;
  freshSellerOptions: EbayAvailableOption[] | null;
}

/**
 * DB-consulting gate used by write routes. Resolves the global/integration
 * write-safety chain, the returns toggle, and the env, then runs the pure
 * evaluation. Returns a structured result the route turns into a BLOCKED audit
 * row + typed JSON error (it never throws on a denial).
 */
export async function assertReturnWriteAllowed(
  args: AssertReturnWriteArgs,
): Promise<ReturnWriteGateResult> {
  const [writeSafety, returnsLiveWritesEnabled] = await Promise.all([
    checkWriteSafety(args.platform),
    getReturnsLiveWritesEnabled(),
  ]);
  return evaluateReturnWriteGate({
    isAdmin: args.isAdmin,
    appEnv: getAppEnv(),
    globalAndIntegrationAllowed: writeSafety.allowed,
    globalAndIntegrationReason: writeSafety.reason,
    returnsLiveWritesEnabled,
    action: args.action,
    freshSellerOptions: args.freshSellerOptions,
  });
}
