import crypto from "node:crypto";
import { db } from "@/lib/db";
import { checkWriteSafety } from "@/lib/safety";
import type {
  EbayStore,
  HumanActionTokenPayload,
  ManageOrderActionType,
} from "@/lib/manage-orders/types";

const TOKEN_VERSION = "mo1";
const TOKEN_TTL_MS = 5 * 60 * 1000;
const ALLOWED_ROLES = new Set(["ADMIN", "OPERATOR"]);

export type ManageOrdersActor = {
  id: string;
  role: string;
};

export type LiveEbayMutationGuardInput = {
  user: ManageOrdersActor | null | undefined;
  actionType: ManageOrderActionType;
  orderId: string;
  store: EbayStore;
  humanActionToken: string | null | undefined;
  requestHeaders?: Headers;
};

function secret() {
  const value =
    process.env.MANAGE_ORDERS_HUMAN_ACTION_SECRET ??
    process.env.AUTH_SECRET ??
    process.env.NEXTAUTH_SECRET;
  if (!value || value.length < 16) {
    throw new Error("Manage Orders human action token secret is not configured.");
  }
  return value;
}

function isProductionRuntime() {
  if (process.env.VERCEL_ENV) {
    return process.env.VERCEL_ENV === "production";
  }
  return process.env.NEXT_PUBLIC_APP_ENV === "production" && process.env.NODE_ENV === "production";
}

export function liveEbayOrderMutationsEnabled() {
  return process.env.ENABLE_LIVE_EBAY_ORDER_MUTATIONS === "true";
}

export function isBlockedAutomationContext(headers?: Headers) {
  const ua = headers?.get("user-agent")?.toLowerCase() ?? "";
  const trigger = headers?.get("x-trigger-source")?.toLowerCase() ?? "";
  const testHeader = headers?.get("x-reorg-test-run")?.toLowerCase() ?? "";
  return (
    process.env.NODE_ENV === "test" ||
    process.env.PLAYWRIGHT_TEST === "1" ||
    process.env.CI_PLAYWRIGHT === "1" ||
    testHeader === "true" ||
    trigger === "scheduler" ||
    trigger === "cron" ||
    ua.includes("playwright")
  );
}

function hasValidSameOrigin(headers?: Headers) {
  if (!headers) return false;
  const origin = headers.get("origin");
  const host = headers.get("host");
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function signPayload(payloadBase64: string) {
  return crypto.createHmac("sha256", secret()).update(payloadBase64).digest("base64url");
}

export function createHumanActionToken(input: {
  userId: string;
  orderId: string;
  store: EbayStore;
  actionType: ManageOrderActionType;
  now?: number;
}) {
  const payload: HumanActionTokenPayload = {
    userId: input.userId,
    orderId: input.orderId,
    store: input.store,
    actionType: input.actionType,
    expiresAt: (input.now ?? Date.now()) + TOKEN_TTL_MS,
    nonce: crypto.randomUUID(),
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${TOKEN_VERSION}.${payloadBase64}.${signPayload(payloadBase64)}`;
}

export function parseHumanActionToken(token: string) {
  const [version, payloadBase64, signature] = token.split(".");
  if (version !== TOKEN_VERSION || !payloadBase64 || !signature) {
    throw new Error("Invalid human action token.");
  }
  const expected = signPayload(payloadBase64);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid human action token signature.");
  }
  const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8")) as HumanActionTokenPayload;
  if (payload.expiresAt < Date.now()) {
    throw new Error("Human action token expired.");
  }
  return payload;
}

export async function assertCanPerformLiveEbayOrderMutation(input: LiveEbayMutationGuardInput) {
  const user = input.user;
  if (!user) {
    await logBlockedMutation(input, "unauthorized");
    return { allowed: false as const, message: "Unauthorized." };
  }
  if (!ALLOWED_ROLES.has(user.role)) {
    await logBlockedMutation(input, "role_not_allowed", user.id);
    return { allowed: false as const, message: "You do not have permission to perform this action." };
  }
  if (!liveEbayOrderMutationsEnabled()) {
    await logBlockedMutation(input, "live_flag_disabled", user.id);
    return {
      allowed: false as const,
      message: "Live eBay order actions are currently disabled.",
    };
  }
  if (!isProductionRuntime()) {
    await logBlockedMutation(input, "not_production", user.id);
    return {
      allowed: false as const,
      message: "Live eBay order actions are only allowed in production.",
    };
  }
  if (isBlockedAutomationContext(input.requestHeaders)) {
    await logBlockedMutation(input, "automation_context", user.id);
    return {
      allowed: false as const,
      message: "Live eBay order actions cannot run from automated test or background contexts.",
    };
  }
  if (!hasValidSameOrigin(input.requestHeaders)) {
    await logBlockedMutation(input, "csrf_origin_mismatch", user.id);
    return {
      allowed: false as const,
      message: "Could not verify request origin. Please refresh and try again.",
    };
  }
  const writeSafety = await checkWriteSafety(input.store);
  if (!writeSafety.allowed) {
    await logBlockedMutation(input, "write_safety_blocked", user.id);
    return {
      allowed: false as const,
      message: writeSafety.reason ?? "Live eBay order actions are blocked by write safety controls.",
    };
  }
  if (!input.humanActionToken) {
    await logBlockedMutation(input, "missing_human_action_token", user.id);
    return {
      allowed: false as const,
      message: "Final confirmation token is missing. Please reopen the confirmation modal.",
    };
  }

  let tokenPayload: HumanActionTokenPayload;
  try {
    tokenPayload = parseHumanActionToken(input.humanActionToken);
  } catch (error) {
    await logBlockedMutation(input, "invalid_human_action_token", user.id);
    return {
      allowed: false as const,
      message: error instanceof Error ? error.message : "Invalid human action token.",
    };
  }

  if (
    tokenPayload.userId !== user.id ||
    tokenPayload.orderId !== input.orderId ||
    tokenPayload.store !== input.store ||
    tokenPayload.actionType !== input.actionType
  ) {
    await logBlockedMutation(input, "human_action_token_scope_mismatch", user.id);
    return {
      allowed: false as const,
      message: "Confirmation token does not match this action.",
    };
  }

  return { allowed: true as const };
}

async function logBlockedMutation(
  input: Pick<LiveEbayMutationGuardInput, "actionType" | "orderId" | "store">,
  reason: string,
  userId?: string,
) {
  await db.auditLog.create({
    data: {
      userId,
      action: "manage_orders_ebay_mutation_blocked",
      entityType: "ebay_order",
      entityId: input.orderId,
      details: {
        feature: "manage_orders",
        actionType: input.actionType,
        store: input.store,
        reason,
      },
    },
  }).catch(() => {});
}
