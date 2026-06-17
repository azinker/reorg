/**
 * Returns service layer.
 *
 * Owns all DB reads/writes for the returns feature plus the orchestration of
 * the eBay refresh + the preview/commit write flow. Routes stay thin and call
 * into here. Audit logging for every write attempt (committed / failed /
 * blocked) lives here so the userId + idempotency key are always recorded.
 *
 * Live eBay writes always follow this chain inside {@link commitReturnAction}:
 *   re-fetch Get Return  →  safety gate (admin/lock/env/toggle/availability)
 *   →  single write call  →  audit  →  targeted refresh.
 */

import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  Platform,
  Prisma,
  HelpdeskReturnActionStatus,
  type HelpdeskReturnCase,
} from "@prisma/client";
import { buildEbayConfig } from "@/lib/services/helpdesk-ebay";
import {
  getReturnDetail,
  getReturnTracking,
  getReturnFiles,
  decideReturn,
  issueRefund,
  markAsReceived,
  addForwardedShippingLabel,
  uploadReturnShippingLabel,
  type EbayReturnsCallResult,
} from "@/lib/services/helpdesk-ebay-returns-client";
import {
  normalizeReturnSummary,
  matchesStatusFilter,
  getReturnLifecycle,
  isReturnClosed,
  validateDeduction,
  validateRefundAmount,
  parseAmount,
  isSupportedCarrier,
  type EbayReturnSummary,
  type EbayAvailableOption,
  type ReturnActionKey,
  type ReturnStatusFilterKey,
} from "@/lib/helpdesk/returns";
import { assertReturnWriteAllowed } from "@/lib/helpdesk/returns-safety";

const EBAY_PLATFORMS: Platform[] = [Platform.TPP_EBAY, Platform.TT_EBAY];

// ─── List ────────────────────────────────────────────────────────────────────

export interface ListReturnsFilters {
  platform?: Platform | null;
  status?: ReturnStatusFilterKey | null;
  search?: string | null;
  fromDate?: Date | null;
  toDate?: Date | null;
  sort?: "opened_desc" | "opened_asc" | "deadline_asc";
  page?: number;
  pageSize?: number;
}

export interface ReturnListItem {
  id: string;
  returnId: string;
  platform: Platform;
  ebayOrderNumber: string | null;
  ebayItemId: string | null;
  itemTitle: string | null;
  imageUrl: string | null;
  buyerUserId: string | null;
  returnState: string | null;
  lifecycle: ReturnType<typeof getReturnLifecycle>;
  isClosed: boolean;
  sellerActionDue: boolean;
  reason: string | null;
  sellerRefundValue: number | null;
  sellerRefundCurrency: string | null;
  refundIsActual: boolean;
  sellerResponseDueAt: string | null;
  openedAt: string;
  closedAt: string | null;
  lastSyncedAt: string;
  ticketId: string | null;
}

function toListItem(row: HelpdeskReturnCase): ReturnListItem {
  return {
    id: row.id,
    returnId: row.returnId,
    platform: row.platform,
    ebayOrderNumber: row.ebayOrderNumber,
    ebayItemId: row.ebayItemId,
    itemTitle: row.itemTitle,
    imageUrl: row.imageUrl,
    buyerUserId: row.buyerUserId,
    returnState: row.returnState,
    lifecycle: getReturnLifecycle(row.returnState),
    isClosed: isReturnClosed(row.returnState),
    sellerActionDue: row.sellerActionDue,
    reason: row.reason,
    sellerRefundValue: row.sellerRefundValue,
    sellerRefundCurrency: row.sellerRefundCurrency,
    refundIsActual: row.refundIsActual,
    sellerResponseDueAt: row.sellerResponseDueAt?.toISOString() ?? null,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    lastSyncedAt: row.lastSyncedAt.toISOString(),
    ticketId: row.ticketId,
  };
}

/**
 * List returns from our local cache (hybrid freshness — list never round-trips
 * to eBay). Store/date/search filter at the DB; the status bucket is applied
 * in-memory because the bucket math (open vs replacement vs lifecycle) is a
 * pure helper, not a single column.
 */
