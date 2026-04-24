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
import { buildEbayConfig } from "@/lib/services/helpdesk-ebay";
import {
  sendCommerceMessage,
  resolveConversationIdForBuyer,
} from "@/lib/services/helpdesk-commerce-message";

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
  if (!job.ticket.buyerUserId) {
    throw new Error("Ticket missing buyerUserId; cannot send reply");
  }

  // Outbound send strategy — use the Commerce Message API.
  //
  // History of failed attempts (do not resurrect any of these):
  //   1. AddMemberMessageRTQ with the inbound messageID as parentMessageID
  //      → eBay returns "Invalid Parent Message Id." because Trading API
  //      delivers buyer threads as digest envelopes whose messageID is
  //      not a valid RTQ parent, AND Commerce-Message-origin messages
  //      live in a different `cm:<id>` namespace Trading can't resolve.
  //   2. AddMemberMessageAAQToPartner (Trading API, parentless send)
  //      → works for post-transaction threads but fails with
  //      "The sender or recipient is not the partner of the transaction."
  //      on pre-sale inquiries — which is exactly the shape of most
  //      buyer-question tickets.
  //
  // What works for every case (pre-sale + post-sale): the Commerce
  // Message API `POST /send_message`. It accepts either:
  //   - `conversationId` (preferred — we've been storing
  //     `HelpdeskTicket.ebayConversationId` from the inbound sweep), or
  //   - `otherPartyUsername` (fallback — eBay will find/create the
  //     conversation for us).
  // We also pass `reference = { referenceId: <itemId>, referenceType:
  // LISTING }` so the message is threaded to the specific listing the
  // buyer asked about.
  const config = buildEbayConfig(job.ticket.integration);

  // Resolve conversationId on-demand when we don't already have one. This
  // covers tickets created before we started storing ebayConversationId
  // or those where the inbound sweep hasn't stamped one yet. Falls back
  // to `otherPartyUsername` if resolution fails.
  let conversationId: string | undefined = job.ticket.ebayConversationId ?? undefined;
  if (!conversationId) {
    try {
      const resolved = await resolveConversationIdForBuyer(
        job.ticket.integrationId,
        config,
        job.ticket.buyerUserId,
        { itemIdHint: job.ticket.ebayItemId ?? undefined },
      );
      conversationId = resolved.best?.conversationId;
      if (conversationId) {
        await db.helpdeskTicket.update({
          where: { id: job.ticketId },
          data: { ebayConversationId: conversationId },
        }).catch(() => undefined);
      }
    } catch {
      // Non-fatal — we'll fall back to otherPartyUsername on the send call.
    }
  }

  // Commerce Message API caps messageText at 2000 chars. Truncate with an
  // ellipsis so we never get silently rejected with errorId 355013.
  const MAX_MESSAGE_LEN = 2000;
  const messageText =
    job.bodyText.length <= MAX_MESSAGE_LEN
      ? job.bodyText
      : `${job.bodyText.slice(0, MAX_MESSAGE_LEN - 1).trimEnd()}…`;

  const send = await sendCommerceMessage(job.ticket.integrationId, config, {
    conversationId,
    otherPartyUsername: conversationId ? undefined : job.ticket.buyerUserId,
    messageText,
    referenceItemId: job.ticket.ebayItemId ?? undefined,
  });

  // If the CM send failed because we had a stale conversationId (eBay
  // sometimes renumbers or deletes threads), retry once using the
  // otherPartyUsername path so we don't lose a reply to a 400.
  let finalSend = send;
  if (!send.success && conversationId && !send.needsReauth) {
    const retry = await sendCommerceMessage(job.ticket.integrationId, config, {
      otherPartyUsername: job.ticket.buyerUserId,
      messageText,
      referenceItemId: job.ticket.ebayItemId ?? undefined,
    });
    if (retry.success) finalSend = retry;
    else finalSend = send; // keep the original error as the user-visible one
  }

  if (!finalSend.success) {
    const errDetail = finalSend.error
      ? `${finalSend.error}${finalSend.errorId ? ` (${finalSend.errorId})` : ""}`
      : `commerce_message_send_failed (http ${finalSend.status})`;
    await db.helpdeskOutboundJob.update({
      where: { id: job.id },
      data: {
        status: HelpdeskOutboundStatus.FAILED,
        lastError: errDetail.slice(0, 500),
        attemptCount: { increment: 1 },
      },
    });
    await audit(job, "HELPDESK_OUTBOUND_FAILED", {
      reason: "commerce_message_send_failed",
      transport: "ebay_cm",
      httpStatus: finalSend.status,
      errorId: finalSend.errorId,
      error: finalSend.error,
      needsReauth: finalSend.needsReauth,
    });
    return "failed";
  }

  // Persist as a HelpdeskMessage and update ticket bookkeeping.
  const sentAt = new Date();
  // Namespace the externalId with the same `cm:` prefix the inbound
  // Commerce-Message sweep uses. Two things fall out of this:
  //   1. The (ticketId, externalId) unique index blocks the sweep from
  //      inserting a duplicate row for the same message on its next pass
  //      — previously the sweep stored `cm:<id>` while we stored `<id>`,
  //      so the constraint never fired and we ended up with two OUTBOUND
  //      rows for a single send (one author-attributed, one anonymized).
  //   2. The read-time dedup in /api/helpdesk/tickets/[id] can treat
  //      this row as the canonical CM copy and hide the Trading-API
  //      digest echo.
  const externalId = finalSend.messageId
    ? `cm:${finalSend.messageId}`
    : `outbound:${job.id}`;
  // Stamp the actual agent's name so the thread bubble shows who
  // replied (e.g. "Adam Zinker") instead of the generic org label. The
  // ThreadView prefers `author.name` when present, but persisting the
  // name on the row keeps exports, audit projections, and any later
  // non-joined reads honest. Fall back to the legacy label for system-
  // authored sends where `authorUserId` is null.
  let fromName = "reorG agent";
  if (job.authorUserId) {
    const author = await db.user.findUnique({
      where: { id: job.authorUserId },
      select: { name: true, email: true },
    });
    fromName = author?.name ?? author?.email ?? fromName;
  }
  await db.$transaction(async (tx) => {
    await tx.helpdeskMessage.create({
      data: {
        ticketId: job.ticketId,
        direction: HelpdeskMessageDirection.OUTBOUND,
        // EBAY_UI because the message originated via Commerce Message API
        // (the same path buyers use in their web UI). This keeps the read-
        // time dedup in /api/helpdesk/tickets/[id] consistent: CM-bound
        // tickets filter out Trading-API duplicates, and outbound sends
        // slot into the same bucket. The "Sent directly on eBay" pill is
        // suppressed for this row in ThreadView because `authorUserId` is
        // set (i.e. a Help Desk agent composed it through our composer).
        source: HelpdeskMessageSource.EBAY_UI,
        externalId,
        ebayMessageId: finalSend.messageId ?? null,
        authorUserId: job.authorUserId,
        fromName,
        bodyText: messageText,
        sentAt,
        rawData: {
          transport: "ebay_cm",
          messageId: finalSend.messageId ?? null,
          source: "helpdesk_outbound",
          jobId: job.id,
        },
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
        externalId: finalSend.messageId ?? null,
        attemptCount: { increment: 1 },
      },
    });
  });

  await audit(job, "HELPDESK_OUTBOUND_SENT", {
    transport: "ebay_cm",
    externalId: finalSend.messageId ?? null,
    httpStatus: finalSend.status,
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
