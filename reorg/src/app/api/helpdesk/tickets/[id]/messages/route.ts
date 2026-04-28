/**
 * POST /api/helpdesk/tickets/[id]/messages
 *
 * Enqueue a HelpdeskOutboundJob for an eBay reply or external email.
 * The job is held for `sendDelaySeconds` (default 5) so the agent can hit Undo
 * via DELETE /api/helpdesk/outbound/[jobId] before it actually fires.
 *
 * Safety: This route NEVER touches the marketplace directly. The cron worker
 * picks up the job and executes the send only if all feature flags are set.
 */

import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  HelpdeskComposerMode,
  HelpdeskOutboundStatus,
  HelpdeskTicketStatus,
} from "@prisma/client";
import { helpdeskFlagsSnapshotAsync } from "@/lib/helpdesk/flags";
import {
  extractMentionHandles,
  resolveMentions,
  fanOutMentionNotifications,
} from "@/lib/helpdesk/mentions";
import {
  MAX_EBAY_IMAGE_ATTACHMENTS,
  inferEbayImageMimeType,
  normalizeAttachmentFileName,
  validateEbayImageAttachment,
  type QueuedHelpdeskAttachment,
} from "@/lib/helpdesk/outbound-attachments";
import { isR2Configured, putR2Object } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  composerMode: z.enum(["REPLY", "NOTE", "EXTERNAL"]),
  bodyText: z.string().trim().min(1).max(10_000),
  sendDelaySeconds: z.coerce.number().int().min(0).max(60).default(5),
  setStatus: z.enum(["WAITING", "RESOLVED"]).optional(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const contentType = request.headers.get("content-type") ?? "";
  let attachmentFiles: File[] = [];
  const body = contentType.includes("multipart/form-data")
    ? await request.formData().then((form) => {
        attachmentFiles = form.getAll("attachments").filter(isFile);
        return {
          composerMode: form.get("composerMode"),
          bodyText: form.get("bodyText"),
          sendDelaySeconds: form.get("sendDelaySeconds"),
          setStatus: form.get("setStatus") || undefined,
        };
      }).catch(() => null)
    : await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const ticket = await db.helpdeskTicket.findUnique({ where: { id } });
  if (!ticket) {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }

  const flags = await helpdeskFlagsSnapshotAsync();
  const queuedAttachments =
    attachmentFiles.length > 0
      ? await queueAttachmentsOrResponse({
          ticketId: id,
          composerMode: parsed.data.composerMode,
          files: attachmentFiles,
          attachmentsEnabled: flags.enableAttachments,
        })
      : [];
  if (queuedAttachments instanceof Response) return queuedAttachments;

  // Archived + outbound (REPLY / EXTERNAL) path: un-archive on send.
  //
  // Per user decision `unarchive_waiting`, sending an outbound reply from an
  // archived ticket (the common case is an AR-only archived ticket the
  // agent decided to proactively message the buyer on) pulls the ticket
  // BACK into the working queue instead of blocking. Archive becomes a
  // "workflow-empty" state rather than a hard quarantine — exactly what the
  // user asked for: the ticket "will either be sent + mark as resolved or
  // send + mark as waiting".
  //
  // Notes on archived tickets are still fine — they stay archived, because
  // a note is internal-only and doesn't change the external conversation
  // state.
  const wasArchived =
    ticket.isArchived &&
    parsed.data.composerMode !== HelpdeskComposerMode.NOTE;
  if (wasArchived) {
    // Default to WAITING when the agent didn't pick a status explicitly.
    // The typical archived outbound path is "I want to send the buyer a
    // proactive message" — we're now waiting on the buyer to reply, which
    // is exactly WAITING. If the agent explicitly picks RESOLVED we honor
    // that; the worker will re-apply setStatus after the send succeeds but
    // writing it now makes the inbox reflect the change immediately.
    const unarchiveStatus =
      parsed.data.setStatus === "RESOLVED"
        ? HelpdeskTicketStatus.RESOLVED
        : HelpdeskTicketStatus.WAITING;
    await db.helpdeskTicket.update({
      where: { id },
      data: {
        isArchived: false,
        archivedAt: null,
        status: unarchiveStatus,
      },
    });
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        action: "HELPDESK_TICKET_UNARCHIVED_ON_SEND",
        entityType: "HelpdeskTicket",
        entityId: id,
        details: {
          reason: "outbound_reply_from_archived",
          newStatus: unarchiveStatus,
          composerMode: parsed.data.composerMode,
        },
      },
    });
  }

  // Note path: write directly. Notes never queue.
  if (parsed.data.composerMode === "NOTE") {
    const handles = extractMentionHandles(parsed.data.bodyText);
    const mention = await resolveMentions(handles);
    const note = await db.helpdeskNote.create({
      data: {
        ticketId: id,
        authorUserId: session.user.id,
        bodyText: parsed.data.bodyText,
        mentions: mention.matched.map((m) => ({
          handle: m.handle,
          userId: m.userId,
        })),
      },
    });
    const fanOut = await fanOutMentionNotifications({
      ticketId: id,
      noteId: note.id,
      authorUserId: session.user.id,
      body: parsed.data.bodyText,
      matched: mention.matched,
    });
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        action: "HELPDESK_NOTE_CREATED",
        entityType: "HelpdeskNote",
        entityId: note.id,
        details: {
          ticketId: id,
          mentionsMatched: mention.matched.length,
          mentionsUnmatched: mention.unmatched.length,
          notificationsCreated: fanOut.created,
        },
      },
    });
    return NextResponse.json({
      data: {
        kind: "note",
        id: note.id,
        mentionsMatched: mention.matched.length,
        notificationsCreated: fanOut.created,
      },
    });
  }

  // Outbound paths: enqueue with send delay.
  const scheduledAt = new Date(Date.now() + parsed.data.sendDelaySeconds * 1000);
  const setStatus =
    parsed.data.setStatus === "RESOLVED"
      ? HelpdeskTicketStatus.RESOLVED
      : parsed.data.setStatus === "WAITING"
        ? HelpdeskTicketStatus.WAITING
        : null;

  // Pre-flight visibility for the agent: if a feature flag is off we still
  // accept the job (the worker will mark it CANCELED) — the response includes
  // a `willBlock` warning so the UI can show a banner. We use the ASYNC
  // snapshot so the global write lock (Settings → Write Safety) participates
  // in the safe-mode signal — agents see the banner the moment Cory or
  // Adam flips the lock.
  const willBlockReason: string | null = flags.safeMode
    ? flags.globalWriteLock
      ? "global_write_lock"
      : "safe_mode"
    : parsed.data.composerMode === "REPLY" && !flags.enableEbaySend
      ? "ebay_send_disabled"
      : parsed.data.composerMode === "EXTERNAL" && !flags.enableResendExternal
        ? "external_email_disabled"
        : null;

  const job = await db.helpdeskOutboundJob.create({
    data: {
      ticketId: id,
      authorUserId: session.user.id,
      composerMode: parsed.data.composerMode as HelpdeskComposerMode,
      bodyText: parsed.data.bodyText,
      scheduledAt,
      setStatus,
      status: HelpdeskOutboundStatus.PENDING,
      metadata: {
        previousTicketStatus: ticket.status,
        previousResolvedAt: ticket.resolvedAt?.toISOString() ?? null,
        previousResolvedById: ticket.resolvedById,
        previousIsArchived: ticket.isArchived,
        previousArchivedAt: ticket.archivedAt?.toISOString() ?? null,
        attachments: queuedAttachments,
      },
    },
  });

  if (!wasArchived && setStatus) {
    await db.helpdeskTicket.update({
      where: { id },
      data: {
        status: setStatus,
        ...(setStatus === HelpdeskTicketStatus.RESOLVED
          ? { resolvedAt: new Date(), resolvedById: session.user.id }
          : { resolvedAt: null, resolvedById: null }),
      },
    });
  }

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HELPDESK_OUTBOUND_QUEUED",
      entityType: "HelpdeskOutboundJob",
      entityId: job.id,
      details: {
        ticketId: id,
        composerMode: parsed.data.composerMode,
        scheduledAt: scheduledAt.toISOString(),
        optimisticStatus: setStatus,
        willBlockReason,
        attachmentCount: queuedAttachments.length,
      },
    },
  });

  return NextResponse.json({
    data: {
      kind: "outbound_job",
      id: job.id,
      scheduledAt: scheduledAt.toISOString(),
      willBlockReason,
    },
  });
}