export async function listReturnCases(filters: ListReturnsFilters): Promise<{
  items: ReturnListItem[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));

  const where: Prisma.HelpdeskReturnCaseWhereInput = {
    platform: filters.platform ?? { in: EBAY_PLATFORMS },
  };
  if (filters.fromDate || filters.toDate) {
    where.openedAt = {};
    if (filters.fromDate) where.openedAt.gte = filters.fromDate;
    if (filters.toDate) where.openedAt.lte = filters.toDate;
  }
  const q = filters.search?.trim();
  if (q) {
    where.OR = [
      { ebayOrderNumber: { contains: q, mode: Prisma.QueryMode.insensitive } },
      { buyerUserId: { contains: q, mode: Prisma.QueryMode.insensitive } },
      { ebayItemId: { contains: q, mode: Prisma.QueryMode.insensitive } },
      { itemTitle: { contains: q, mode: Prisma.QueryMode.insensitive } },
      { returnId: { contains: q, mode: Prisma.QueryMode.insensitive } },
    ];
  }

  // Cap the candidate set; returns volume is modest relative to messages.
  const candidates = await db.helpdeskReturnCase.findMany({
    where,
    orderBy: { openedAt: "desc" },
    take: 3000,
  });

  const statusKey = filters.status ?? "open_all";
  const filtered = candidates.filter((row) =>
    matchesStatusFilter(statusKey, {
      state: row.returnState,
      currentType: row.currentType,
      sellerActionDue: row.sellerActionDue,
    }),
  );

  const sort = filters.sort ?? "opened_desc";
  filtered.sort((a, b) => {
    if (sort === "opened_asc") return a.openedAt.getTime() - b.openedAt.getTime();
    if (sort === "deadline_asc") {
      const ad = a.sellerResponseDueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bd = b.sellerResponseDueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return ad - bd;
    }
    return b.openedAt.getTime() - a.openedAt.getTime();
  });

  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize).map(toListItem);
  return { items, total, page, pageSize };
}

/** Needs-attention badge count (open returns with a seller action due). */
export async function countReturnsNeedingAttention(): Promise<number> {
  return db.helpdeskReturnCase.count({
    where: { platform: { in: EBAY_PLATFORMS }, sellerActionDue: true },
  });
}

// ─── Detail + refresh ────────────────────────────────────────────────────────

async function resolveCaseByReturnId(returnId: string): Promise<HelpdeskReturnCase | null> {
  return db.helpdeskReturnCase.findFirst({ where: { returnId } });
}

function fingerprintTrackingEvent(e: {
  eventDate?: string | null;
  status?: string | null;
  location?: string | null;
  description?: string | null;
}): string {
  return [e.eventDate ?? "", e.status ?? "", e.location ?? "", e.description ?? ""].join("|");
}

interface RawTrackingEvent {
  eventDate?: { value?: string };
  date?: { value?: string };
  status?: string;
  activity?: string;
  location?: string;
  city?: string;
  description?: string;
  eventDescription?: string;
}

/**
 * Re-fetch a single return's detail (+ tracking + files) directly from eBay and
 * persist it. This is the authoritative read used by the detail page and
 * ALWAYS run immediately before any write so the availability check is fresh.
 * Read-only against eBay.
 */
