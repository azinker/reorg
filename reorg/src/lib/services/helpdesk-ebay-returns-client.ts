/**
 * eBay Post-Order v2 Returns transport client.
 *
 * This module is a THIN, TYPED transport over the eBay Post-Order Returns API.
 * It does two jobs and nothing else:
 *
 *   1. READ wrappers  — search returns, get a single return's detail, get its
 *      tracking, and get its files. Used by the pull-only sync worker and the
 *      detail-page "refresh from eBay" path.
 *
 *   2. WRITE wrappers — decide (approve / offer partial refund), issue_refund,
 *      mark_as_received, and add_shipping_label / file upload. These are the
 *      ONLY functions in the app that POST to eBay for returns.
 *
 * What this module deliberately does NOT do:
 *   - It does NOT enforce the write lock / safe-mode / admin gate. That is the
 *     job of the safety gate (`helpdesk-returns-safety.ts`) which every write
 *     route must call BEFORE invoking a write wrapper here. Keeping the policy
 *     out of the transport means the gate can be unit-tested in isolation and
 *     there's exactly one chokepoint to audit.
 *   - It does NOT write to the database or AuditLog. The calling service layer
 *     owns persistence + audit so it can record the userId and idempotency key.
 *   - It NEVER deletes anything (no eBay delete endpoint is referenced).
 *
 * Auth: Post-Order v2 requires the `IAF <token>` scheme (NOT `Bearer`). Sending
 * Bearer returns "401 Bad scheme: Bearer". Mirrors helpdesk-ebay-actions.ts.
 *
 * Environment: every WRITE endpoint here is PRODUCTION-ONLY (eBay does not
 * support these in Sandbox). That is exactly why the safety gate + dry-run +
 * typed confirmation in the route layer are mandatory.
 */

import {
  buildEbayConfig,
  getEbayAccessToken,
} from "@/lib/services/helpdesk-ebay";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";

const REST_BASE = "https://api.ebay.com";
const REQUEST_TIMEOUT_MS = 30_000;
const READ_PAGE_SIZE = 50;

type EbayConfig = Awaited<ReturnType<typeof buildEbayConfig>>;

/** Normalized result of any eBay Post-Order call. */
export interface EbayReturnsCallResult<T = unknown> {
  ok: boolean;
  status: number;
  /** eBay's request/correlation id, captured from response headers when present. */
  requestId: string | null;
  /** Parsed JSON body (best effort). Null when the body wasn't JSON / was empty. */
  body: T | null;
  /** Raw response text (truncated for storage); used for the Admin debug panel. */
  rawText: string;
  /** Normalized, human-readable error message when !ok. */
  errorMessage: string | null;
  /** Parsed eBay error array when present (errorMessage[].message etc). */
  errors: EbayApiError[];
}

export interface EbayApiError {
  errorId?: number | string;
  domain?: string;
  category?: string;
  message?: string;
  parameters?: Array<{ name?: string; value?: string }>;
}

const REQUEST_ID_HEADERS = [
  "x-ebay-c-request-id",
  "x-ebay-request-id",
  "rlogid",
  "x-ebay-c-correlation-id",
];

function extractRequestId(headers: Headers): string | null {
  for (const name of REQUEST_ID_HEADERS) {
    const v = headers.get(name);
    if (v) return v;
  }
  return null;
}

function recordCall(integrationId: string, callName: string, bytes: number): void {
  void recordNetworkTransferSample({
    channel: "HELPDESK",
    label: `helpdesk_returns / ${callName}`,
    bytesEstimate: bytes,
    integrationId,
    metadata: { feature: "helpdesk_returns", callName },
  });
}

