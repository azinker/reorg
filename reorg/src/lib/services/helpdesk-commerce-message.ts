/**
 * Thin typed wrapper around eBay's Commerce Message API
 * (https://api.ebay.com/commerce/message/v1).
 *
 * Why this file exists separate from helpdesk-ebay.ts:
 *   - helpdesk-ebay.ts speaks the legacy XML Trading API
 *     (GetMyMessages / ReviseMyMessages / AddMemberMessage...). That API
 *     has its own read/unread flag that, for modern buyer Q&A threads,
 *     does NOT drive the eBay web UI "Unread from members" badge.
 *   - The Commerce Message API (REST, /commerce/message/v1) is the one that
 *     backs the ebay.com/mesg web UI. Flipping `read` via
 *     `update_conversation` on this API actually changes what agents see
 *     in the web inbox — which is the behavior we want for the
 *     Help Desk <-> eBay read-state mirror.
 *
 * Scope:
 *   The app must carry `https://api.ebay.com/oauth/api_scope/commerce.message`
 *   on its user token. This scope is added to the OAuth consent URL in
 *   src/app/api/ebay/connect/route.ts. Integrations that haven't been
 *   re-authorized since that change will 403 on every call in this file;
 *   callers must handle that gracefully and fall back to the Trading API
 *   path until the agent re-OAuths.
 *
 * Reference:
 *   https://developer.ebay.com/api-docs/commerce/message/overview.html
 */

import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";
import { EbayConfig, getEbayAccessToken } from "@/lib/services/helpdesk-ebay";

const BASE = "https://api.ebay.com/commerce/message/v1";
const REQUEST_TIMEOUT_MS = 20_000;
const MARKETPLACE_ID = "EBAY_US";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CommerceMessageConversationType = "FROM_MEMBERS" | "FROM_EBAY";
export type CommerceMessageConversationStatus =
  | "ACTIVE"
  | "ARCHIVE"
  | "ARCHIVED"
  | "DELETE"
  | "DELETED"
  | "READ"
  | "UNREAD";

export interface CommerceMessageConversation {
  conversationId: string;
  conversationType: CommerceMessageConversationType;
  conversationStatus?: CommerceMessageConversationStatus;
  read?: boolean;
  otherPartyUsername?: string;
  lastMessageDate?: string;
  lastMessageSubject?: string;
  messageCount?: number;
  unreadMessageCount?: number;
  itemId?: string;
}

export interface CommerceMessageGetConversationsArgs {
  conversationType: CommerceMessageConversationType;
  conversationStatus?: CommerceMessageConversationStatus;
  otherPartyUsername?: string;
  limit?: number;
  offset?: number;
}

