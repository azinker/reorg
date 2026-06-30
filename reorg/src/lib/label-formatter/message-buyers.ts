import {
  HelpdeskComposerMode,
  HelpdeskOutboundStatus,
  HelpdeskTicketStatus,
  Platform,
  type HelpdeskTicket,
} from "@prisma/client";
import { db } from "@/lib/db";
import { helpdeskFlagsSnapshotAsync } from "@/lib/helpdesk/flags";
import { fillTemplate, type TemplateContext } from "@/lib/helpdesk/template-fill";
import { sourceStoreLabel, type LabelFormatterSourceStore } from "@/lib/label-formatter/types";

const ACTIVE_STATUSES: HelpdeskTicketStatus[] = [
  HelpdeskTicketStatus.NEW,
  HelpdeskTicketStatus.TO_DO,
  HelpdeskTicketStatus.WAITING,
];

export type ReshipMessageTarget = {
  reshipRowId: string;
  orderNumber: string;
  sourceStore: LabelFormatterSourceStore;
  buyerName: string;
  trackingNumber: string | null;
  sourceStoreLabel: string;
};

export function channelForSourceStore(
  sourceStore: LabelFormatterSourceStore,
): Platform | null {
  if (sourceStore === "EBAY_TPP") return Platform.TPP_EBAY;
  if (sourceStore === "EBAY_TT") return Platform.TT_EBAY;
  return null;
}

export function canMessageReshipRow(sourceStore: LabelFormatterSourceStore): boolean {
  return channelForSourceStore(sourceStore) !== null;
}