function parseEbayErrors(body: unknown): EbayApiError[] {
  if (!body || typeof body !== "object") return [];
  const obj = body as Record<string, unknown>;
  const raw =
    (obj.errors as unknown) ??
    (obj.errorMessage as unknown) ??
    (obj.warnings as unknown);
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((e) => {
      if (!e || typeof e !== "object") return null;
      const r = e as Record<string, unknown>;
      // Some post-order errors nest under { error: [...] } or { message: [...] }.
      if (Array.isArray(r.error)) {
        return (r.error as unknown[])
          .map((x) => (x && typeof x === "object" ? (x as EbayApiError) : null))
          .filter(Boolean) as EbayApiError[];
      }
      return {
        errorId: r.errorId as number | string | undefined,
        domain: r.domain as string | undefined,
        category: r.category as string | undefined,
        message:
          (r.message as string | undefined) ??
          (r.longMessage as string | undefined),
        parameters: r.parameters as EbayApiError["parameters"],
      } satisfies EbayApiError;
    })
    .flat()
    .filter((e): e is EbayApiError => !!e);
}

function normalizeErrorMessage(status: number, errors: EbayApiError[], rawText: string): string {
  if (errors.length > 0) {
    const first = errors.find((e) => e.message)?.message;
    if (first) return `eBay ${status}: ${first}`;
  }
  const snippet = rawText.slice(0, 200).replace(/\s+/g, " ").trim();
  return `eBay ${status}${snippet ? `: ${snippet}` : ""}`;
}

/**
 * Core request runner. Adds IAF auth, timeout, request-id capture, network
 * sampling, and error normalization. Never throws on a non-2xx response —
 * callers branch on `result.ok` so a failed live write becomes an auditable
 * FAILED attempt rather than an unhandled exception.
 */