export interface CommerceMessageUpdateResult {
  success: boolean;
  status: number;
  errorId?: number;
  errorMessage?: string;
  /** True when the failure was "scope/consent missing" so callers can
   *  differentiate between "this integration hasn't been re-authorized yet"
   *  and "the API genuinely rejected the update". */
  needsReauth?: boolean;
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function callCommerceMessage(
  integrationId: string,
  accessToken: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  callLabel = "CommerceMessage",
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const url = `${BASE}${path}`;
  const requestBytes = body ? Buffer.byteLength(JSON.stringify(body)) : 0;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    // Don't fail-fast on non-2xx; callers inspect status.
    void recordNetworkTransferSample({
      channel: "HELPDESK",
      label: `helpdesk_ebay / ${callLabel}`,
      bytesEstimate: requestBytes + Buffer.byteLength(text),
      integrationId,
      metadata: { feature: "helpdesk", callName: callLabel },
    });
    return { status: res.status, body: text };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function extractErrorId(parsed: unknown): {
  errorId?: number;
  errorMessage?: string;
} {
  if (
    parsed &&
    typeof parsed === "object" &&
    "errors" in parsed &&
    Array.isArray((parsed as Record<string, unknown>).errors)
  ) {
    const errs = (parsed as Record<string, unknown>).errors as Array<
      Record<string, unknown>
    >;
    const first = errs[0];
    if (first) {
      return {
        errorId:
          typeof first.errorId === "number"
            ? first.errorId
            : first.errorId != null
              ? Number(first.errorId)
              : undefined,
        errorMessage:
          typeof first.message === "string"
            ? first.message
            : typeof first.longMessage === "string"
              ? first.longMessage
              : undefined,
      };
    }
  }
  return {};
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * List conversations matching the given filter. Returns up to `limit` (max 10
 * per eBay's cap) starting at `offset`. Most Help Desk lookups want a specific
 * buyer's conversation, so `otherPartyUsername` is the primary selector.
 */
export async function getConversations(
  integrationId: string,
  config: EbayConfig,
  args: CommerceMessageGetConversationsArgs,
): Promise<{
  conversations: CommerceMessageConversation[];
  status: number;
  needsReauth: boolean;
}> {
  const accessToken = await getEbayAccessToken(integrationId, config);
  const params = new URLSearchParams();
  params.set("conversation_type", args.conversationType);
  if (args.conversationStatus) {
    params.set("conversation_status", args.conversationStatus);
  }
  if (args.otherPartyUsername) {
    params.set("other_party_username", args.otherPartyUsername);
  }
  if (args.limit != null) params.set("limit", String(args.limit));
  if (args.offset != null) params.set("offset", String(args.offset));
  const { status, body } = await callCommerceMessage(
    integrationId,
    accessToken,
    "GET",
    `/conversation?${params.toString()}`,
    undefined,
    "CommerceMessage_GetConversations",
  );
  const parsed = parseJson(body);

  if (status === 401 || status === 403) {
    // 1100 = insufficient scope / consent not granted for this app.
    const { errorId } = extractErrorId(parsed);
    return {
      conversations: [],
      status,
      needsReauth: errorId === 1100 || status === 401,
    };
  }
  if (status < 200 || status >= 300) {
    return { conversations: [], status, needsReauth: false };
  }

  const container =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  const rawList = Array.isArray(container.conversations)
    ? (container.conversations as Array<Record<string, unknown>>)
    : [];
  const conversations: CommerceMessageConversation[] = rawList.map((c) => ({
    conversationId: String(c.conversationId ?? ""),
    conversationType: (c.conversationType ??
      args.conversationType) as CommerceMessageConversationType,
    conversationStatus: c.conversationStatus as
      | CommerceMessageConversationStatus
      | undefined,
    read: typeof c.read === "boolean" ? (c.read as boolean) : undefined,
    otherPartyUsername:
      typeof c.otherPartyUsername === "string"
        ? c.otherPartyUsername
        : undefined,
    lastMessageDate:
      typeof c.lastMessageDate === "string" ? c.lastMessageDate : undefined,
    lastMessageSubject:
      typeof c.lastMessageSubject === "string"
        ? c.lastMessageSubject
        : undefined,
    messageCount:
      typeof c.messageCount === "number" ? c.messageCount : undefined,
    unreadMessageCount:
      typeof c.unreadMessageCount === "number"
        ? c.unreadMessageCount
        : undefined,
    itemId: typeof c.itemId === "string" ? c.itemId : undefined,
  }));
  return { conversations, status, needsReauth: false };
}

/**
 * Flip the `read` flag on a single conversation. Returns `needsReauth=true`
 * when the integration hasn't been re-authorized yet with the
 * commerce.message scope — callers can then skip this path silently and
 * let the Trading API fallback do what it can.
 */
export async function updateConversationRead(
  integrationId: string,
  config: EbayConfig,
  args: {
    conversationId: string;
    conversationType: CommerceMessageConversationType;
    read: boolean;
  },
): Promise<CommerceMessageUpdateResult> {
  const accessToken = await getEbayAccessToken(integrationId, config);
  const { status, body } = await callCommerceMessage(
    integrationId,
    accessToken,
    "POST",
    `/update_conversation`,
    {
      conversationId: args.conversationId,
      conversationType: args.conversationType,
      read: args.read,
    },
    "CommerceMessage_UpdateConversation",
  );
  if (status === 204) {
    return { success: true, status };
  }
  const parsed = parseJson(body);
  const { errorId, errorMessage } = extractErrorId(parsed);
  return {
    success: false,
    status,
    errorId,
    errorMessage: errorMessage ?? body.slice(0, 400),
    needsReauth: errorId === 1100 || status === 401,
  };
}

/**
 * Bulk variant. eBay caps this at 10 conversations per call — caller chunks.
 */
export async function bulkUpdateConversationRead(
  integrationId: string,
  config: EbayConfig,
  args: {
    conversations: Array<{
      conversationId: string;
      conversationType: CommerceMessageConversationType;
    }>;
    read: boolean;
  },
): Promise<CommerceMessageUpdateResult> {
  if (args.conversations.length === 0) return { success: true, status: 204 };
  const accessToken = await getEbayAccessToken(integrationId, config);
  const { status, body } = await callCommerceMessage(
    integrationId,
    accessToken,
    "POST",
    `/bulk_update_conversation`,
    {
      requests: args.conversations.map((c) => ({
        conversationId: c.conversationId,
        conversationType: c.conversationType,
        read: args.read,
      })),
    },
    "CommerceMessage_BulkUpdateConversation",
  );
  if (status === 204 || status === 200) {
    return { success: true, status };
  }
  const parsed = parseJson(body);
  const { errorId, errorMessage } = extractErrorId(parsed);
  return {
    success: false,
    status,
    errorId,
    errorMessage: errorMessage ?? body.slice(0, 400),
    needsReauth: errorId === 1100 || status === 401,
  };
}

/**
 * Resolve the eBay conversationId for a Help Desk ticket given the buyer's
 * eBay username. Tries FROM_MEMBERS first; returns the best match by
 * most-recent lastMessageDate. If the buyer has multiple conversations
 * (common when they've contacted us about several listings), we return the
 * top match and the full list so callers that have extra context (e.g.
 * the expected itemId or the latest inbound timestamp we have locally) can
 * refine the choice.
 */
export async function resolveConversationIdForBuyer(
  integrationId: string,
  config: EbayConfig,
  buyerUsername: string,
  opts: { itemIdHint?: string; limit?: number } = {},
): Promise<{
  best?: CommerceMessageConversation;
  all: CommerceMessageConversation[];
  status: number;
  needsReauth: boolean;
}> {
  const { conversations, status, needsReauth } = await getConversations(
    integrationId,
    config,
    {
      conversationType: "FROM_MEMBERS",
      otherPartyUsername: buyerUsername,
      limit: opts.limit ?? 10,
    },
  );
  if (conversations.length === 0) {
    return { all: [], status, needsReauth };
  }
  let candidates = conversations;
  if (opts.itemIdHint) {
    const itemMatches = conversations.filter(
      (c) => c.itemId && c.itemId === opts.itemIdHint,
    );
    if (itemMatches.length > 0) candidates = itemMatches;
  }
  // Most recent wins. Null dates sort last.
  const sorted = [...candidates].sort((a, b) => {
    const ta = a.lastMessageDate ? Date.parse(a.lastMessageDate) : 0;
    const tb = b.lastMessageDate ? Date.parse(b.lastMessageDate) : 0;
    return tb - ta;
  });
  return { best: sorted[0], all: conversations, status, needsReauth };
}