export async function refreshReturnDetail(returnId: string): Promise<{
  caseRow: HelpdeskReturnCase | null;
  detailResult: EbayReturnsCallResult | null;
  error: string | null;
}> {
  const existing = await resolveCaseByReturnId(returnId);
  if (!existing) return { caseRow: null, detailResult: null, error: "Return not found." };

  const integration = await db.integration.findUnique({
    where: { id: existing.integrationId },
  });
  if (!integration) {
    return { caseRow: existing, detailResult: null, error: "Integration not found." };
  }
  const config = buildEbayConfig(integration);

  const detailResult = await getReturnDetail({
    integrationId: integration.id,
    config,
    returnId,
  });
  if (!detailResult.ok || !detailResult.body) {
    return { caseRow: existing, detailResult, error: detailResult.errorMessage };
  }

  const raw = detailResult.body as EbayReturnSummary;
  const fields = normalizeReturnSummary(raw);

  const updated = await db.helpdeskReturnCase.update({
    where: { id: existing.id },
    data: {
      ebayOrderNumber: fields.ebayOrderNumber ?? existing.ebayOrderNumber,
      ebayItemId: fields.ebayItemId ?? existing.ebayItemId,
      transactionId: fields.transactionId ?? existing.transactionId,
      returnQuantity: fields.returnQuantity ?? existing.returnQuantity,
      itemTitle: fields.itemTitle ?? existing.itemTitle,
      imageUrl: fields.imageUrl ?? existing.imageUrl,
      sku: fields.sku ?? existing.sku,
      buyerUserId: fields.buyerUserId ?? existing.buyerUserId,
      sellerUserId: fields.sellerUserId ?? existing.sellerUserId,
      returnState: fields.returnState ?? existing.returnState,
      returnStatus: fields.returnStatus ?? existing.returnStatus,
      currentType: fields.currentType ?? existing.currentType,
      sellerActionDue: fields.sellerActionDue,
      escalated: fields.escalated,
      caseId: fields.caseId ?? existing.caseId,
      reason: fields.reason ?? existing.reason,
      reasonType: fields.reasonType ?? existing.reasonType,
      buyerComments: fields.buyerComments ?? existing.buyerComments,
      sellerRefundValue: fields.sellerRefundValue,
      sellerRefundCurrency: fields.sellerRefundCurrency,
      buyerRefundValue: fields.buyerRefundValue,
      buyerRefundCurrency: fields.buyerRefundCurrency,
      refundIsActual: fields.refundIsActual,
      sellerResponseDueAt: fields.sellerResponseDueAt,
      buyerResponseDueAt: fields.buyerResponseDueAt,
      timeoutDate: fields.timeoutDate,
      closedAt: fields.closedAt ?? existing.closedAt,
      sellerAvailableOptions: fields.sellerAvailableOptions as unknown as Prisma.InputJsonValue,
      buyerAvailableOptions: fields.buyerAvailableOptions as unknown as Prisma.InputJsonValue,
      rawDetail: raw as unknown as Prisma.InputJsonValue,
      detailFetchedAt: new Date(),
      lastSyncedAt: new Date(),
    },
  });

  // Tracking + files are best-effort enrichment; never block the detail render.
  try {
    await syncTrackingEvents(existing.id, integration.id, config, returnId);
  } catch {
    /* non-fatal */
  }
  try {
    await syncReturnFiles(existing.id, integration.id, config, returnId);
  } catch {
    /* non-fatal */
  }

  return { caseRow: updated, detailResult, error: null };
}

async function syncTrackingEvents(
  returnCaseId: string,
  integrationId: string,
  config: ReturnType<typeof buildEbayConfig>,
  returnId: string,
): Promise<void> {
  const res = await getReturnTracking({ integrationId, config, returnId });
  if (!res.ok || !res.body) return;
  const body = res.body as { shipmentTrackingDetails?: unknown[]; trackingHistory?: unknown[] };
  const rawEvents =
    (body.trackingHistory as RawTrackingEvent[] | undefined) ??
    ((body.shipmentTrackingDetails as { trackingHistory?: RawTrackingEvent[] }[] | undefined)?.[0]
      ?.trackingHistory) ??
    [];
  for (const ev of rawEvents) {
    const eventDate = ev.eventDate?.value ?? ev.date?.value ?? null;
    const fingerprint = fingerprintTrackingEvent({
      eventDate,
      status: ev.status ?? ev.activity ?? null,
      location: ev.location ?? ev.city ?? null,
      description: ev.description ?? ev.eventDescription ?? null,
    });
    await db.helpdeskReturnTrackingEvent.upsert({
      where: { returnCaseId_fingerprint: { returnCaseId, fingerprint } },
      create: {
        returnCaseId,
        eventDate: eventDate ? new Date(eventDate) : null,
        status: ev.status ?? ev.activity ?? null,
        location: ev.location ?? ev.city ?? null,
        description: ev.description ?? ev.eventDescription ?? null,
        fingerprint,
        rawData: ev as unknown as Prisma.InputJsonValue,
      },
      update: {},
    });
  }
}