async function postOrderRequest<T = unknown>(args: {
  integrationId: string;
  config: EbayConfig;
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  jsonBody?: unknown;
  callName: string;
}): Promise<EbayReturnsCallResult<T>> {
  const accessToken = await getEbayAccessToken(args.integrationId, args.config);
  const qs = args.query ? `?${new URLSearchParams(args.query).toString()}` : "";
  const url = `${REST_BASE}${args.path}${qs}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: args.method,
      headers: {
        Authorization: `IAF ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Language": "en-US",
      },
      body: args.jsonBody != null ? JSON.stringify(args.jsonBody) : undefined,
      signal: controller.signal,
    });
    const rawText = await response.text();
    recordCall(args.integrationId, args.callName, rawText.length);

    let body: T | null = null;
    if (rawText) {
      try {
        body = JSON.parse(rawText) as T;
      } catch {
        body = null;
      }
    }
    const errors = parseEbayErrors(body);
    const ok = response.ok && errors.length === 0;
    const requestId = extractRequestId(response.headers);
    return {
      ok,
      status: response.status,
      requestId,
      body,
      rawText: rawText.slice(0, 20_000),
      errorMessage: ok ? null : normalizeErrorMessage(response.status, errors, rawText),
      errors,
    };
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `eBay request timed out after ${REQUEST_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      ok: false,
      status: 0,
      requestId: null,
      body: null,
      rawText: "",
      errorMessage: message,
      errors: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── READ wrappers ───────────────────────────────────────────────────────────

export interface SearchReturnsArgs {
  integrationId: string;
  config: EbayConfig;
  fromDate: Date;
  toDate?: Date;
  /**
   * Optional ReturnCountFilterEnum bucket (ALL_OPEN, RETURN_STARTED,
   * ITEM_SHIPPED, ITEM_DELIVERED, SELLER_ACTION_DUE, CLOSED, …). When set,
   * eBay returns only returns currently in that bucket — this is exactly how
   * Seller Hub's "Manage returns" status dropdown is driven, so we sync per
   * bucket to make our list filters match eBay 1:1.
   */
  returnState?: string;
  offset?: number;
  limit?: number;
}

export interface SearchReturnsResult {
  members: unknown[];
  total: number;
  totalPages: number;
  result: EbayReturnsCallResult<{ members?: unknown[]; total?: number }>;
}

/**
 * GET /post-order/v2/return/search — seller's returns in a creation-date window.
 * Read-only; used by the pull-only sync worker.
 */
export async function searchReturns(args: SearchReturnsArgs): Promise<SearchReturnsResult> {
  const limit = args.limit ?? READ_PAGE_SIZE;
  // NOTE: the documented filter is `creation_date_range_from/to` (return
  // creation date). The older `item_creation_date_range_*` names are NOT
  // recognized by eBay and were silently ignored, which dropped returns from
  // the sync. Sort newest-first so the first pages always carry the most
  // recent (and most likely actionable) returns.
  const query: Record<string, string> = {
    creation_date_range_from: args.fromDate.toISOString(),
    creation_date_range_to: (args.toDate ?? new Date()).toISOString(),
    sort: "-FILING_DATE",
    limit: String(limit),
    offset: String(args.offset ?? 0),
  };
  if (args.returnState) query.return_state = args.returnState;
  const result = await postOrderRequest<{ members?: unknown[]; total?: number }>({
    integrationId: args.integrationId,
    config: args.config,
    method: "GET",
    path: "/post-order/v2/return/search",
    query,
    callName: "return/search",
  });
  if (!result.ok || !result.body) {
    // 204/404 → empty window, not an error worth surfacing.
    return { members: [], total: 0, totalPages: 0, result };
  }
  const members = result.body.members ?? [];
  const total = result.body.total ?? members.length;
  return { members, total, totalPages: Math.ceil(total / limit), result };
}

/**
 * GET /post-order/v2/return/{returnId} — single return. Read-only.
 *
 * `fieldgroups` controls which containers come back:
 *   - FULL (default)  → the `detail` container only (item title/pic, refundInfo).
 *   - SUMMARY         → the `summary` container only — this is the ONLY place
 *                       sellerAvailableOptions / sellerResponseDue / state live.
 * We default to SUMMARY for the action + availability path because the detail
 * page and the pre-write safety gate need the seller's available options. The
 * sync's title/image enrichment passes FULL to read itemDetail.
 */
export async function getReturnDetail(args: {
  integrationId: string;
  config: EbayConfig;
  returnId: string;
  fieldgroups?: "FULL" | "SUMMARY";
}): Promise<EbayReturnsCallResult> {
  return postOrderRequest({
    integrationId: args.integrationId,
    config: args.config,
    method: "GET",
    path: `/post-order/v2/return/${encodeURIComponent(args.returnId)}`,
    query: { fieldgroups: args.fieldgroups ?? "SUMMARY" },
    callName: "return/get",
  });
}

/** GET /post-order/v2/return/{returnId}/get_shipment_tracking — tracking scans. */
export async function getReturnTracking(args: {
  integrationId: string;
  config: EbayConfig;
  returnId: string;
}): Promise<EbayReturnsCallResult> {
  return postOrderRequest({
    integrationId: args.integrationId,
    config: args.config,
    method: "GET",
    path: `/post-order/v2/return/${encodeURIComponent(args.returnId)}/get_shipment_tracking`,
    callName: "return/get_shipment_tracking",
  });
}

/** GET /post-order/v2/return/{returnId}/files — file metadata (incl. buyer photos). */
export async function getReturnFiles(args: {
  integrationId: string;
  config: EbayConfig;
  returnId: string;
}): Promise<EbayReturnsCallResult> {
  return postOrderRequest({
    integrationId: args.integrationId,
    config: args.config,
    method: "GET",
    path: `/post-order/v2/return/${encodeURIComponent(args.returnId)}/files`,
    callName: "return/get_files",
  });
}

// ─── WRITE wrappers (production-only; gated upstream) ─────────────────────────

export interface EbayAmountInput {
  value: number;
  currency: string;
}

/**
 * POST /post-order/v2/return/{returnId}/decide.
 * decision ∈ APPROVE | DECLINE | OFFER_PARTIAL_REFUND | PROVIDE_RMA.
 */
export async function decideReturn(args: {
  integrationId: string;
  config: EbayConfig;
  returnId: string;
  decision: "APPROVE" | "DECLINE" | "OFFER_PARTIAL_REFUND" | "PROVIDE_RMA";
  comments?: string;
  partialRefundAmount?: EbayAmountInput;
  rmaNumber?: string;
  keepOriginalItem?: boolean;
}): Promise<EbayReturnsCallResult<{ refundStatus?: string }>> {
  const jsonBody: Record<string, unknown> = { decision: args.decision };
  if (args.comments) jsonBody.comments = { content: args.comments };
  if (args.decision === "OFFER_PARTIAL_REFUND" && args.partialRefundAmount) {
    jsonBody.partialRefundAmount = {
      value: args.partialRefundAmount.value,
      currency: args.partialRefundAmount.currency,
    };
  }
  if (args.decision === "PROVIDE_RMA" && args.rmaNumber) {
    jsonBody.RMANumber = args.rmaNumber;
    jsonBody.rMAProvided = true;
  }
  if (typeof args.keepOriginalItem === "boolean") {
    jsonBody.keepOriginalItem = args.keepOriginalItem;
  }
  return postOrderRequest({
    integrationId: args.integrationId,
    config: args.config,
    method: "POST",
    path: `/post-order/v2/return/${encodeURIComponent(args.returnId)}/decide`,
    jsonBody,
    callName: "return/decide",
  });
}

/**
 * POST /post-order/v2/return/{returnId}/issue_refund.
 * `totalAmount` must equal the sum of itemized refund amounts. We issue a
 * single PURCHASE_PRICE line for the (possibly deduction-reduced) amount.
 */
export async function issueRefund(args: {
  integrationId: string;
  config: EbayConfig;
  returnId: string;
  totalAmount: EbayAmountInput;
  comments?: string;
}): Promise<EbayReturnsCallResult<{ refundStatus?: string }>> {
  const jsonBody: Record<string, unknown> = {
    refundDetail: {
      itemizedRefundDetail: [
        {
          refundAmount: {
            value: args.totalAmount.value,
            currency: args.totalAmount.currency,
          },
          refundFeeType: "PURCHASE_PRICE",
        },
      ],
      totalAmount: {
        value: args.totalAmount.value,
        currency: args.totalAmount.currency,
      },
    },
  };
  if (args.comments) jsonBody.comments = { content: args.comments };
  return postOrderRequest({
    integrationId: args.integrationId,
    config: args.config,
    method: "POST",
    path: `/post-order/v2/return/${encodeURIComponent(args.returnId)}/issue_refund`,
    jsonBody,
    callName: "return/issue_refund",
  });
}

/** POST /post-order/v2/return/{returnId}/mark_as_received. No response body. */
export async function markAsReceived(args: {
  integrationId: string;
  config: EbayConfig;
  returnId: string;
  comments?: string;
}): Promise<EbayReturnsCallResult<{ refundStatus?: string }>> {
  const jsonBody = args.comments ? { comments: { content: args.comments } } : {};
  return postOrderRequest({
    integrationId: args.integrationId,
    config: args.config,
    method: "POST",
    path: `/post-order/v2/return/${encodeURIComponent(args.returnId)}/mark_as_received`,
    jsonBody,
    callName: "return/mark_as_received",
  });
}

/**
 * POST /post-order/v2/return/{returnId}/file/upload.
 * Base64-uploads a seller-provided file (e.g. a PDF/image return label) and
 * associates it with the return. Returns the eBay `fileId` that must then be
 * referenced from add_shipping_label (labelAction=UPLOAD_LABEL). The system
 * accepts BMP/GIF/JPEG/PNG for images and additionally PDF for labels.
 */
export async function uploadReturnFile(args: {
  integrationId: string;
  config: EbayConfig;
  returnId: string;
  /** base64-encoded binary (NO data: prefix). */
  data: string;
  fileName: string;
  /** FilePurposeEnum — LABEL_RELATED for shipping labels. */
  filePurpose: "LABEL_RELATED" | "ITEM_RELATED" | "REFUND_RELATED";
}): Promise<EbayReturnsCallResult<{ fileId?: string }>> {
  return postOrderRequest({
    integrationId: args.integrationId,
    config: args.config,
    method: "POST",
    path: `/post-order/v2/return/${encodeURIComponent(args.returnId)}/file/upload`,
    jsonBody: {
      data: args.data,
      fileName: args.fileName,
      filePurpose: args.filePurpose,
    },
    callName: "return/file_upload",
  });
}

/**
 * POST /post-order/v2/return/{returnId}/add_shipping_label.
 * Used for the "upload a label" path: the seller provides their own return
 * label (one they already created/purchased off-eBay). `labelAction` is a
 * REQUIRED field — for an uploaded label it is `UPLOAD_LABEL`, and the uploaded
 * file is referenced by `fileId` (from {@link uploadReturnFile}). This spends
 * no eBay money — the seller already arranged the label.
 */
export async function uploadReturnShippingLabel(args: {
  integrationId: string;
  config: EbayConfig;
  returnId: string;
  carrierEnum: string;
  trackingNumber: string;
  fileId?: string;
  comments?: string;
}): Promise<EbayReturnsCallResult<{ refundStatus?: string }>> {
  const jsonBody: Record<string, unknown> = {
    labelAction: "UPLOAD_LABEL",
    forwardShippingLabelProvided: true,
    carrierEnum: args.carrierEnum,
    trackingNumber: args.trackingNumber,
  };
  if (args.fileId) jsonBody.fileId = args.fileId;
  if (args.comments) jsonBody.comments = { content: args.comments };
  return postOrderRequest({
    integrationId: args.integrationId,
    config: args.config,
    method: "POST",
    path: `/post-order/v2/return/${encodeURIComponent(args.returnId)}/add_shipping_label`,
    jsonBody,
    callName: "return/add_shipping_label",
  });
}

/**
 * POST /post-order/v2/return/{returnId}/add_shipping_label.
 * "Confirm you sent a label" path: the seller has already given the buyer a
 * return label off-eBay. `labelAction` is REQUIRED and is `MARK_AS_SENT` here,
 * with `forwardShippingLabelProvided: true` and the carrier + tracking. No paid
 * eBay label is purchased.
 */
export async function addForwardedShippingLabel(args: {
  integrationId: string;
  config: EbayConfig;
  returnId: string;
  carrierEnum?: string;
  carrierName?: string;
  trackingNumber?: string;
  fileId?: string;
  comments?: string;
}): Promise<EbayReturnsCallResult<{ refundStatus?: string }>> {
  const jsonBody: Record<string, unknown> = {
    labelAction: "MARK_AS_SENT",
    forwardShippingLabelProvided: true,
  };
  if (args.carrierEnum) jsonBody.carrierEnum = args.carrierEnum;
  if (args.carrierName) jsonBody.carrierName = args.carrierName;
  if (args.trackingNumber) jsonBody.trackingNumber = args.trackingNumber;
  if (args.fileId) jsonBody.fileId = args.fileId;
  if (args.comments) jsonBody.comments = { content: args.comments };
  return postOrderRequest({
    integrationId: args.integrationId,
    config: args.config,
    method: "POST",
    path: `/post-order/v2/return/${encodeURIComponent(args.returnId)}/add_shipping_label`,
    jsonBody,
    callName: "return/add_shipping_label",
  });
}

/**
 * POST /post-order/v2/return/{returnId}/add_shipping_label with
 * labelAction=EBAY_LABEL — purchases an eBay-generated return label and makes
 * it available to the buyer. eBay charges the seller for this label. This is a
 * PAID, irreversible live write; it is gated by the full safety chain + typed
 * confirmation in the service layer before it can fire.
 */
export async function provideEbayReturnLabel(args: {
  integrationId: string;
  config: EbayConfig;
  returnId: string;
  carrierEnum?: string;
  comments?: string;
}): Promise<EbayReturnsCallResult<{ labelId?: string; labelURL?: string; trackingNumber?: string }>> {
  const jsonBody: Record<string, unknown> = { labelAction: "EBAY_LABEL" };
  if (args.carrierEnum) jsonBody.carrierEnum = args.carrierEnum;
  if (args.comments) jsonBody.comments = { content: args.comments };
  return postOrderRequest({
    integrationId: args.integrationId,
    config: args.config,
    method: "POST",
    path: `/post-order/v2/return/${encodeURIComponent(args.returnId)}/add_shipping_label`,
    jsonBody,
    callName: "return/add_shipping_label",
  });
}
