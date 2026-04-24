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
 *     `bulk_update_conversation` on this API actually changes what agents
 *     see in the web inbox — which is the behavior we want for the
 *     Help Desk <-> eBay read-state mirror.
 *
 * Gotchas we learned the hard way (April 2026):
 *   - On high-volume accounts (e.g. TPP with ~170k FROM_MEMBERS
 *     conversations) the unfiltered `GET /conversation?conversation_type=X`
 *     5xxs with `getAllMyConversations … exceeded retries limit`. Always
 *     include either `other_party_username`, `reference_id` +
 *     `reference_type`, or `sort=-last_modified_date` to route the request
 *     past the broken aggregator. `conversation_status=UNREAD` does not
 *     mean "latest message is unread" — it filters on the per-conversation
 *     status (ACTIVE / ARCHIVE / DELETE), not the read flag.
 *   - Any `filter=...` clause is silently ignored on TPP. Query params are
 *     the source of truth.
 *   - Read/unread state is written via `POST /bulk_update_conversation`
 *     with
 *       { conversations: [ { conversationId, conversationType,
 *                            conversationStatus: "READ" | "UNREAD" } ] }
 *     The `read: true/false` shape documented in older integration notes
 *     does not flip the web UI.
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

export interface CommerceMessageLatestMessage {
  messageId?: string;
  messageBody?: string;
  senderUsername?: string;
  recipientUsername?: string;
  readStatus?: boolean;
  createdDate?: string;
}

export interface CommerceMessageConversation {
  conversationId: string;
  conversationType: CommerceMessageConversationType;
  conversationStatus?: CommerceMessageConversationStatus;
  /** `true` when every message in the thread is read on eBay. Derived
   *  from `unreadCount === 0`. */
  read?: boolean;
  /** The non-self username in the thread. The API doesn't return a single
   *  "other party" field — we derive it from latestMessage.senderUsername /
   *  recipientUsername, preferring whichever isn't `selfUsernameHint` when
   *  the caller passes one. Callers that care about which side sent the
   *  last message should read `latestMessage` directly. */
  otherPartyUsername?: string;
  /** ISO timestamp of the most recent activity in the thread. */
  lastMessageDate?: string;
  lastMessageSubject?: string;
  messageCount?: number;
  unreadMessageCount?: number;
  /** The eBay listing ID this conversation is attached to. Populated when
   *  `referenceType === "LISTING"`. */
  itemId?: string;
  /** Raw latest-message block from the API — keep this so callers can
   *  reason about sender direction / body text without re-fetching. */
  latestMessage?: CommerceMessageLatestMessage;
}

export interface CommerceMessageGetConversationsArgs {
  conversationType: CommerceMessageConversationType;
  /** Filter by per-conversation status. NOTE: this is NOT a read/unread
   *  filter — use `onlyUnread` / post-filter `unreadMessageCount` for that. */
  conversationStatus?: CommerceMessageConversationStatus;
  otherPartyUsername?: string;
  /** eBay listing ID. When set, `referenceType` is forced to LISTING. */
  referenceId?: string;
  /** Sort string, e.g. `-last_modified_date` (newest first). Required on
   *  high-volume accounts when no other narrowing param is supplied,
   *  otherwise eBay 5xxs with `getAllMyConversations: exceeded retries`. */
  sort?: string;
  limit?: number;
  offset?: number;
  /** When set, used to derive `otherPartyUsername` on each row: whichever
   *  of `latestMessage.senderUsername` / `recipientUsername` isn't this
   *  value wins. Falls back to `senderUsername` when no hint is given. */
  selfUsernameHint?: string;
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

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function parseLatestMessage(raw: unknown): CommerceMessageLatestMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    messageId: str(r.messageId),
    messageBody: str(r.messageBody),
    senderUsername: str(r.senderUsername),
    recipientUsername: str(r.recipientUsername),
    readStatus: bool(r.readStatus),
    createdDate: str(r.createdDate),
  };
}

function deriveOtherParty(
  latest: CommerceMessageLatestMessage | undefined,
  selfHint?: string,
): string | undefined {
  if (!latest) return undefined;
  const s = latest.senderUsername;
  const r = latest.recipientUsername;
  if (selfHint) {
    if (s && s !== selfHint) return s;
    if (r && r !== selfHint) return r;
  }
  return s ?? r;
}

