import { NextResponse, type NextRequest } from "next/server";
import {
  HelpdeskMessageDirection,
  HelpdeskMessageSource,
  HelpdeskTicketStatus,
  type Prisma,
} from "@prisma/client";
import {
  Resend,
  type EmailReceivedEvent,
  type GetReceivingEmailResponseSuccess,
} from "resend";
import { db } from "@/lib/db";
import {
  findHelpdeskReplyRoute,
  helpdeskReplyDomainFromEnv,
  helpdeskReplySecretFromEnv,
  parseMailbox,
  stripQuotedEmailText,
} from "@/lib/helpdesk/external-email-routing";
import { deriveStatusOnInbound } from "@/lib/helpdesk/status-routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resendInboundApiKey() {
  return (
    process.env.HELPDESK_RESEND_INBOUND_API_KEY ??
    process.env.HELPDESK_RESEND_API_KEY ??
    process.env.RESEND_API_KEY ??
    null
  );
}

function resendWebhookSecret() {
  return (
    process.env.HELPDESK_RESEND_WEBHOOK_SECRET ??
    process.env.RESEND_WEBHOOK_SECRET ??
    null
  );
}

function externalIdForReceivedEmail(emailId: string) {
  return `resend:inbound:${emailId}`;
}

function allRecipients(email: GetReceivingEmailResponseSuccess): string[] {
  return [
    ...email.to,
    ...(email.cc ?? []),
    ...(email.bcc ?? []),
  ].filter((value) => value.trim().length > 0);
}

function bodyForEmail(email: GetReceivingEmailResponseSuccess): {
  bodyText: string;
  isHtml: boolean;
} {
  const text = email.text ? stripQuotedEmailText(email.text) : "";
  if (text) {
    return { bodyText: text, isHtml: false };
  }
  if (email.html) {
    return { bodyText: email.html, isHtml: true };
  }
  return { bodyText: "(No message body.)", isHtml: false };
}

