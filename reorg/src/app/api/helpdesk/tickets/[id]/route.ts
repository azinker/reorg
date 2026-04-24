import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  HelpdeskOutboundStatus,
  HelpdeskTicketType,
  type Prisma,
} from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The ticket list prefetches this endpoint on row hover/focus to warm the
  // detail cache (see use-helpdesk.ts → prefetchTicket). Prefetch calls
  // append ?prefetch=1 so we can keep the response pure for hover but still
  // stamp audit "opened" rows on real clicks.
  const isPrefetch = request.nextUrl.searchParams.get("prefetch") === "1";

  const { id } = await params;
  const ticket = await db.helpdeskTicket.findUnique({
    where: { id },
    include: {
      integration: { select: { id: true, label: true, platform: true } },
      primaryAssignee: {
        select: { id: true, name: true, email: true, avatarUrl: true, handle: true },
      },
      additionalAssignees: {
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true, handle: true },
          },
        },
      },
      tags: { include: { tag: true } },
      messages: {
        orderBy: { sentAt: "asc" },
        include: {
          author: {
            select: { id: true, name: true, email: true, avatarUrl: true, handle: true },
          },
        },
      },
      notes: {
        where: { isDeleted: false },
        orderBy: { createdAt: "asc" },
        include: {
          author: {
            select: { id: true, name: true, email: true, avatarUrl: true, handle: true },
          },
        },
      },
      // Surface in-flight outbound jobs (the 5s undo window + any rows
      // currently being SENDING by the cron) so the thread can render an
      // immediate "Sending…" bubble. We deliberately exclude SENT (those
      // become real HelpdeskMessage rows on next sync) and CANCELED
      // (Undo'd by the agent — they don't want to see it).
      outboundJobs: {
        where: {
          status: {
            in: [
              HelpdeskOutboundStatus.PENDING,
              HelpdeskOutboundStatus.SENDING,
            ],
          },
        },
        orderBy: { createdAt: "asc" },
        include: {
          author: {
            select: { id: true, name: true, email: true, avatarUrl: true, handle: true },
          },
        },
      },
    },
  });

  if (!ticket) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // ── Digest envelope dedupe + image lift.
  //
  // eBay's GetMyMessages returns each "message" as a giant HTML *digest*
  // body that contains the entire conversation history embedded in
  // <div id="UserInputtedText[N]"> blocks. The sync writer inserts the
  // envelope as one HelpdeskMessage row AND then explodes each historical
  // sub-message into its own row tagged with `rawData.digestSource =
  // <envelope.ebayMessageId>`.
  //
  // Without filtering, the thread renders the envelope (the entire blob,
  // which after SafeHtml strips quoted content collapses to "(No new
  // message text — only quoted content from eBay.)") AND every sub-
  // message — making each buyer turn appear two or three times.
  //
  // Strategy: any envelope row whose `ebayMessageId` is referenced as
  // `rawData.digestSource` by another row on this ticket is redundant
  // and gets hidden. This runs in pure JS over the already-loaded
  // messages array — no extra DB roundtrip — and handles legacy data
  // without a backfill since the test is data-driven.
  //
  // BUT: when a buyer sends an image-only message via eBay's web inbox,
  // the digest envelope's `<div id="UserInputtedText">` is *empty* and
  // the actual image attachments live in `<td id="previewImageCont[N]">`
  // blocks elsewhere in the envelope HTML. Hiding the envelope erases
  // the images; the corresponding live sub-message has bodyText="" and
  // rawMedia=[] so it renders as an empty bubble.
  //
  // Lift fix: before hiding an envelope, scan its body for previewImage
  // URLs and stash them on the LIVE sub-message's rawMedia for the
  // response. The thread's `extractInlineImages` will then render them
  // in the live sub's bubble exactly where the buyer sent them.
  function extractPreviewImages(html: string): Array<{
    url: string;
    mimeType: string;
  }> {
    const out: Array<{ url: string; mimeType: string }> = [];
    if (!html) return out;
    // Each attachment renders as
    //   <td id="previewImageCont0" …><a …><span …><img id="previewimage0"
    //     src="https://i.ebayimg.com/…/$_0.JPG?…"></span></a></td>
    // We grab just the src and de-dupe on URL.
    const re =
      /<td[^>]*id="previewImageCont\d+"[\s\S]*?<img[^>]*src="(https:\/\/i\.ebayimg\.com\/[^"]+)"/gi;
    const seen = new Set<string>();
    let mt: RegExpExecArray | null;
    while ((mt = re.exec(html)) !== null) {
      const url = mt[1];
      if (!seen.has(url)) {
        seen.add(url);
        // eBay only attaches JPG/PNG raster previews. Use a generic
        // image/* mime so extractInlineImages picks them up.
        out.push({ url, mimeType: "image/jpeg" });
      }
    }
    return out;
  }

  const digestSourceIds = new Set<string>();
  // envelope.ebayMessageId → array of buyer-uploaded image attachments
  const envelopeImages = new Map<
    string,
    Array<{ url: string; mimeType: string }>
  >();
  // envelope.ebayMessageId → identity / source metadata that the digest
  // parser drops when exploding the sub-message. We re-project these
  // onto the visible SUB at read time so the timeline shows the right
  // sender chip and the "Sent directly on eBay" pill for EBAY_UI sends.
  // Without this every exploded SUB inherits source=EBAY and
  // fromName=null (the parser's safe defaults for unknown turns) which
  // makes agent eBay-UI replies look anonymous.
  type EnvelopeMeta = {
    source: (typeof ticket.messages)[number]["source"];
    fromName: string | null;
    fromIdentifier: string | null;
    author: (typeof ticket.messages)[number]["author"];
  };
  const envelopeMeta = new Map<string, EnvelopeMeta>();
  for (const m of ticket.messages) {
    const raw = m.rawData as Record<string, unknown> | null;
    const src =
      raw && typeof raw["digestSource"] === "string"
        ? (raw["digestSource"] as string)
        : null;
    if (src) digestSourceIds.add(src);
  }
  for (const m of ticket.messages) {
    const raw = m.rawData as Record<string, unknown> | null;
    const isExplodedSub =
      raw && typeof raw["digestSource"] === "string";
    if (isExplodedSub) continue;
    if (m.ebayMessageId && digestSourceIds.has(m.ebayMessageId)) {
      const imgs = extractPreviewImages(m.bodyText ?? "");
      if (imgs.length > 0) {
        envelopeImages.set(m.ebayMessageId, imgs);
      }
      envelopeMeta.set(m.ebayMessageId, {
        source: m.source,
        fromName: m.fromName,
        fromIdentifier: m.fromIdentifier,
        author: m.author,
      });
    }
  }

  // Mutate visible-sub rawMedia in-memory so the response carries the
  // images. We deliberately do NOT persist this back to the DB — the
  // envelope row still has the canonical HTML; we just project it onto
  // the visible sub at read time.
  //
  // CRITICAL: eBay's digest envelopes are CUMULATIVE — every envelope
  // re-embeds the prior conversation, including the prior `previewImage
  // ContN` blocks. Naively attaching each envelope's images to its own
  // live sub means a single buyer-uploaded image appears in EVERY
  // subsequent message's bubble (3 images → 6 → 9 → …).
  //
  // Dedupe strategy: walk live subs in chronological order, keep a
  // ticket-wide set of image URLs already seen, and only attach a URL
  // to the FIRST live sub where it appears. This pins the images to
  // the message turn where the buyer actually uploaded them and
  // eliminates duplicates downstream.
  type MessageRow = (typeof ticket.messages)[number];
  const visibleMessages: MessageRow[] = ticket.messages.filter((m) => {
    const raw = m.rawData as Record<string, unknown> | null;
    const isExplodedSub =
      raw && typeof raw["digestSource"] === "string";
    if (isExplodedSub) return true;
    if (m.ebayMessageId && digestSourceIds.has(m.ebayMessageId)) {
      return false;
    }
    return true;
  });

  const seenImageUrls = new Set<string>();
  const finalMessages: MessageRow[] = visibleMessages
    .slice()
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
    .map<MessageRow>((m) => {
      const raw = m.rawData as Record<string, unknown> | null;
      const src =
        raw && typeof raw["digestSource"] === "string"
          ? (raw["digestSource"] as string)
          : null;
      const isLiveSub = raw && raw["isLive"] === true;
      if (!src || !isLiveSub) return m;

      // Two projections happen here, both keyed off the parent envelope
      // we hid above:
      //   1. Identity (source/fromName/...) — fixes "agent eBay-UI sends
      //      look anonymous" and gates the "Sent directly on eBay" pill.
      //   2. Image attachments — pins buyer-uploaded photos to the first
      //      live sub they appear in (cumulative-envelope dedupe).
      const meta = envelopeMeta.get(src);
      let projected: MessageRow = m;
      if (meta && meta.source === "EBAY_UI") {
        // Only project EBAY_UI; leave EBAY/EMAIL/etc. alone so we don't
        // overwrite a sub that legitimately knows its own source.
        projected = {
          ...projected,
          source: meta.source,
          fromName: projected.fromName ?? meta.fromName,
          fromIdentifier: projected.fromIdentifier ?? meta.fromIdentifier,
          author: projected.author ?? meta.author,
        };
      }

      const imgs = envelopeImages.get(src);
      if (!imgs || imgs.length === 0) return projected;
      // Filter out images already attached to an earlier live sub.
      const fresh = imgs.filter((i) => {
        if (seenImageUrls.has(i.url)) return false;
        seenImageUrls.add(i.url);
        return true;
      });
      if (fresh.length === 0) return projected;
      const existing: Prisma.JsonValue[] = Array.isArray(projected.rawMedia)
        ? (projected.rawMedia as Prisma.JsonArray)
        : [];
      const merged = [
        ...existing,
        ...fresh.map((i) => i as unknown as Prisma.JsonValue),
      ] as Prisma.JsonValue;
      return { ...projected, rawMedia: merged };
    });

  // NOTE: this GET endpoint is intentionally side-effect-free w.r.t. read
  // state. The ticket list UI fires this same endpoint from `onMouseEnter`
  // (see use-helpdesk.ts → prefetchTicket → TicketList onMouseEnter/onFocus)
  // to warm the cache before a click, so marking-read here would mean every
  // hover of a row silently marks its ticket read AND pushes read=true to
  // eBay via mirrorReadStateToEbay — surfacing as "tickets went read on
  // eBay without an agent actually opening them". The explicit click path
  // (`loadSelected` in use-helpdesk.ts) already owns the mark-as-read
  // contract by POSTing to /api/helpdesk/tickets/batch with action=markRead,
  // which is the ONLY path allowed to mirror read-state to eBay.

  // Stamp a "ticket opened" audit row so the reader timeline can show
  // "Adam opened the ticket". Two-part dedupe so the timeline stays clean
  // even when an agent revisits the same ticket many times in a day:
  //
  //   1. Hard debounce: never write more than one open per (agent, ticket)
  //      within a 30-minute window. The Help Desk hook auto-refreshes the
  //      currently selected ticket every 30 seconds; without this the
  //      timeline would gain a fresh row every minute of viewing.
  //
  //   2. Activity gate: skip writing if the agent has opened this ticket
  //      before AND nothing has happened on the ticket since their last
  //      open (no new buyer/agent message, no note, no other audit row,
  //      no status change). Re-opening a ticket the agent already saw
  //      with no new activity isn't useful timeline noise — it just
  //      means they came back to look. We still let the read-state
  //      logic above clear unreadCount, and we still serve the ticket;
  //      we just don't stamp another "opened" event.
  //
  // Cheap lookup — uses the (entityType, entityId) audit_logs index.
  // Prefetch (hover/focus) never stamps — otherwise moving the cursor
  // across a dozen rows would create a dozen "opened by Adam" timeline
  // rows. Only explicit clicks (which load without ?prefetch=1) stamp.
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60_000);
  const recentOpen = isPrefetch
    ? ({ id: "prefetch-skip" } as const)
    : await db.auditLog.findFirst({
        where: {
          action: "HELPDESK_TICKET_OPENED",
          entityType: "HelpdeskTicket",
          entityId: ticket.id,
          userId: session.user.id,
          createdAt: { gte: thirtyMinutesAgo },
        },
        select: { id: true },
      });
  if (!recentOpen) {
    // Find the most recent prior open by this agent (any time).
    const lastOpen = await db.auditLog.findFirst({
      where: {
        action: "HELPDESK_TICKET_OPENED",
        entityType: "HelpdeskTicket",
        entityId: ticket.id,
        userId: session.user.id,
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    let shouldStamp = true;
    if (lastOpen) {
      // Activity gate: only stamp if SOMETHING new happened on this
      // ticket since the previous open. We check the ticket's
      // updatedAt (covers status changes, assignment, tag changes,
      // unreadCount bumps from new messages) — that's denormalized
      // for exactly this kind of cheap "anything changed?" probe.
      shouldStamp = ticket.updatedAt > lastOpen.createdAt;
    }

    if (shouldStamp) {
      await db.auditLog.create({
        data: {
          userId: session.user.id,
          action: "HELPDESK_TICKET_OPENED",
          entityType: "HelpdeskTicket",
          entityId: ticket.id,
          details: {},
        },
      });
    }
  }

  // ── Listing enrichment.
  //
  // When the buyer is messaging from a specific listing (eBay sets
  // ItemID on every "Ask seller a question" / "Contact buyer" send) we
  // hydrate the ticket detail with the matching MarketplaceListing so
  // the right rail can render a "Product Inquiry" card with title +
  // SKU + thumbnail + a deep link back to the eBay listing.
  //
  // Pre-sales tickets need this most — there's no order context to fall
  // back on, so without this the right rail just shows the buyer card
  // and nothing about *what* they're asking about. Post-sales tickets
  // already get richer line-item data from the order-context endpoint;
  // we still populate this as a fallback for cases where eBay returns
  // no order detail (rare but happens during sandbox / partial syncs).
  //
  // Lookup keys off (integrationId, platformItemId) which has a unique
  // constraint per variant. We prefer the parent variation row
  // (platformVariantId=null) so the card shows a representative title
  // and image rather than a single child variant.
  let listingInfo: {
    itemId: string;
    sku: string | null;
    title: string | null;
    imageUrl: string | null;
  } | null = null;
  if (ticket.ebayItemId) {
    const listing = await db.marketplaceListing.findFirst({
      where: {
        integrationId: ticket.integration.id,
        platformItemId: ticket.ebayItemId,
      },
      orderBy: [{ platformVariantId: "asc" }],
      select: {
        platformItemId: true,
        sku: true,
        title: true,
        imageUrl: true,
      },
    });
    if (listing) {
      listingInfo = {
        itemId: listing.platformItemId,
        sku: listing.sku ?? null,
        title: listing.title ?? ticket.ebayItemTitle ?? null,
        imageUrl: listing.imageUrl ?? null,
      };
    } else {
      // No internal MarketplaceListing match (item not in our catalog,
      // or sync hasn't touched it yet). Fall back to whatever the
      // ticket itself recorded so the card can still render a title +
      // eBay link — just without SKU or thumbnail.
      listingInfo = {
        itemId: ticket.ebayItemId,
        sku: null,
        title: ticket.ebayItemTitle ?? null,
        imageUrl: null,
      };
    }
  }

  // Shape the response so it matches HelpdeskTicketSummary plus messages/notes.
  return NextResponse.json({
    data: {
      id: ticket.id,
      channel: ticket.channel,
      integrationLabel: ticket.integration.label,
      threadKey: ticket.threadKey,
      buyerUserId: ticket.buyerUserId,
      buyerName: ticket.buyerName,
      buyerEmail: ticket.buyerEmail,
      ebayItemId: ticket.ebayItemId,
      ebayItemTitle: ticket.ebayItemTitle,
      ebayOrderNumber: ticket.ebayOrderNumber,
      subject: ticket.subject,
      kind: ticket.kind,
      type: ticket.type,
      typeOverridden: ticket.typeOverridden,
      status: ticket.status,
      isSpam: ticket.isSpam,
      isArchived: ticket.isArchived,
      isFavorite: ticket.isFavorite,
      isImportant: ticket.isImportant,
      snoozedUntil: ticket.snoozedUntil,
      primaryAssignee: ticket.primaryAssignee,
      unreadCount: 0,
      lastBuyerMessageAt: ticket.lastBuyerMessageAt,
      lastAgentMessageAt: ticket.lastAgentMessageAt,
      firstResponseAt: ticket.firstResponseAt,
      reopenCount: ticket.reopenCount,
      messageCount: finalMessages.length,
      noteCount: ticket.notes.length,
      tags: ticket.tags.map((tt) => ({
        id: tt.tag.id,
        name: tt.tag.name,
        color: tt.tag.color,
      })),
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      messages: finalMessages,
      notes: ticket.notes,
      pendingOutboundJobs: ticket.outboundJobs.map((job) => ({
        id: job.id,
        composerMode: job.composerMode,
        bodyText: job.bodyText,
        status: job.status,
        scheduledAt: job.scheduledAt,
        createdAt: job.createdAt,
        // lastError is set by the cron worker if a send hit a transient
        // failure or a write lock. Surfacing it here lets the thread
        // bubble show "Send blocked: <reason>" instead of an indefinite
        // sending spinner.
        willBlockReason: job.lastError ?? null,
        author: job.author,
      })),
      additionalAssignees: ticket.additionalAssignees,
      listingInfo,
    },
  });
}

/**
 * Per-ticket partial update for the new triage controls in the ticket
 * header bar. Each field is optional — agents can call this with just the
 * one thing they changed (e.g. picking a Type from the dropdown).
 *
 *   - `type`        sets the ticket type AND flips `typeOverridden=true` so
 *                   the inbound auto-detector won't silently undo the choice
 *                   on a later message.
 *   - `isFavorite`  shared favorite (any agent can toggle it for the team).
 *   - `isImportant` row-badge flag in the inbox; pure visual hint.
 *
 * Each successful change writes a per-ticket audit row so the reader
 * timeline shows who flipped what. We deliberately do NOT attempt to write
 * to eBay for any of these fields — they're internal triage state only.
 */
const patchSchema = z
  .object({
    type: z.nativeEnum(HelpdeskTicketType).optional(),
    isFavorite: z.boolean().optional(),
    isImportant: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.type !== undefined ||
      v.isFavorite !== undefined ||
      v.isImportant !== undefined,
    { message: "At least one field is required" },
  );

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const json = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const data: Record<string, unknown> = {};
  const auditEntries: Array<{ action: string; details: object }> = [];

  if (parsed.data.type !== undefined) {
    data.type = parsed.data.type;
    data.typeOverridden = true;
    auditEntries.push({
      action: "HELPDESK_TICKET_TYPE_CHANGED",
      details: { type: parsed.data.type },
    });
  }
  if (parsed.data.isFavorite !== undefined) {
    data.isFavorite = parsed.data.isFavorite;
    auditEntries.push({
      action: "HELPDESK_TICKET_FAVORITE_TOGGLED",
      details: { isFavorite: parsed.data.isFavorite },
    });
  }
  if (parsed.data.isImportant !== undefined) {
    data.isImportant = parsed.data.isImportant;
    auditEntries.push({
      action: "HELPDESK_TICKET_IMPORTANT_TOGGLED",
      details: { isImportant: parsed.data.isImportant },
    });
  }

  const updated = await db.helpdeskTicket.update({
    where: { id },
    data,
    select: {
      id: true,
      type: true,
      typeOverridden: true,
      isFavorite: true,
      isImportant: true,
    },
  });

  if (auditEntries.length > 0) {
    await db.auditLog.createMany({
      data: auditEntries.map((e) => ({
        userId: session.user!.id!,
        action: e.action,
        entityType: "HelpdeskTicket",
        entityId: id,
        details: e.details,
      })),
    });
  }

  return NextResponse.json({ data: updated });
}
