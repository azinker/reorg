/**
 * eBay Trading API client for the Help Desk feature.
 *
 * Read methods (used in Phase 1 sync):
 *   - getMyMessagesSummary  → cheap probe; returns counts + new flag
 *   - getMyMessagesHeaders  → list of headers (no body) for a date window
 *   - getMyMessagesBodies   → fetches full bodies for specified message IDs
 *
 * Write methods (Phase 2; gated by helpdeskFlags):
 *   - reviseMyMessages      → mark read/unread, flag, archive
 *   - sendHelpdeskReply     → AddMemberMessageRTQ (reply to existing thread)
 *
 * Token refresh and OAuth handling reuses the existing eBay credentials stored
 * on the Integration model (no new OAuth flow needed; messaging scope is part
 * of the existing token).
 */

import { Buffer } from "node:buffer";
import { db } from "@/lib/db";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const REQUEST_TIMEOUT_MS = 30_000;

interface EbayConfig {
  appId: string;
  certId: string;
  devId: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  environment?: string;
}

export function buildEbayConfig(integration: { config: unknown }): EbayConfig {
  const raw = (integration.config ?? {}) as Record<string, unknown>;
  const envPrefix =
    raw.environment === "PRODUCTION" || !raw.environment ? "" : "SANDBOX_";
  return {
    appId: (raw.appId as string) || "",
    certId: (raw.certId as string) || "",
    devId: (raw.devId as string) || "",
    refreshToken: (raw.refreshToken as string) || "",
    accessToken:
      (raw[`${envPrefix}accessToken`] as string) ?? (raw.accessToken as string) ?? undefined,
    accessTokenExpiresAt: (raw.accessTokenExpiresAt as number) ?? undefined,
    environment: (raw.environment as string) ?? "PRODUCTION",
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { method?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function getEbayAccessToken(
  integrationId: string,
  config: EbayConfig,
): Promise<string> {
  if (
    config.accessToken &&
    config.accessTokenExpiresAt &&
    config.accessTokenExpiresAt > Date.now() + 60_000
  ) {
    return config.accessToken;
  }

  const credentials = Buffer.from(`${config.appId}:${config.certId}`).toString("base64");
  const res = await fetchWithTimeout("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
    }).toString(),
  });

  if (!res.ok) throw new Error(`eBay token refresh failed: ${res.status}`);

  const data = JSON.parse(res.body) as Record<string, unknown>;
  const accessToken = data.access_token as string;
  const expiresIn = (data.expires_in as number | undefined) ?? 7200;
  const expiresAt = Date.now() + expiresIn * 1000;

  const current = await db.integration.findUnique({
    where: { id: integrationId },
    select: { config: true },
  });
  const fullConfig =
    current?.config && typeof current.config === "object" && !Array.isArray(current.config)
      ? (current.config as Record<string, unknown>)
      : {};
  await db.integration.update({
    where: { id: integrationId },
    data: { config: { ...fullConfig, accessToken, accessTokenExpiresAt: expiresAt } as object },
  });

  config.accessToken = accessToken;
  config.accessTokenExpiresAt = expiresAt;
  return accessToken;
}