function normalizeRawHeaders(
  headers: GetReceivingEmailResponseSuccess["headers"],
): Record<string, string> | null {
  if (!headers) return null;
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

export async function POST(request: NextRequest) {
  const apiKey = resendInboundApiKey();
  const webhookSecret = resendWebhookSecret();
  const routeSecret = helpdeskReplySecretFromEnv();
  const routeDomain = helpdeskReplyDomainFromEnv();

  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "HELPDESK_RESEND_INBOUND_API_KEY/HELPDESK_RESEND_API_KEY/RESEND_API_KEY is not configured.",
      },
      { status: 503 },
    );
  }
  if (!webhookSecret) {
    return NextResponse.json(
      { error: "HELPDESK_RESEND_WEBHOOK_SECRET/RESEND_WEBHOOK_SECRET is not configured." },
      { status: 503 },
    );
  }
  if (!routeSecret) {
    return NextResponse.json(
      { error: "HELPDESK_EMAIL_REPLY_SECRET/AUTH_SECRET is not configured." },
      { status: 503 },
    );
  }
  if (!routeDomain) {
    return NextResponse.json(
      { error: "HELPDESK_RESEND_REPLY_DOMAIN is not configured." },
      { status: 503 },
    );
  }

  const payload = await request.text();
  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!id || !timestamp || !signature) {
    return NextResponse.json({ error: "Missing Resend webhook signature headers." }, { status: 400 });
  }

  const resend = new Resend(apiKey);
  let event: EmailReceivedEvent;
  try {
    const verified = resend.webhooks.verify({
      payload,
      headers: { id, timestamp, signature },
      webhookSecret,
    });
    if (verified.type !== "email.received") {
      return NextResponse.json({ data: { ignored: true, type: verified.type } });
    }
    event = verified;
  } catch (error) {
    await db.auditLog.create({
      data: {
        action: "HELPDESK_RESEND_WEBHOOK_REJECTED",
        entityType: "HelpdeskWebhook",
        details: {
          reason: "invalid_signature",
          error: error instanceof Error ? error.message : String(error),
        },
      },
    });
    return NextResponse.json({ error: "Invalid Resend webhook signature." }, { status: 401 });
  }

  const { data: email, error: emailError } = await resend.emails.receiving.get(
    event.data.email_id,
  );
  if (emailError || !email) {
    throw new Error(
      `Failed to fetch Resend inbound email ${event.data.email_id}: ${
        emailError?.message ?? "missing email"
      }`,
    );
  }

  const recipients = allRecipients(email);
  const route = findHelpdeskReplyRoute({
    recipients,
    secret: routeSecret,
    domain: routeDomain,
  });
  if (!route) {
    await db.auditLog.create({
      data: {
        action: "HELPDESK_EXTERNAL_EMAIL_UNROUTED",
        entityType: "HelpdeskMessage",
        details: {
          provider: "resend",
          emailId: email.id,
          messageId: email.message_id,
          from: email.from,
          to: email.to,
          cc: email.cc,
          bcc: email.bcc,
          subject: email.subject,
          reason: "no_valid_helpdesk_reply_address",
        },
      },
    });
    return NextResponse.json({
      data: {
        ignored: true,
        reason: "no_valid_helpdesk_reply_address",
      },
    });
  }

  const sentAt = new Date(email.created_at);
  const from = parseMailbox(email.from);
  const body = bodyForEmail(email);
  const externalId = externalIdForReceivedEmail(email.id);
  const rawHeaders = normalizeRawHeaders(email.headers);

  const result = await db.$transaction(async (tx) => {
    const ticket = await tx.helpdeskTicket.findUnique({
      where: { id: route.ticketId },
      select: {
        id: true,
        status: true,
        isSpam: true,
        isArchived: true,
        snoozedUntil: true,
        snoozedById: true,
        lastAgentMessageAt: true,
        buyerEmail: true,
      },
    });

    if (!ticket) {
      await tx.auditLog.create({
        data: {
          action: "HELPDESK_EXTERNAL_EMAIL_UNROUTED",
          entityType: "HelpdeskTicket",
          entityId: route.ticketId,
          details: {
            provider: "resend",
            emailId: email.id,
            reason: "ticket_not_found",
            routedRecipient: route.address,
          },
        },
      });
      return { status: "ignored" as const, reason: "ticket_not_found" };
    }

    const existing = await tx.helpdeskMessage.findFirst({
      where: { ticketId: ticket.id, externalId },
      select: { id: true },
    });
    if (existing) {
      return { status: "duplicate" as const, messageId: existing.id };
    }

    const message = await tx.helpdeskMessage.create({
      data: {
        ticketId: ticket.id,
        direction: HelpdeskMessageDirection.INBOUND,
        source: HelpdeskMessageSource.EXTERNAL_EMAIL,
        externalId,
        fromName: from?.name ?? null,
        fromIdentifier: from?.address ?? email.from,
        subject: email.subject,
        bodyText: body.bodyText,
        isHtml: body.isHtml,
        rawMedia: email.attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          contentType: attachment.content_type,
          contentDisposition: attachment.content_disposition,
          contentId: attachment.content_id,
        })),
        rawData: {
          transport: "resend",
          emailId: email.id,
          providerMessageId: email.message_id,
          routedBy: "reply_to_address",
          routedRecipient: route.recipient,
          routedAddress: route.address,
          from: email.from,
          to: email.to,
          cc: email.cc,
          bcc: email.bcc,
          replyTo: email.reply_to,
          headers: rawHeaders,
          attachmentCount: email.attachments.length,
          buyerEmailMatched:
            from?.address && ticket.buyerEmail
              ? from.address === ticket.buyerEmail.toLowerCase()
              : null,
        },
        sentAt,
      },
    });

    const ticketUpdate: Prisma.HelpdeskTicketUpdateInput = {
      lastBuyerMessageAt: sentAt,
      unreadCount: { increment: 1 },
    };
    const nextStatus = deriveStatusOnInbound({
      status: ticket.status,
      hasAgentReplied: ticket.lastAgentMessageAt !== null,
      isArchived: ticket.isArchived,
      isSpam: ticket.isSpam,
    });
    if (nextStatus !== ticket.status) ticketUpdate.status = nextStatus;
    if (ticket.status === HelpdeskTicketStatus.RESOLVED) {
      ticketUpdate.reopenCount = { increment: 1 };
      ticketUpdate.lastReopenedAt = new Date();
    }
    if (ticket.isArchived && !ticket.isSpam) {
      ticketUpdate.isArchived = false;
      ticketUpdate.archivedAt = null;
    }
    if (ticket.snoozedUntil) {
      ticketUpdate.snoozedUntil = null;
      if (ticket.snoozedById) {
        ticketUpdate.snoozedBy = { disconnect: true };
      }
    }

    await tx.helpdeskTicket.update({
      where: { id: ticket.id },
      data: ticketUpdate,
    });

    await tx.auditLog.create({
      data: {
        action: "HELPDESK_EXTERNAL_EMAIL_RECEIVED",
        entityType: "HelpdeskMessage",
        entityId: message.id,
        details: {
          ticketId: ticket.id,
          provider: "resend",
          emailId: email.id,
          messageId: email.message_id,
          from: email.from,
          routedAddress: route.address,
          subject: email.subject,
        },
      },
    });

    return { status: "created" as const, messageId: message.id, ticketId: ticket.id };
  });

  return NextResponse.json({ data: result }, { status: 202 });
}