function isFile(value: FormDataEntryValue): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

async function queueAttachmentsOrResponse(args: {
  ticketId: string;
  composerMode: "REPLY" | "NOTE" | "EXTERNAL";
  files: File[];
  attachmentsEnabled: boolean;
}): Promise<QueuedHelpdeskAttachment[] | Response> {
  if (args.composerMode !== "REPLY") {
    return NextResponse.json(
      { error: "Attachments are only available for eBay replies." },
      { status: 400 },
    );
  }
  if (!args.attachmentsEnabled) {
    return NextResponse.json(
      { error: "Outbound attachments are disabled." },
      { status: 403 },
    );
  }
  if (!isR2Configured()) {
    return NextResponse.json(
      { error: "Attachment storage is not configured." },
      { status: 500 },
    );
  }
  if (args.files.length > MAX_EBAY_IMAGE_ATTACHMENTS) {
    return NextResponse.json(
      { error: `eBay allows up to ${MAX_EBAY_IMAGE_ATTACHMENTS} images per reply.` },
      { status: 400 },
    );
  }

  const validated = args.files.map((file) => {
    const fileName = normalizeAttachmentFileName(file.name);
    const mimeType = inferEbayImageMimeType(fileName, file.type);
    const validation = validateEbayImageAttachment({
      fileName,
      mimeType,
      sizeBytes: file.size,
    });
    return { file, fileName, mimeType, validation };
  });
  const invalid = validated.find((entry) => entry.validation);
  if (invalid?.validation) {
    return NextResponse.json({ error: invalid.validation }, { status: 400 });
  }

  const queued: QueuedHelpdeskAttachment[] = [];
  for (const entry of validated) {
    const storageKey = `helpdesk/outbound/${args.ticketId}/${randomUUID()}-${entry.fileName}`;
    const bytes = new Uint8Array(await entry.file.arrayBuffer());
    await putR2Object(storageKey, bytes, { contentType: entry.mimeType });
    queued.push({
      storageKey,
      fileName: entry.fileName,
      mimeType: entry.mimeType,
      sizeBytes: entry.file.size,
    });
  }

  return queued;
}