function parseXmlSimple(xml: string): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { XMLParser } = require("fast-xml-parser");
    const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
    return parser.parse(xml) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function recordCall(args: {
  integrationId: string;
  callName: string;
  requestBytes: number;
  responseBytes: number;
}): void {
  void recordNetworkTransferSample({
    channel: "MARKETPLACE_INBOUND",
    label: `helpdesk_ebay / ${args.callName}`,
    bytesEstimate: args.requestBytes + args.responseBytes,
    integrationId: args.integrationId,
    metadata: { feature: "helpdesk", callName: args.callName },
  });
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EbayMessageSummary {
  newMessageCount: number;
  totalMessageCount: number;
  lastModifiedTime?: string;
}

export interface EbayMessageHeader {
  messageID: string;
  externalMessageID?: string;
  itemID?: string;
  sender?: string;
  recipientUserID?: string;
  subject?: string;
  receiveDate?: string;
  read?: boolean;
  flagged?: boolean;
  responseDetails?: { responseEnabled?: boolean; userResponseDate?: string };
  questionType?: string;
  // Optional thread linkage hint provided by eBay
  parentMessageID?: string;
}

export interface EbayMessageBody extends EbayMessageHeader {
  text?: string;
  contentType?: string;
  /**
   * Buyer-attached media URLs surfaced through eBay's messaging schema. Outbound
   * sending of media is gated by HELPDESK_ENABLE_ATTACHMENTS in Phase 6.
   */
  mediaUrls?: string[];
}

// ─── Read methods ────────────────────────────────────────────────────────────

/**
 * Cheap probe call: returns total/new message counts only. Use this every poll
 * to decide whether a more expensive header pull is justified.
 */
export async function getMyMessagesSummary(
  integrationId: string,
  config: EbayConfig,
  folderID: number = 0,
): Promise<EbayMessageSummary> {
  const accessToken = await getEbayAccessToken(integrationId, config);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetMyMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnSummary</DetailLevel>
  <FolderID>${folderID}</FolderID>
</GetMyMessagesRequest>`;

  const res = await fetchWithTimeout(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": accessToken,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-CALL-NAME": "GetMyMessages",
      "Content-Type": "text/xml",
    },
    body,
  });

  recordCall({
    integrationId,
    callName: "GetMyMessages_Summary",
    requestBytes: Buffer.byteLength(body),
    responseBytes: Buffer.byteLength(res.body),
  });

  if (!res.ok) {
    throw new Error(`GetMyMessages summary failed: HTTP ${res.status}`);
  }

  const parsed = parseXmlSimple(res.body);
  const root = parsed.GetMyMessagesResponse as Record<string, unknown> | undefined;
  const summary = root?.Summary as Record<string, unknown> | undefined;
  return {
    newMessageCount: Number(summary?.NewMessageCount ?? 0),
    totalMessageCount: Number(summary?.TotalMessageCount ?? 0),
    lastModifiedTime: summary?.LastModifiedTime ? String(summary.LastModifiedTime) : undefined,
  };
}

/**
 * Returns headers (no body) for the given date window. eBay caps StartTime
 * spans at 7 days and a single response at 200 messages, so callers should
 * page across windows for the 180-day backfill.
 */
export async function getMyMessagesHeaders(
  integrationId: string,
  config: EbayConfig,
  args: { startTime: Date; endTime: Date; folderID?: number },
): Promise<EbayMessageHeader[]> {
  const accessToken = await getEbayAccessToken(integrationId, config);
  const folder = args.folderID ?? 0;
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetMyMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnHeaders</DetailLevel>
  <FolderID>${folder}</FolderID>
  <StartTime>${args.startTime.toISOString()}</StartTime>
  <EndTime>${args.endTime.toISOString()}</EndTime>
</GetMyMessagesRequest>`;

  const res = await fetchWithTimeout(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": accessToken,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-CALL-NAME": "GetMyMessages",
      "Content-Type": "text/xml",
    },
    body,
  });

  recordCall({
    integrationId,
    callName: "GetMyMessages_Headers",
    requestBytes: Buffer.byteLength(body),
    responseBytes: Buffer.byteLength(res.body),
  });

  if (!res.ok) {
    throw new Error(`GetMyMessages headers failed: HTTP ${res.status}`);
  }

  const parsed = parseXmlSimple(res.body);
  const root = parsed.GetMyMessagesResponse as Record<string, unknown> | undefined;
  const messagesContainer = root?.Messages as Record<string, unknown> | undefined;
  const rawMessages = asArray(messagesContainer?.Message as unknown);

  return rawMessages.map((m) => mapHeader(m as Record<string, unknown>));
}

/**
 * Fetches full bodies for the given message IDs. eBay supports up to 10 IDs
 * per request — the caller should chunk.
 */