interface RawReturnFile {
  fileId?: string;
  fileName?: string;
  filePurpose?: string;
  fileType?: string;
  contentType?: string;
  fileSize?: number;
  url?: string;
}

async function syncReturnFiles(
  returnCaseId: string,
  integrationId: string,
  config: ReturnType<typeof buildEbayConfig>,
  returnId: string,
): Promise<void> {
  const res = await getReturnFiles({ integrationId, config, returnId });
  if (!res.ok || !res.body) return;
  const body = res.body as { files?: RawReturnFile[] };
  for (const f of body.files ?? []) {
    if (!f.fileId) continue;
    const existing = await db.helpdeskReturnFile.findFirst({
      where: { returnCaseId, ebayFileId: f.fileId },
    });
    if (existing) continue;
    await db.helpdeskReturnFile.create({
      data: {
        returnCaseId,
        ebayFileId: f.fileId,
        fileName: f.fileName ?? null,
        filePurpose: f.filePurpose ?? null,
        contentType: f.contentType ?? f.fileType ?? null,
        sizeBytes: typeof f.fileSize === "number" ? f.fileSize : null,
        url: f.url ?? null,
        source: "EBAY",
        rawData: f as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

export async function getReturnCaseDetail(returnId: string): Promise<{
  caseRow:
    | (HelpdeskReturnCase & {
        trackingEvents: Awaited<ReturnType<typeof db.helpdeskReturnTrackingEvent.findMany>>;
        files: Awaited<ReturnType<typeof db.helpdeskReturnFile.findMany>>;
        actionAttempts: Awaited<ReturnType<typeof db.helpdeskReturnActionAttempt.findMany>>;
      })
    | null;
}> {
  const base = await resolveCaseByReturnId(returnId);
  if (!base) return { caseRow: null };
  const [trackingEvents, files, actionAttempts] = await Promise.all([
    db.helpdeskReturnTrackingEvent.findMany({
      where: { returnCaseId: base.id },
      orderBy: { eventDate: "desc" },
    }),
    db.helpdeskReturnFile.findMany({
      where: { returnCaseId: base.id },
      orderBy: { createdAt: "desc" },
    }),
    db.helpdeskReturnActionAttempt.findMany({
      where: { returnCaseId: base.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  return { caseRow: { ...base, trackingEvents, files, actionAttempts } };
}

// ─── Action preview + commit ─────────────────────────────────────────────────

export interface ActionParams {
  /** OFFER_PARTIAL_REFUND / ISSUE_REFUND: explicit amount. */
  amount?: number;
  /** ISSUE_REFUND with a free-return deduction. */
  deductionType?: "none" | "percent" | "amount";
  deductionValue?: number;
  deductionReason?: string;
  deductionComment?: string;
  /** CONFIRM_LABEL_SENT: forwarded label details. */
  carrierEnum?: string;
  trackingNumber?: string;
  comments?: string;
}

export interface PreviewResult {
  ok: boolean;
  idempotencyKey?: string;
  summary?: {
    action: ReturnActionKey;
    headline: string;
    lines: string[];
    requiresTypedConfirmation: boolean;
    finalRefundAmount?: number;
    currency?: string;
  };
  error?: string;
}

function refundCurrencyFor(caseRow: HelpdeskReturnCase): string {
  return caseRow.sellerRefundCurrency ?? caseRow.buyerRefundCurrency ?? "USD";
}

function maxRefundFor(caseRow: HelpdeskReturnCase): number {
  // Use the eBay-estimated seller refund as the ceiling; fall back to buyer.
  return (
    caseRow.sellerRefundValue ??
    caseRow.buyerRefundValue ??
    Number.POSITIVE_INFINITY
  );
}

/**
 * Validate an action and persist a PREVIEWED attempt with an idempotency key.
 * No eBay call happens here. The commit step must echo the key back so the
 * committed payload matches exactly what the user confirmed.
 */
export async function previewReturnAction(args: {
  returnId: string;
  userId: string;
  action: ReturnActionKey;
  params: ActionParams;
}): Promise<PreviewResult> {
  const caseRow = await resolveCaseByReturnId(args.returnId);
  if (!caseRow) return { ok: false, error: "Return not found." };

  const currency = refundCurrencyFor(caseRow);
  const lines: string[] = [];
  let headline = "";
  let requiresTypedConfirmation = false;
  let finalRefundAmount: number | undefined;
  const requestPayload: Record<string, unknown> = { action: args.action };

  switch (args.action) {
    case "APPROVE_RETURN": {
      headline = "Approve this return request";
      lines.push("eBay will notify the buyer the return is approved.");
      break;
    }
    case "MARK_AS_RECEIVED": {
      headline = "Mark the returned item as received";
      lines.push("Confirms to eBay that you received the returned item.");
      break;
    }
    case "CONFIRM_LABEL_SENT": {
      if (args.params.carrierEnum && !isSupportedCarrier(args.params.carrierEnum)) {
        return { ok: false, error: "Unsupported carrier." };
      }
      headline = "Confirm you sent the buyer a return label";
      if (args.params.carrierEnum) lines.push(`Carrier: ${args.params.carrierEnum}`);
      if (args.params.trackingNumber) lines.push(`Tracking: ${args.params.trackingNumber}`);
      requestPayload.carrierEnum = args.params.carrierEnum;
      requestPayload.trackingNumber = args.params.trackingNumber;
      break;
    }
    case "UPLOAD_LABEL": {
      if (!args.params.carrierEnum || !isSupportedCarrier(args.params.carrierEnum)) {
        return { ok: false, error: "Choose a supported carrier." };
      }
      if (!args.params.trackingNumber || !args.params.trackingNumber.trim()) {
        return { ok: false, error: "Enter the tracking number on your label." };
      }
      headline = "Upload your return shipping label";
      lines.push(`Carrier: ${args.params.carrierEnum}`);
      lines.push(`Tracking: ${args.params.trackingNumber.trim()}`);
      lines.push("eBay shares this label + tracking with the buyer.");
      requiresTypedConfirmation = true;
      requestPayload.carrierEnum = args.params.carrierEnum;
      requestPayload.trackingNumber = args.params.trackingNumber.trim();
      break;
    }
    case "OFFER_PARTIAL_REFUND": {
      const amount = args.params.amount ?? 0;
      const check = validateRefundAmount({ amount, maxAmount: maxRefundFor(caseRow) });
      if (!check.ok) return { ok: false, error: check.error };
      headline = "Offer the buyer a partial refund";
      lines.push(`Offer amount: ${currency} ${amount.toFixed(2)}`);
      lines.push("The buyer can accept or decline this offer.");
      finalRefundAmount = amount;
      requiresTypedConfirmation = true;
      requestPayload.amount = amount;
      requestPayload.currency = currency;
      break;
    }
    case "ISSUE_REFUND": {
      const deductionType = args.params.deductionType ?? "none";
      const original =
        args.params.amount ??
        (Number.isFinite(maxRefundFor(caseRow)) ? maxRefundFor(caseRow) : 0);
      if (!Number.isFinite(original) || original <= 0) {
        return { ok: false, error: "Could not determine the refund amount from eBay." };
      }
      const ded = validateDeduction({
        originalAmount: original,
        deductionType,
        deductionValue: args.params.deductionValue ?? 0,
        reason: args.params.deductionReason,
        comment: args.params.deductionComment,
      });
      if (!ded.ok) return { ok: false, error: ded.error };
      headline = "Issue a refund to the buyer";
      lines.push(`Order total: ${currency} ${original.toFixed(2)}`);
      if (ded.deductionAmount > 0) {
        lines.push(`Deduction: −${currency} ${ded.deductionAmount.toFixed(2)}`);
        lines.push(`Reason: ${args.params.deductionReason}`);
      }
      lines.push(`Refund to buyer: ${currency} ${ded.finalRefund.toFixed(2)}`);
      lines.push("This is final and cannot be undone.");
      finalRefundAmount = ded.finalRefund;
      requiresTypedConfirmation = true;
      requestPayload.amount = ded.finalRefund;
      requestPayload.currency = currency;
      requestPayload.deductionAmount = ded.deductionAmount;
      requestPayload.deductionReason = args.params.deductionReason ?? null;
      break;
    }
    default:
      return { ok: false, error: "This action is not supported." };
  }

  if (args.params.comments) requestPayload.comments = args.params.comments;

  const idempotencyKey = randomUUID();
  const summary = {
    action: args.action,
    headline,
    lines,
    requiresTypedConfirmation,
    finalRefundAmount,
    currency,
  };

  await db.helpdeskReturnActionAttempt.create({
    data: {
      returnCaseId: caseRow.id,
      integrationId: caseRow.integrationId,
      userId: args.userId,
      actionType: args.action,
      status: HelpdeskReturnActionStatus.PREVIEWED,
      idempotencyKey,
      previewSummary: summary as unknown as Prisma.InputJsonValue,
      requestPayload: requestPayload as unknown as Prisma.InputJsonValue,
    },
  });

  return { ok: true, idempotencyKey, summary };
}

export interface CommitResult {
  ok: boolean;
  status: "COMMITTED" | "FAILED" | "BLOCKED";
  error?: string;
  ebayRequestId?: string | null;
  refundStatus?: string | null;
}

async function writeAudit(args: {
  userId: string;
  action: string;
  returnCaseId: string;
  details: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: args.userId,
        action: args.action,
        entityType: "HelpdeskReturnCase",
        entityId: args.returnCaseId,
        details: args.details as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.error("[helpdesk-returns] audit write failed", err);
  }
}

/**
 * Commit a previously-previewed action. Re-fetches the return from eBay, runs
 * the safety gate against FRESH availability, executes a single live write,
 * then audits + refreshes. Idempotent: a committed/failed key can't re-fire.
 */
export async function commitReturnAction(args: {
  returnId: string;
  userId: string;
  isAdmin: boolean;
  idempotencyKey: string;
  typedConfirmation?: string | null;
}): Promise<CommitResult> {
  const attempt = await db.helpdeskReturnActionAttempt.findUnique({
    where: { idempotencyKey: args.idempotencyKey },
  });
  if (!attempt) return { ok: false, status: "FAILED", error: "Unknown or expired preview token." };
  if (attempt.status !== HelpdeskReturnActionStatus.PREVIEWED) {
    return {
      ok: false,
      status: "FAILED",
      error: "This action was already processed. Start a new preview.",
    };
  }

  const action = attempt.actionType as ReturnActionKey;
  const payload = attempt.requestPayload as Record<string, unknown>;
  const summary = attempt.previewSummary as { requiresTypedConfirmation?: boolean };

  // Typed confirmation gate for paid/irreversible actions.
  if (summary?.requiresTypedConfirmation) {
    if ((args.typedConfirmation ?? "").trim().toUpperCase() !== "CONFIRM") {
      return { ok: false, status: "FAILED", error: 'Type "CONFIRM" to authorize this action.' };
    }
  }

  const caseRow = await resolveCaseByReturnId(args.returnId);
  if (!caseRow || caseRow.id !== attempt.returnCaseId) {
    return { ok: false, status: "FAILED", error: "Return not found." };
  }

  const integration = await db.integration.findUnique({ where: { id: caseRow.integrationId } });
  if (!integration) return { ok: false, status: "FAILED", error: "Integration not found." };
  const config = buildEbayConfig(integration);

  // STEP 1 — re-fetch the latest detail so availability is authoritative.
  const refresh = await refreshReturnDetail(args.returnId);
  const freshCase = refresh.caseRow ?? caseRow;
  const freshOptions = (freshCase.sellerAvailableOptions ?? []) as unknown as EbayAvailableOption[];

  // STEP 2 — safety gate.
  const gate = await assertReturnWriteAllowed({
    isAdmin: args.isAdmin,
    platform: integration.platform,
    action,
    freshSellerOptions: freshOptions,
  });
  if (!gate.allowed) {
    await db.helpdeskReturnActionAttempt.update({
      where: { id: attempt.id },
      data: { status: HelpdeskReturnActionStatus.BLOCKED, blockReason: gate.reason },
    });
    await writeAudit({
      userId: args.userId,
      action: "HELPDESK_RETURN_ACTION_BLOCKED",
      returnCaseId: caseRow.id,
      details: { action, code: gate.code, reason: gate.reason, returnId: args.returnId },
    });
    return { ok: false, status: "BLOCKED", error: gate.reason };
  }

  // STEP 3 — single live eBay write.
  const currency = (payload.currency as string) ?? refundCurrencyFor(freshCase);
  const comments = (payload.comments as string) ?? undefined;
  let result: EbayReturnsCallResult<{ refundStatus?: string }>;
  try {
    switch (action) {
      case "APPROVE_RETURN":
        result = await decideReturn({
          integrationId: integration.id,
          config,
          returnId: args.returnId,
          decision: "APPROVE",
          comments,
        });
        break;
      case "OFFER_PARTIAL_REFUND":
        result = await decideReturn({
          integrationId: integration.id,
          config,
          returnId: args.returnId,
          decision: "OFFER_PARTIAL_REFUND",
          partialRefundAmount: { value: Number(payload.amount), currency },
          comments,
        });
        break;
      case "MARK_AS_RECEIVED":
        result = await markAsReceived({
          integrationId: integration.id,
          config,
          returnId: args.returnId,
          comments,
        });
        break;
      case "ISSUE_REFUND":
        result = await issueRefund({
          integrationId: integration.id,
          config,
          returnId: args.returnId,
          totalAmount: { value: Number(payload.amount), currency },
          comments,
        });
        break;
      case "CONFIRM_LABEL_SENT":
        result = await addForwardedShippingLabel({
          integrationId: integration.id,
          config,
          returnId: args.returnId,
          carrierEnum: payload.carrierEnum as string | undefined,
          trackingNumber: payload.trackingNumber as string | undefined,
          comments,
        });
        break;
      case "UPLOAD_LABEL":
        result = await uploadReturnShippingLabel({
          integrationId: integration.id,
          config,
          returnId: args.returnId,
          carrierEnum: payload.carrierEnum as string,
          trackingNumber: payload.trackingNumber as string,
          comments,
        });
        break;
      default:
        return { ok: false, status: "FAILED", error: "Unsupported action." };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.helpdeskReturnActionAttempt.update({
      where: { id: attempt.id },
      data: { status: HelpdeskReturnActionStatus.FAILED, errorMessage: message },
    });
    await writeAudit({
      userId: args.userId,
      action: "HELPDESK_RETURN_ACTION_FAILED",
      returnCaseId: caseRow.id,
      details: { action, error: message, returnId: args.returnId },
    });
    return { ok: false, status: "FAILED", error: message };
  }

  const refundStatus = result.body?.refundStatus ?? null;

  // STEP 4 — audit + persist outcome.
  await db.helpdeskReturnActionAttempt.update({
    where: { id: attempt.id },
    data: {
      status: result.ok ? HelpdeskReturnActionStatus.COMMITTED : HelpdeskReturnActionStatus.FAILED,
      committedAt: result.ok ? new Date() : null,
      ebayRequestId: result.requestId,
      responsePayload: {
        status: result.status,
        refundStatus,
        errors: result.errors,
      } as unknown as Prisma.InputJsonValue,
      errorMessage: result.ok ? null : result.errorMessage,
    },
  });
  await writeAudit({
    userId: args.userId,
    action: result.ok ? "HELPDESK_RETURN_ACTION_COMMITTED" : "HELPDESK_RETURN_ACTION_FAILED",
    returnCaseId: caseRow.id,
    details: {
      action,
      returnId: args.returnId,
      ebayStatus: result.status,
      ebayRequestId: result.requestId,
      refundStatus,
      ok: result.ok,
      amount: payload.amount ?? null,
      currency,
    },
  });

  if (!result.ok) {
    return {
      ok: false,
      status: "FAILED",
      error: result.errorMessage ?? undefined,
      ebayRequestId: result.requestId,
    };
  }

  // STEP 5 — targeted refresh so the UI reflects the new eBay state.
  try {
    await refreshReturnDetail(args.returnId);
  } catch {
    /* non-fatal — the next sync tick will reconcile */
  }

  return { ok: true, status: "COMMITTED", ebayRequestId: result.requestId, refundStatus };
}

export { parseAmount };