function parseConversation(
  raw: Record<string, unknown>,
  fallbackType: CommerceMessageConversationType,
  selfHint?: string,
): CommerceMessageConversation {
  const latest = parseLatestMessage(raw.latestMessage);
  const referenceType = str(raw.referenceType);
  const referenceId = str(raw.referenceId);
  const unreadCount = num(raw.unreadCount);
  return {
    conversationId: String(raw.conversationId ?? ""),
    conversationType: (raw.conversationType ??
      fallbackType) as CommerceMessageConversationType,
    conversationStatus: raw.conversationStatus as
      | CommerceMessageConversationStatus
      | undefined,
    read: typeof unreadCount === "number" ? unreadCount === 0 : undefined,
    otherPartyUsername:
      str(raw.otherPartyUsername) ?? deriveOtherParty(latest, selfHint),
    lastMessageDate: latest?.createdDate ?? str(raw.lastMessageDate),
    lastMessageSubject: str(raw.lastMessageSubject),
    messageCount: num(raw.messageCount),
    unreadMessageCount: unreadCount,
    itemId: referenceType === "LISTING" ? referenceId : str(raw.itemId),
    latestMessage: latest,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * List conversations matching the given filter. Uses TOP-LEVEL query
 * params (not `filter=`) because eBay silently ignores the filter clause
 * on large accounts. At least one of `otherPartyUsername`, `referenceId`,
 * or `sort` should be supplied or the unfiltered aggregate path will 5xx.
 */
export async function getConversations(
  integrationId: string,
  config: EbayConfig,
  args: CommerceMessageGetConversationsArgs,
): Promise<{
  conversations: CommerceMessageConversation[];
  total?: number;
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
  if (args.referenceId) {
    params.set("reference_id", args.referenceId);
    params.set("reference_type", "LISTING");
  }
  if (args.sort) params.set("sort", args.sort);
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
  const conversations = rawList.map((c) =>
    parseConversation(c, args.conversationType, args.selfUsernameHint),
  );
  const total = num(container.total);
  return { conversations, total, status, needsReauth: false };
}

/**
 * Flip the read/unread flag on a single conversation via
 * `POST /bulk_update_conversation` with a one-element array.
 *
 * We use the bulk endpoint even for singles because the non-bulk
 * `/update_conversation` shape has been inconsistent across eBay's
 * environments and the bulk path is what we verified end-to-end against
 * the live web UI.
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
  return bulkUpdateConversationRead(integrationId, config, {
    conversations: [
      {
        conversationId: args.conversationId,
        conversationType: args.conversationType,
      },
    ],
    read: args.read,
  });
}

/**
 * Flip read/unread on up to 10 conversations per call (eBay's cap —
 * callers must chunk). Uses the verified-working payload shape:
 *   {
 *     conversations: [
 *       { conversationId, conversationType, conversationStatus: "READ" | "UNREAD" }
 *     ]
 *   }
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
  const payload = {
    conversations: args.conversations.map((c) => ({
      conversationId: c.conversationId,
      conversationType: c.conversationType,
      conversationStatus: args.read ? "READ" : "UNREAD",
    })),
  };
  const { status, body } = await callCommerceMessage(
    integrationId,
    accessToken,
    "POST",
    `/bulk_update_conversation`,
    payload,
    "CommerceMessage_BulkUpdateConversation",
  );
  if (status === 200 || status === 204) {
    // Even with HTTP 200 eBay can report per-row failures in the response
    // body. Treat any `updateFailureCount > 0` as a partial failure.
    const parsed = parseJson(body);
    if (
      parsed &&
      typeof parsed === "object" &&
      "conversationsMetadata" in parsed
    ) {
      const meta = (parsed as Record<string, unknown>)
        .conversationsMetadata as Record<string, unknown> | undefined;
      const failures = num(meta?.updateFailureCount);
      if (failures && failures > 0) {
        return {
          success: false,
          status,
          errorMessage: `bulk_update_conversation reported ${failures} per-row failure(s): ${body.slice(0, 300)}`,
        };
      }
    }
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

// ─── Messages within a conversation ──────────────────────────────────────────

export interface CommerceMessage {
  messageId: string;
  conversationId?: string;
  senderUsername?: string;
  recipientUsername?: string;
  /** `true` when the message has been marked read on eBay. The web UI
   *  sets this to `true` when an agent opens the thread. */
  readStatus?: boolean;
  /** "INBOUND" (from other party) / "OUTBOUND" (from self) as reported by
   *  eBay when available. We never rely on it — always re-derive direction
   *  locally via selfUsernameHint vs senderUsername because the field is
   *  sometimes missing entirely. */
  messageDirection?: string;
  /** ISO 8601 — the moment the message was sent on eBay. */
  createdDate?: string;
  messageBody?: string;
  /** `true` when `messageBody` is already HTML (typical for web-UI
   *  replies). Otherwise treat as plain text. */
  isHtml?: boolean;
}

function parseMessage(raw: Record<string, unknown>): CommerceMessage {
  const body = str(raw.messageBody) ?? str(raw.body);
  return {
    messageId: String(raw.messageId ?? raw.id ?? ""),
    conversationId: str(raw.conversationId),
    senderUsername: str(raw.senderUsername),
    recipientUsername: str(raw.recipientUsername),
    readStatus: bool(raw.readStatus),
    messageDirection: str(raw.messageDirection),
    createdDate: str(raw.createdDate),
    messageBody: body,
    // eBay's Commerce Message API returns web-UI replies as pre-rendered
    // HTML in `messageBody`. The response doesn't include an explicit
    // content-type flag, so we sniff the body. Detection is cheap and
    // conservative: any '<' + tag-like char wins.
    isHtml: typeof body === "string" && /<[a-z!/]/i.test(body),
  };
}

/**
 * List messages inside a single conversation. Results are sorted newest-
 * first by default. Pass `since` (ISO 8601) to get a bounded tail via the
 * `modified_after` filter — this is what the inbound-sweep ingest uses so
 * we only pay for whatever arrived since the last tick.
 *
 * URL shape (validated against production, April 2026):
 *
 *   GET /conversation/{conversationId}?conversation_type=FROM_MEMBERS
 *         [&modified_after=...&limit=...&offset=...]
 *
 * The dedicated `/conversation/{id}/message` endpoint documented in some
 * older eBay guides returns 404 on this production tenant. The working
 * shape is the single-conversation GET with `conversation_type` as a
 * required query parameter and `fieldgroups=MESSAGE_DETAILS` being
 * equivalent to omitting fieldgroups (eBay inlines `messages[]` either
 * way). Response wrapper:
 *
 *   { total, limit, offset, conversationStatus, conversationType,
 *     conversationTitle, messages: [ { messageId, messageBody, ... } ] }
 *
 * We still parse `messageSummaries[]` as a fallback for forward
 * compatibility.
 */
export async function getConversationMessages(
  integrationId: string,
  config: EbayConfig,
  args: {
    conversationId: string;
    /** eBay requires `conversation_type` on the single-conversation GET.
     *  Defaults to FROM_MEMBERS since that's the only type the inbound
     *  sweep ever ingests (agent↔buyer threads). Pass FROM_EBAY if ever
     *  needed for system-notification ingestion. */
    conversationType?: CommerceMessageConversationType;
    /** ISO 8601. When set, passes `modified_after={since}` so we only
     *  receive what changed since the last sync. */
    since?: string;
    /** Cap per call. eBay's default is 25 for this endpoint. */
    limit?: number;
    offset?: number;
  },
): Promise<{
  messages: CommerceMessage[];
  status: number;
  needsReauth: boolean;
}> {
  const accessToken = await getEbayAccessToken(integrationId, config);
  const params = new URLSearchParams();
  params.set("conversation_type", args.conversationType ?? "FROM_MEMBERS");
  if (args.since) params.set("modified_after", args.since);
  if (args.limit != null) params.set("limit", String(args.limit));
  if (args.offset != null) params.set("offset", String(args.offset));
  const { status, body } = await callCommerceMessage(
    integrationId,
    accessToken,
    "GET",
    `/conversation/${encodeURIComponent(args.conversationId)}?${params.toString()}`,
    undefined,
    "CommerceMessage_GetConversationMessages",
  );
  const parsed = parseJson(body);
  if (status === 401 || status === 403) {
    const { errorId } = extractErrorId(parsed);
    return {
      messages: [],
      status,
      needsReauth: errorId === 1100 || status === 401,
    };
  }
  if (status < 200 || status >= 300) {
    return { messages: [], status, needsReauth: false };
  }
  const container =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  // eBay returns either `messages` (modern shape) or `messageSummaries`
  // (seen on some older replicas). Accept both.
  const rawList = Array.isArray(container.messages)
    ? (container.messages as Array<Record<string, unknown>>)
    : Array.isArray(container.messageSummaries)
      ? (container.messageSummaries as Array<Record<string, unknown>>)
      : [];
  const messages = rawList
    .map(parseMessage)
    // Per-message payloads on this endpoint omit `conversationId`, so
    // stamp it back from the request so downstream consumers
    // (ingestCommerceMessage) don't lose the thread identity.
    .map((m) => ({
      ...m,
      conversationId: m.conversationId ?? args.conversationId,
    }))
    .filter((m) => m.messageId.length > 0);
  return { messages, status, needsReauth: false };
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
  opts: { itemIdHint?: string; limit?: number; selfUsernameHint?: string } = {},
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
      selfUsernameHint: opts.selfUsernameHint,
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
  const sorted = [...candidates].sort((a, b) => {
    const ta = a.lastMessageDate ? Date.parse(a.lastMessageDate) : 0;
    const tb = b.lastMessageDate ? Date.parse(b.lastMessageDate) : 0;
    return tb - ta;
  });
  return { best: sorted[0], all: conversations, status, needsReauth };
}
