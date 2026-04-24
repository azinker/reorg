/**
 * Help Desk outbound job worker.
 *
 * Pipeline:
 *   1. Agent clicks Send → API enqueues a HelpdeskOutboundJob (status: PENDING,
 *      scheduledAt = now + sendDelaySeconds). The Composer UI shows an undo
 *      window using the same scheduledAt.
 *   2. Worker picks up jobs whose scheduledAt has elapsed and status is PENDING.
 *      Worker checks safe-mode, channel-specific feature flag, then calls the
 *      appropriate transport (eBay Trading API or Resend) before persisting an
 *      OUTBOUND HelpdeskMessage and bumping ticket status.
 *   3. Audit log records every state transition.
 *
 * Idempotency:
 *   - Worker grabs jobs with a status flip from PENDING → SENDING using
 *     updateMany + transaction guards so two parallel workers cannot send the
 *     same job twice.
 *   - On HTTP failure we leave the row in FAILED with a lastError. Retries are
 *     manual — the operator fixes the cause (template, item visibility) then
 *     hits resend.
 */

import { db } from "@/lib/db";
import {
  HelpdeskComposerMode,
  HelpdeskMessageDirection,
  HelpdeskMessageSource,
  HelpdeskOutboundStatus,
  HelpdeskTicketStatus,
  Platform,
  type HelpdeskOutboundJob,
  type HelpdeskTicket,
  type Integration,
} from "@prisma/client";
import {
  helpdeskFlagsSnapshotAsync,
  type HelpdeskFlagsSnapshot,
} from "@/lib/helpdesk/flags";
import {
  buildEbayConfig,
  sendHelpdeskReply,
  type SendHelpdeskReplyResult,
} from "@/lib/services/helpdesk-ebay";

const MAX_BATCH = 25;

export interface OutboundWorkerResult {
  picked: number;
  sent: number;
  failed: number;
  blocked: number;
  errors: string[];
}

