import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  HelpdeskOutboundStatus,
  HelpdeskTicketType,
  type Prisma,
} from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  envelopeStubBody,
  extractEnvelopePreviewImages,
} from "@/lib/helpdesk/html-clean";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function externalEmailMetaForMessage(message: {
  source: string;
  fromIdentifier: string | null;
  rawData: Prisma.JsonValue;
}) {
  if (message.source !== "EXTERNAL_EMAIL") return null;
  const raw = asRecord(message.rawData);
  return {
    from: stringOrNull(raw?.from) ?? message.fromIdentifier ?? null,
    to: stringArray(raw?.to),
    cc: stringArray(raw?.cc),
    bcc: stringArray(raw?.bcc),
    replyTo: stringOrNull(raw?.replyTo),
  };
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
  const recentOutboundErrorCutoff = new Date(Date.now() - 48 * 60 * 60_000);
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
      // Surface in-flight outbound jobs plus recent failures so the thread
      // can render queued/sending/failed feedback. SENT rows become real
      // HelpdeskMessage rows on the next sync, so they stay out of this list.
      outboundJobs: {
        where: {
          OR: [
            {
              status: {
                in: [
                  HelpdeskOutboundStatus.PENDING,
                  HelpdeskOutboundStatus.SENDING,
                ],
              },
            },
            {
              status: {
                in: [
                  HelpdeskOutboundStatus.FAILED,
                  HelpdeskOutboundStatus.CANCELED,
                ],
              },
              updatedAt: { gte: recentOutboundErrorCutoff },
            },
          ],
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
      const imgs = extractEnvelopePreviewImages(m.bodyText ?? "");
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
  // ── Commerce-Message vs Trading-API dedupe.
  //
  // Once a ticket is bound to an eBay Commerce Message conversation, the
  // sweep ingests every message with externalId = `cm:<messageId>` and
  // source = EBAY_UI. Those rows are the canonical copy — they carry the
  // real per-message ID, the true sent time, and the correct direction.
  //
  // The Trading-API digest path *also* ingests the same messages (as a
  // digest envelope plus an exploded `:live` / `:N` sub-message), which
  // is what the agent sees twice in the thread: once as "Buyer — no pill"
  // and a second time 30s later as "Buyer (via eBay)" (or the agent-side
  // pair, where the second copy carries the amber "Sent directly on eBay"
  // badge). Both copies are the SAME physical message.
  //
  // Strategy: build a set of (direction, normalized-body) keys from every
  // CM-origin row on this ticket, then hide any Trading-origin exploded
  // sub whose (direction, normalized-body) matches. We keep the CM row
  // because it has the correct identity/timestamps. Envelope rows are
  // already hidden by the `digestSourceIds` rule above.
  //
  // Normalization is plain-text, whitespace-collapsed, lowercased — the
  // same shape both paths store ultimately carries, but eBay occasionally
  // round-trips HTML/plain differently between the two APIs so we can't
  // trust raw string equality. This local normalizer is intentionally
  // cheap — we don't import the digest parser's cyrb53 hasher because
  // a substring compare on a single ticket's message set is O(n²) of
  // n≈30 at worst.
  function normalizeBodyForDedup(body: string | null | undefined): string {
    if (!body) return "";
    return body
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }
  const cmBodyKeys = new Set<string>();
  for (const m of ticket.messages) {
    const extId = m.externalId ?? "";
    if (!extId.startsWith("cm:")) continue;
    const body = normalizeBodyForDedup(m.bodyText);
    if (!body) continue;
    cmBodyKeys.add(`${m.direction}::${body}`);
  }

  function rawMediaArray(rawMedia: Prisma.JsonValue): Prisma.JsonValue[] {
    return Array.isArray(rawMedia) ? (rawMedia as Prisma.JsonArray) : [];
  }

  function rawMediaUrl(item: Prisma.JsonValue): string | null {
    if (typeof item === "string") return item.replace(/&amp;/gi, "&");
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const obj = item as Record<string, unknown>;
    const url =
      typeof obj.url === "string"
        ? obj.url
        : typeof obj.URL === "string"
          ? obj.URL
          : typeof obj.MediaURL === "string"
            ? obj.MediaURL
            : typeof obj.mediaUrl === "string"
              ? obj.mediaUrl
              : typeof obj.mediaURL === "string"
                ? obj.mediaURL
                : typeof obj.href === "string"
                  ? obj.href
                  : typeof obj.downloadUrl === "string"
                    ? obj.downloadUrl
                    : null;
    return url ? url.replace(/&amp;/gi, "&") : null;
  }

  function mergeRawMedia(
    existing: Prisma.JsonValue,
    additions: Prisma.JsonValue[] | undefined,
  ): Prisma.JsonValue {
    if (!additions || additions.length === 0) return existing;
    const existingArray = rawMediaArray(existing);
    const seen = new Set(
      existingArray
        .map((item) => rawMediaUrl(item))
        .filter((url): url is string => Boolean(url)),
    );
    const fresh = additions.filter((item) => {
      const url = rawMediaUrl(item);
      if (!url) return false;
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
    if (fresh.length === 0) return existing;
    return [...existingArray, ...fresh] as Prisma.JsonValue;
  }

  // If a Commerce-Message row is the canonical visible copy but a hidden
  // Trading-API exploded sub carries the image media, lift those images
  // onto the CM row at read time. This preserves CM's better timestamps
  // and identity while still showing buyer-uploaded photos.
  const hiddenTradingMediaByCmKey = new Map<string, Prisma.JsonValue[]>();
  for (const m of ticket.messages) {
    const raw = m.rawData as Record<string, unknown> | null;
    const isExplodedSub =
      raw && typeof raw["digestSource"] === "string";
    if (!isExplodedSub) continue;
    const body = normalizeBodyForDedup(m.bodyText);
    if (!body) continue;
    const key = `${m.direction}::${body}`;
    if (!cmBodyKeys.has(key)) continue;
    const media = rawMediaArray(m.rawMedia);
    if (media.length === 0) continue;
    const existing = hiddenTradingMediaByCmKey.get(key) ?? [];
    hiddenTradingMediaByCmKey.set(
      key,
      mergeRawMedia(existing as Prisma.JsonValue, media) as Prisma.JsonValue[],
    );
  }

  // Body sentinel the Trading-API sync writes into an envelope row AFTER
  // its sub-messages are extracted and lifted (see
  // helpdesk-ebay-sync.ts → `envelopeStubBody()`). The envelope carries
  // no content of its own after stripping — it's just a placeholder — so
  // we should never show it in the thread. The digestSourceIds rule
  // below USUALLY hides it, but there's a narrow race: if every sub a
  // digest would have produced already exists on the ticket (e.g. our
  // own CM-API outbound row is on the ticket with the same body hash),
  // the parser skips inserting any subs, and the envelope's
  // `ebayMessageId` never lands in `digestSourceIds`. The envelope then
  // leaks through as a ghost row with `[digest envelope – body stripped
  // to save storage]` text. Filtering on the sentinel catches that
  // case unconditionally.
  const STUB_BODY = envelopeStubBody();
  type MessageRow = (typeof ticket.messages)[number];
  const visibleMessages: MessageRow[] = ticket.messages.filter((m) => {
    if (m.deletedAt) return false;
    const raw = m.rawData as Record<string, unknown> | null;
    const isExplodedSub =
      raw && typeof raw["digestSource"] === "string";
    if (isExplodedSub) {
      // Hide the Trading-API exploded sub when a Commerce-Message row
      // already carries the same content on this ticket. The CM row is
      // the canonical copy; this prevents the dupe-rendered thread.
      const body = normalizeBodyForDedup(m.bodyText);
      if (body && cmBodyKeys.has(`${m.direction}::${body}`)) return false;
      return true;
    }
    if (m.ebayMessageId && digestSourceIds.has(m.ebayMessageId)) {
      return false;
    }
    if (m.bodyText === STUB_BODY) {
      return false;
    }
    // Outbound Trading-API rows written by the Help Desk worker itself
    // (externalId starts with "outbound:" or is the Trading messageId
    // returned by AddMemberMessageRTQ) ALSO duplicate later when the
    // sweep ingests the CM echo. Same rule: if a CM row has the same
    // body+direction, hide our local copy in favor of the CM record so
    // the thread doesn't render "agent said X" twice.
    const extId = m.externalId ?? "";
    const isLocalOutboundRow =
      !extId.startsWith("cm:") &&
      !isExplodedSub &&
      m.direction === "OUTBOUND";
    if (isLocalOutboundRow) {
      const body = normalizeBodyForDedup(m.bodyText);
      if (body && cmBodyKeys.has(`${m.direction}::${body}`)) return false;
    }
    return true;
  });

  const seenImageUrls = new Set<string>();
  const finalMessages: MessageRow[] = visibleMessages
    .slice()
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
    .map<MessageRow>((m) => {
      const extId = m.externalId ?? "";
      if (extId.startsWith("cm:")) {
        const body = normalizeBodyForDedup(m.bodyText);
        if (!body) return m;
        const merged = mergeRawMedia(
          m.rawMedia,
          hiddenTradingMediaByCmKey.get(`${m.direction}::${body}`),
        );
        return merged === m.rawMedia ? m : { ...m, rawMedia: merged };
      }
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
  // and image rather than an arbitrary child variant.
  let listingInfo: {
    itemId: string;
    sku: string | null;
    title: string | null;
    imageUrl: string | null;
  } | null = null;
  if (ticket.ebayItemId) {
    const listingSelect = {
      platformItemId: true,
      sku: true,
      title: true,
      imageUrl: true,
    } satisfies Prisma.MarketplaceListingSelect;
    const listing =
      (await db.marketplaceListing.findFirst({
        where: {
          integrationId: ticket.integration.id,
          platformItemId: ticket.ebayItemId,
          platformVariantId: null,
        },
        select: listingSelect,
      })) ??
      (await db.marketplaceListing.findFirst({
        where: {
          integrationId: ticket.integration.id,
          platformItemId: ticket.ebayItemId,
        },
        orderBy: [{ platformVariantId: "asc" }],
        select: listingSelect,
      }));
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
      // Return the REAL unreadCount so the client can fire the explicit
      // auto-mark-read POST in loadSelected() when an agent opens an unread
      // ticket. Returning 0 here short-circuits that conditional, which was
      // the regression that meant clicking a ticket no longer flipped it to
      // read. The POST path (tickets/batch?action=markRead) is the sole
      // writer for unreadCount + eBay mirror; GET stays side-effect-free so
      // hover-prefetch can't accidentally mark things read.
      unreadCount: ticket.unreadCount,
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
      messages: finalMessages.map((message) => ({
        ...message,
        externalEmail: externalEmailMetaForMessage(message),
      })),
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