export async function getMyMessagesBodies(
  integrationId: string,
  config: EbayConfig,
  messageIDs: string[],
): Promise<EbayMessageBody[]> {
  if (messageIDs.length === 0) return [];
  const accessToken = await getEbayAccessToken(integrationId, config);
  const ids = messageIDs.slice(0, 10);
  const idElements = ids
    .map((id) => `    <MessageID>${escapeXml(id)}</MessageID>`)
    .join("\n");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetMyMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnMessages</DetailLevel>
  <MessageIDs>
${idElements}
  </MessageIDs>
</GetMyMessagesRequest>`;

  const res = await fetchWithTimeout(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": accessToken,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-CALL-NAME": "GetMyMessages",
      "Content-Type": "text/xml",
    },
    body,
  });

  recordCall({
    integrationId,
    callName: "GetMyMessages_Bodies",
    requestBytes: Buffer.byteLength(body),
    responseBytes: Buffer.byteLength(res.body),
  });

  if (!res.ok) {
    throw new Error(`GetMyMessages bodies failed: HTTP ${res.status}`);
  }

  const parsed = parseXmlSimple(res.body);
  const root = parsed.GetMyMessagesResponse as Record<string, unknown> | undefined;
  const messagesContainer = root?.Messages as Record<string, unknown> | undefined;
  const rawMessages = asArray(messagesContainer?.Message as unknown);

  return rawMessages.map((m) => {
    const obj = m as Record<string, unknown>;
    const header = mapHeader(obj);
    const text = obj.Text != null ? String(obj.Text) : undefined;
    const contentType = obj.ContentType != null ? String(obj.ContentType) : undefined;
    const mediaUrls: string[] = [];
    const media = obj.MediaList as Record<string, unknown> | undefined;
    const mediaItems = asArray(media?.Media);
    for (const item of mediaItems) {
      const itemObj = item as Record<string, unknown>;
      const url = itemObj.MediaURL ?? itemObj.URL ?? itemObj.Url;
      if (url) mediaUrls.push(String(url));
    }
    return { ...header, text, contentType, mediaUrls };
  });
}

function mapHeader(obj: Record<string, unknown>): EbayMessageHeader {
  const responseDetailsRaw = obj.ResponseDetails as Record<string, unknown> | undefined;
  return {
    messageID: String(obj.MessageID ?? ""),
    externalMessageID:
      obj.ExternalMessageID != null ? String(obj.ExternalMessageID) : undefined,
    itemID: obj.ItemID != null ? String(obj.ItemID) : undefined,
    sender: obj.Sender != null ? String(obj.Sender) : undefined,
    recipientUserID:
      obj.RecipientUserID != null ? String(obj.RecipientUserID) : undefined,
    subject: obj.Subject != null ? String(obj.Subject) : undefined,
    receiveDate: obj.ReceiveDate != null ? String(obj.ReceiveDate) : undefined,
    read: obj.Read != null ? String(obj.Read) === "true" : undefined,
    flagged: obj.Flagged != null ? String(obj.Flagged) === "true" : undefined,
    responseDetails: responseDetailsRaw
      ? {
          responseEnabled:
            responseDetailsRaw.ResponseEnabled != null
              ? String(responseDetailsRaw.ResponseEnabled) === "true"
              : undefined,
          userResponseDate:
            responseDetailsRaw.UserResponseDate != null
              ? String(responseDetailsRaw.UserResponseDate)
              : undefined,
        }
      : undefined,
    questionType: obj.QuestionType != null ? String(obj.QuestionType) : undefined,
    parentMessageID:
      obj.ParentMessageID != null ? String(obj.ParentMessageID) : undefined,
  };
}

// ─── Write methods (used by Phase 2 outbound worker) ─────────────────────────

export interface SendHelpdeskReplyArgs {
  itemID: string;
  recipientID: string;
  subject: string;
  body: string;
  /**
   * If provided, the reply is sent as a buyer-thread response (RTQ). If not,
   * the call falls back to AAQToPartner for new agent-initiated messages on
   * the same item. We always REPLY in v1 — never initiate cold messages.
   */
  parentMessageID?: string;
  questionType?: string;
}

export interface SendHelpdeskReplyResult {
  success: boolean;
  externalId?: string;
  error?: string;
  ack?: string;
  raw?: string;
}

export async function sendHelpdeskReply(
  integrationId: string,
  config: EbayConfig,
  args: SendHelpdeskReplyArgs,
): Promise<SendHelpdeskReplyResult> {
  const accessToken = await getEbayAccessToken(integrationId, config);
  const useRTQ = !!args.parentMessageID;
  const callName = useRTQ ? "AddMemberMessageRTQ" : "AddMemberMessageAAQToPartner";

  const body = useRTQ
    ? `<?xml version="1.0" encoding="utf-8"?>
<AddMemberMessageRTQRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${escapeXml(args.itemID)}</ItemID>
  <MemberMessage>
    <Body>${escapeXml(args.body)}</Body>
    <ParentMessageID>${escapeXml(args.parentMessageID ?? "")}</ParentMessageID>
    <RecipientID>${escapeXml(args.recipientID)}</RecipientID>
  </MemberMessage>
</AddMemberMessageRTQRequest>`
    : `<?xml version="1.0" encoding="utf-8"?>
<AddMemberMessageAAQToPartnerRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${escapeXml(args.itemID)}</ItemID>
  <MemberMessage>
    <Subject>${escapeXml(args.subject)}</Subject>
    <Body>${escapeXml(args.body)}</Body>
    <QuestionType>${escapeXml(args.questionType ?? "General")}</QuestionType>
    <RecipientID>${escapeXml(args.recipientID)}</RecipientID>
  </MemberMessage>
</AddMemberMessageAAQToPartnerRequest>`;

  const res = await fetchWithTimeout(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": accessToken,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-CALL-NAME": callName,
      "Content-Type": "text/xml",
    },
    body,
  });

  recordCall({
    integrationId,
    callName,
    requestBytes: Buffer.byteLength(body),
    responseBytes: Buffer.byteLength(res.body),
  });

  if (!res.ok) {
    return { success: false, error: `HTTP ${res.status}`, raw: res.body };
  }

  const parsed = parseXmlSimple(res.body);
  const root =
    (parsed.AddMemberMessageRTQResponse as Record<string, unknown> | undefined) ??
    (parsed.AddMemberMessageAAQToPartnerResponse as Record<string, unknown> | undefined);
  const ack = String(root?.Ack ?? "").trim();

  if (ack === "Success" || ack === "Warning") {
    return { success: true, ack, raw: res.body };
  }

  const errors = root?.Errors;
  const errorList = asArray(errors as Record<string, unknown> | undefined).filter(
    (e): e is Record<string, unknown> => e != null,
  );
  const errorMessages = errorList
    .map((e) => String(e.LongMessage ?? e.ShortMessage ?? "Unknown error"))
    .join("; ");

  return { success: false, ack, error: errorMessages || `Ack: ${ack}`, raw: res.body };
}

/**
 * Mark a message read/unread, archived, or flagged. Used to keep eBay's UI in
 * sync when a user takes action inside reorG.
 */
export async function reviseMyMessages(
  integrationId: string,
  config: EbayConfig,
  args: {
    messageIDs: string[];
    read?: boolean;
    flagged?: boolean;
    folderID?: number;
  },
): Promise<{ success: boolean; ack?: string; error?: string }> {
  if (args.messageIDs.length === 0) return { success: true };
  const accessToken = await getEbayAccessToken(integrationId, config);
  const ids = args.messageIDs
    .slice(0, 10)
    .map((id) => `    <MessageID>${escapeXml(id)}</MessageID>`)
    .join("\n");
  const flags: string[] = [];
  if (args.read != null) flags.push(`  <Read>${args.read}</Read>`);
  if (args.flagged != null) flags.push(`  <Flagged>${args.flagged}</Flagged>`);
  if (args.folderID != null) flags.push(`  <FolderID>${args.folderID}</FolderID>`);

  const body = `<?xml version="1.0" encoding="utf-8"?>
<ReviseMyMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <MessageIDs>
${ids}
  </MessageIDs>
${flags.join("\n")}
</ReviseMyMessagesRequest>`;

  const res = await fetchWithTimeout(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": accessToken,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-CALL-NAME": "ReviseMyMessages",
      "Content-Type": "text/xml",
    },
    body,
  });

  recordCall({
    integrationId,
    callName: "ReviseMyMessages",
    requestBytes: Buffer.byteLength(body),
    responseBytes: Buffer.byteLength(res.body),
  });

  if (!res.ok) return { success: false, error: `HTTP ${res.status}` };

  const parsed = parseXmlSimple(res.body);
  const root = parsed.ReviseMyMessagesResponse as Record<string, unknown> | undefined;
  const ack = String(root?.Ack ?? "").trim();
  if (ack === "Success" || ack === "Warning") return { success: true, ack };

  const errors = root?.Errors;
  const errorList = asArray(errors as Record<string, unknown> | undefined).filter(
    (e): e is Record<string, unknown> => e != null,
  );
  const errorMessages = errorList
    .map((e) => String(e.LongMessage ?? e.ShortMessage ?? "Unknown error"))
    .join("; ");

  return { success: false, ack, error: errorMessages || `Ack: ${ack}` };
}