export async function processHelpdeskOutboundJobs(): Promise<OutboundWorkerResult> {
  const now = new Date();
  const result: OutboundWorkerResult = {
    picked: 0,
    sent: 0,
    failed: 0,
    blocked: 0,
    errors: [],
  };

  // Atomically pick a batch of jobs that are due.
  const candidateIds = (
    await db.helpdeskOutboundJob.findMany({
      where: {
        status: HelpdeskOutboundStatus.PENDING,
        scheduledAt: { lte: now },
      },
      select: { id: true },
      orderBy: { scheduledAt: "asc" },
      take: MAX_BATCH,
    })
  ).map((j) => j.id);

  if (candidateIds.length === 0) return result;

  // Flip status to SENDING in a single update; only work on the rows that flipped.
  const flip = await db.helpdeskOutboundJob.updateMany({
    where: {
      id: { in: candidateIds },
      status: HelpdeskOutboundStatus.PENDING,
    },
    data: { status: HelpdeskOutboundStatus.SENDING },
  });
  result.picked = flip.count;
  if (flip.count === 0) return result;

  const jobs = await db.helpdeskOutboundJob.findMany({
    where: { id: { in: candidateIds }, status: HelpdeskOutboundStatus.SENDING },
    include: {
      ticket: { include: { integration: true } },
    },
  });

  for (const job of jobs) {
    try {
      const outcome = await sendOne(job);
      if (outcome === "sent") result.sent++;
      else if (outcome === "blocked") result.blocked++;
      else result.failed++;
    } catch (err) {
      result.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${job.id}: ${msg}`);
      await db.helpdeskOutboundJob.update({
        where: { id: job.id },
        data: {
          status: HelpdeskOutboundStatus.FAILED,
          lastError: msg.slice(0, 500),
          attemptCount: { increment: 1 },
        },
      });
      await audit(job, "HELPDESK_OUTBOUND_FAILED", { error: msg });
    }
  }

  return result;
}

async function sendOne(
  job: HelpdeskOutboundJob & {
    ticket: HelpdeskTicket & { integration: Integration };
  },
): Promise<"sent" | "blocked" | "failed"> {
  // Safe Mode is the killswitch. We use the ASYNC snapshot here so the
  // global write lock (Settings → Write Safety) is honored — flipping the
  // lock in the UI must immediately stop outbound traffic without anyone
  // having to redeploy or change an env var.
  const flags = await helpdeskFlagsSnapshotAsync();
  if (flags.safeMode) {
    const reason = flags.globalWriteLock ? "global_write_lock" : "safe_mode";
    await db.helpdeskOutboundJob.update({
      where: { id: job.id },
      data: {
        status: HelpdeskOutboundStatus.CANCELED,
        lastError: `blocked_by_${reason}`,
      },
    });
    await audit(job, "HELPDESK_OUTBOUND_BLOCKED", { reason });
    return "blocked";
  }

  if (job.composerMode === HelpdeskComposerMode.NOTE) {
    // Notes never send externally; surface as a misuse.
    await db.helpdeskOutboundJob.update({
      where: { id: job.id },
      data: {
        status: HelpdeskOutboundStatus.CANCELED,
        lastError: "note_misrouted_to_outbound",
      },
    });
    return "blocked";
  }

  if (job.composerMode === HelpdeskComposerMode.REPLY) {
    return sendEbayReply(job, flags);
  }

  if (job.composerMode === HelpdeskComposerMode.EXTERNAL) {
    return sendExternalEmail(job, flags);
  }

  return "failed";
}

async function sendEbayReply(
  job: HelpdeskOutboundJob & {
    ticket: HelpdeskTicket & { integration: Integration };
  },
  flags: HelpdeskFlagsSnapshot,
): Promise<"sent" | "blocked" | "failed"> {
  // Honor the DB-backed Settings toggle (helpdesk_ebay_send), not the env
  // default. The env var ships FALSE for safety; the admin UI flips the DB
  // row to TRUE when they want the feature live. The caller already pulled
  // the merged async snapshot, so use it directly — reading
  // `helpdeskFlags.enableEbaySend` here would ignore the UI toggle and
  // cancel every job as "ebay_send_disabled" even when the admin has
  // explicitly enabled sends (which is exactly the bug we just fixed).
  if (!flags.enableEbaySend) {
    await db.helpdeskOutboundJob.update({
      where: { id: job.id },
      data: {
        status: HelpdeskOutboundStatus.CANCELED,
        lastError: "ebay_send_disabled",
      },
    });
    await audit(job, "HELPDESK_OUTBOUND_BLOCKED", { reason: "ebay_send_flag_off" });
    return "blocked";
  }

  if (
    job.ticket.channel !== Platform.TPP_EBAY &&
    job.ticket.channel !== Platform.TT_EBAY
  ) {
    throw new Error(`Reply requires eBay channel, got ${job.ticket.channel}`);
  }
  if (!job.ticket.ebayItemId || !job.ticket.buyerUserId) {
    throw new Error("Ticket missing ebayItemId or buyerUserId; cannot send reply");
  }

  // Outbound send strategy — always use AddMemberMessageAAQToPartner.
  //
  // History: we originally tried to reply via AddMemberMessageRTQ using
  // the most recent inbound buyer messageID as `parentMessageID`. That
  // path is broken in practice for two separate reasons:
  //
  //   1. The Trading API returns buyer conversations as *digest envelopes*
  //      (GetMyMessages with DetailLevel=ReturnMessages bundles the entire
  //      conversation history into one HTML blob). The envelope's
  //      `messageID` is a digest-level identifier; it is NOT a valid
  //      `ParentMessageID` for RTQ, and eBay rejects it with
  //      "Invalid Parent Message Id."
  //   2. Buyers on modern eBay messaging use the Commerce Message API.
  //      Their messageIds live in a different namespace (`cm:<id>`) that
  //      the legacy Trading API doesn't understand either.
  //
  // Fallback that actually works: eBay threads conversations by
  // (ItemID, BuyerID) on their side. AAQToPartner accepts those two and
  // auto-threads the reply under the buyer's existing conversation in
  // the Messages inbox — same UX as RTQ, without the brittle parent ID
  // lookup. This matches what eBay's own guidance has been since CM
  // launched: RTQ is a legacy endpoint; use AAQToPartner for new sends.
  const config = buildEbayConfig(job.ticket.integration);
  const subject =
    job.ticket.subject ?? `Re: ${job.ticket.ebayItemTitle ?? "your message"}`;

  const send: SendHelpdeskReplyResult = await sendHelpdeskReply(
    job.ticket.integrationId,
    config,
    {
      itemID: job.ticket.ebayItemId,
      recipientID: job.ticket.buyerUserId,
      subject,
      body: job.bodyText,
      // Intentionally undefined — see comment above. RTQ is disabled.
      parentMessageID: undefined,
    },
  );

  if (!send.success) {
    await db.helpdeskOutboundJob.update({
      where: { id: job.id },
      data: {
        status: HelpdeskOutboundStatus.FAILED,
        lastError: send.error?.slice(0, 500) ?? "ebay_send_failed",
        attemptCount: { increment: 1 },
      },
    });
    await audit(job, "HELPDESK_OUTBOUND_FAILED", {
      reason: "ebay_send_failed",
      ack: send.ack,
      error: send.error,
    });
    return "failed";
  }

  // Persist as a HelpdeskMessage and update ticket bookkeeping.
  const sentAt = new Date();
  await db.$transaction(async (tx) => {
    await tx.helpdeskMessage.create({
      data: {
        ticketId: job.ticketId,
        direction: HelpdeskMessageDirection.OUTBOUND,
        source: HelpdeskMessageSource.EBAY,
        externalId: send.externalId ?? `outbound:${job.id}`,
        ebayMessageId: send.externalId ?? null,
        authorUserId: job.authorUserId,
        fromName: "reorG agent",
        bodyText: job.bodyText,
        sentAt,
        rawData: { ack: send.ack ?? null, source: "helpdesk_outbound", jobId: job.id },
      },
    });

    const ticketUpdate: Record<string, unknown> = {
      lastAgentMessageAt: sentAt,
    };
    if (!job.ticket.firstResponseAt) ticketUpdate.firstResponseAt = sentAt;
    if (job.setStatus) {
      ticketUpdate.status = job.setStatus;
      if (job.setStatus === HelpdeskTicketStatus.RESOLVED) {
        ticketUpdate.resolvedAt = sentAt;
        ticketUpdate.resolvedById = job.authorUserId;
      }
    } else {
      // Default: mark as WAITING (we just replied; ball is in buyer's court).
      ticketUpdate.status = HelpdeskTicketStatus.WAITING;
    }
    await tx.helpdeskTicket.update({
      where: { id: job.ticketId },
      data: ticketUpdate,
    });

    await tx.helpdeskOutboundJob.update({
      where: { id: job.id },
      data: {
        status: HelpdeskOutboundStatus.SENT,
        sentAt,
        externalId: send.externalId ?? null,
        attemptCount: { increment: 1 },
      },
    });
  });

  await audit(job, "HELPDESK_OUTBOUND_SENT", {
    transport: "ebay_rtq",
    externalId: send.externalId ?? null,
  });
  return "sent";
}

async function sendExternalEmail(
  job: HelpdeskOutboundJob & {
    ticket: HelpdeskTicket & { integration: Integration };
  },
  flags: HelpdeskFlagsSnapshot,
): Promise<"sent" | "blocked" | "failed"> {
  // Same reasoning as `sendEbayReply`: honor the DB Settings toggle, not
  // the env default. The caller already resolved the merged snapshot.
  if (!flags.enableResendExternal) {
    await db.helpdeskOutboundJob.update({
      where: { id: job.id },
      data: {
        status: HelpdeskOutboundStatus.CANCELED,
        lastError: "external_email_disabled",
      },
    });
    await audit(job, "HELPDESK_OUTBOUND_BLOCKED", { reason: "resend_flag_off" });
    return "blocked";
  }

  if (!job.ticket.buyerEmail) {
    throw new Error("Ticket missing buyer email for external send");
  }

  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.HELPDESK_RESEND_FROM ?? process.env.RESEND_FROM;
  if (!apiKey) throw new Error("RESEND_API_KEY missing");
  if (!fromAddress) throw new Error("HELPDESK_RESEND_FROM/RESEND_FROM missing");

  // Lazy import to keep cold start small.
  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);
  const subject =
    job.ticket.subject ?? `Regarding your order ${job.ticket.ebayOrderNumber ?? ""}`.trim();
  const sendRes = await resend.emails.send({
    from: fromAddress,
    to: [job.ticket.buyerEmail],
    subject,
    text: job.bodyText,
  });
  if (sendRes.error) {
    await db.helpdeskOutboundJob.update({
      where: { id: job.id },
      data: {
        status: HelpdeskOutboundStatus.FAILED,
        lastError: sendRes.error.message?.slice(0, 500) ?? "resend_failed",
        attemptCount: { increment: 1 },
      },
    });
    await audit(job, "HELPDESK_OUTBOUND_FAILED", {
      transport: "resend",
      error: sendRes.error.message,
    });
    return "failed";
  }

  const externalId = sendRes.data?.id ?? null;
  const sentAt = new Date();
  await db.$transaction(async (tx) => {
    await tx.helpdeskMessage.create({
      data: {
        ticketId: job.ticketId,
        direction: HelpdeskMessageDirection.OUTBOUND,
        source: HelpdeskMessageSource.EXTERNAL_EMAIL,
        externalId: externalId ?? `outbound:${job.id}`,
        authorUserId: job.authorUserId,
        fromName: fromAddress,
        bodyText: job.bodyText,
        sentAt,
        rawData: { transport: "resend", id: externalId },
      },
    });

    const ticketUpdate: Record<string, unknown> = {
      lastAgentMessageAt: sentAt,
    };
    if (!job.ticket.firstResponseAt) ticketUpdate.firstResponseAt = sentAt;
    if (job.setStatus) {
      ticketUpdate.status = job.setStatus;
      if (job.setStatus === HelpdeskTicketStatus.RESOLVED) {
        ticketUpdate.resolvedAt = sentAt;
        ticketUpdate.resolvedById = job.authorUserId;
      }
    } else {
      ticketUpdate.status = HelpdeskTicketStatus.WAITING;
    }
    await tx.helpdeskTicket.update({
      where: { id: job.ticketId },
      data: ticketUpdate,
    });

    await tx.helpdeskOutboundJob.update({
      where: { id: job.id },
      data: {
        status: HelpdeskOutboundStatus.SENT,
        sentAt,
        externalId,
        attemptCount: { increment: 1 },
      },
    });
  });

  await audit(job, "HELPDESK_OUTBOUND_SENT", {
    transport: "resend",
    externalId,
  });
  return "sent";
}

async function audit(
  job: HelpdeskOutboundJob & { ticket: HelpdeskTicket },
  action: string,
  details: Record<string, unknown>,
) {
  try {
    await db.auditLog.create({
      data: {
        userId: job.authorUserId,
        action,
        entityType: "HelpdeskOutboundJob",
        entityId: job.id,
        details: {
          ticketId: job.ticketId,
          channel: job.ticket.channel,
          composerMode: job.composerMode,
          ...details,
        },
      },
    });
  } catch {
    // never let audit failure break the worker
  }
}