export async function findHelpdeskTicketForOrder(
  orderNumber: string,
  sourceStore: LabelFormatterSourceStore,
): Promise<HelpdeskTicket | null> {
  const channel = channelForSourceStore(sourceStore);
  if (!channel) return null;

  const normalized = orderNumber.trim();
  const baseWhere = {
    ebayOrderNumber: { equals: normalized, mode: "insensitive" as const },
    channel,
    isSpam: false,
  };

  const active = await db.helpdeskTicket.findFirst({
    where: {
      ...baseWhere,
      isArchived: false,
      status: { in: ACTIVE_STATUSES },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (active) return active;

  return db.helpdeskTicket.findFirst({
    where: baseWhere,
    orderBy: { updatedAt: "desc" },
  });
}

export function templateContextForReshipRow(
  target: ReshipMessageTarget,
  ticket: HelpdeskTicket,
): TemplateContext {
  return {
    deliveryName: target.buyerName,
    buyerName: ticket.buyerName ?? target.buyerName,
    buyerUserId: ticket.buyerUserId,
    ebayOrderNumber: target.orderNumber,
    ebayItemId: ticket.ebayItemId,
    ebayItemTitle: ticket.ebayItemTitle,
    trackingNumber: target.trackingNumber,
    storeName: target.sourceStoreLabel || sourceStoreLabel(target.sourceStore),
  };
}

export async function enqueueHelpdeskReplyForTicket(args: {
  ticketId: string;
  authorUserId: string;
  bodyText: string;
  sendDelaySeconds?: number;
}): Promise<{
  jobId: string;
  scheduledAt: string;
  willBlockReason: string | null;
}> {
  const ticket = await db.helpdeskTicket.findUnique({ where: { id: args.ticketId } });
  if (!ticket) {
    throw new Error("Ticket not found.");
  }

  const sendDelaySeconds = args.sendDelaySeconds ?? 5;
  const scheduledAt = new Date(Date.now() + sendDelaySeconds * 1000);
  const flags = await helpdeskFlagsSnapshotAsync();

  const willBlockReason: string | null = flags.safeMode
    ? flags.globalWriteLock
      ? "global_write_lock"
      : "safe_mode"
    : !flags.enableEbaySend
      ? "ebay_send_disabled"
      : null;

  const metadata = {
    previousTicketStatus: ticket.status,
    previousResolvedAt: ticket.resolvedAt?.toISOString() ?? null,
    previousResolvedById: ticket.resolvedById,
    previousIsArchived: ticket.isArchived,
    previousArchivedAt: ticket.archivedAt?.toISOString() ?? null,
    source: "label_formatter_reship_message_buyers",
  };

  const job = await db.helpdeskOutboundJob.create({
    data: {
      ticketId: args.ticketId,
      authorUserId: args.authorUserId,
      composerMode: HelpdeskComposerMode.REPLY,
      bodyText: args.bodyText,
      scheduledAt,
      setStatus: null,
      status: HelpdeskOutboundStatus.PENDING,
      metadata,
    },
  });

  await db.auditLog.create({
    data: {
      userId: args.authorUserId,
      action: "HELPDESK_OUTBOUND_QUEUED",
      entityType: "HelpdeskOutboundJob",
      entityId: job.id,
      details: {
        ticketId: args.ticketId,
        composerMode: HelpdeskComposerMode.REPLY,
        scheduledAt: scheduledAt.toISOString(),
        willBlockReason,
        source: "label_formatter_reship_message_buyers",
      },
    },
  });

  return {
    jobId: job.id,
    scheduledAt: scheduledAt.toISOString(),
    willBlockReason,
  };
}

export async function enqueueReshipBuyerMessages(args: {
  authorUserId: string;
  bodyTemplate: string;
  sendDelaySeconds?: number;
  targets: ReshipMessageTarget[];
}) {
  const results: Array<{
    reshipRowId: string;
    orderNumber: string;
    buyerName: string;
    ticketId: string | null;
    jobId: string | null;
    scheduledAt: string | null;
    willBlockReason: string | null;
    filledPreview: string | null;
    status: "queued" | "skipped" | "error";
    error: string | null;
  }> = [];

  for (const target of args.targets) {
    if (!canMessageReshipRow(target.sourceStore)) {
      results.push({
        reshipRowId: target.reshipRowId,
        orderNumber: target.orderNumber,
        buyerName: target.buyerName,
        ticketId: null,
        jobId: null,
        scheduledAt: null,
        willBlockReason: null,
        filledPreview: null,
        status: "skipped",
        error: "Help Desk messages are only supported for eBay TPP and eBay TT orders.",
      });
      continue;
    }

    try {
      const ticket = await findHelpdeskTicketForOrder(target.orderNumber, target.sourceStore);
      if (!ticket) {
        results.push({
          reshipRowId: target.reshipRowId,
          orderNumber: target.orderNumber,
          buyerName: target.buyerName,
          ticketId: null,
          jobId: null,
          scheduledAt: null,
          willBlockReason: null,
          filledPreview: null,
          status: "error",
          error: "No Help Desk ticket found for this order.",
        });
        continue;
      }

      const ctx = templateContextForReshipRow(target, ticket);
      const filledBody = fillTemplate(args.bodyTemplate, ctx).trim();
      if (!filledBody) {
        results.push({
          reshipRowId: target.reshipRowId,
          orderNumber: target.orderNumber,
          buyerName: target.buyerName,
          ticketId: ticket.id,
          jobId: null,
          scheduledAt: null,
          willBlockReason: null,
          filledPreview: null,
          status: "error",
          error: "Message body is empty after snippet substitution.",
        });
        continue;
      }

      const queued = await enqueueHelpdeskReplyForTicket({
        ticketId: ticket.id,
        authorUserId: args.authorUserId,
        bodyText: filledBody,
        sendDelaySeconds: args.sendDelaySeconds,
      });

      results.push({
        reshipRowId: target.reshipRowId,
        orderNumber: target.orderNumber,
        buyerName: target.buyerName,
        ticketId: ticket.id,
        jobId: queued.jobId,
        scheduledAt: queued.scheduledAt,
        willBlockReason: queued.willBlockReason,
        filledPreview: filledBody.slice(0, 200),
        status: "queued",
        error: null,
      });
    } catch (error) {
      results.push({
        reshipRowId: target.reshipRowId,
        orderNumber: target.orderNumber,
        buyerName: target.buyerName,
        ticketId: null,
        jobId: null,
        scheduledAt: null,
        willBlockReason: null,
        filledPreview: null,
        status: "error",
        error: error instanceof Error ? error.message : "Failed to queue message.",
      });
    }
  }

  return results;
}

export async function getOutboundJobStatuses(jobIds: string[]) {
  const unique = [...new Set(jobIds.filter(Boolean))];
  if (unique.length === 0) return [];

  const jobs = await db.helpdeskOutboundJob.findMany({
    where: { id: { in: unique } },
    select: {
      id: true,
      ticketId: true,
      status: true,
      lastError: true,
      scheduledAt: true,
      sentAt: true,
      updatedAt: true,
    },
  });

  return jobs.map((job) => ({
    jobId: job.id,
    ticketId: job.ticketId,
    status: job.status,
    errorMessage: job.lastError,
    scheduledAt: job.scheduledAt.toISOString(),
    sentAt: job.sentAt?.toISOString() ?? null,
    updatedAt: job.updatedAt.toISOString(),
  }));
}
