// Backfill: rewrite OUTBOUND HelpdeskMessage rows that were written by
// the old outbound worker so they match the new post-deploy shape.
//
// Two problems on the old rows:
//   1. `externalId` is the raw eBay messageId with no `cm:` prefix. The
//      (ticketId, externalId) unique constraint therefore doesn't block
//      the inbound Commerce-Message sweep from inserting a second row
//      for the same send, and the read-time dedup in the GET ticket
//      route can't pair them up.
//   2. `fromName` is the hardcoded "reorG agent" string instead of the
//      composing agent's display name (e.g. "Adam Zinker"). The UI
//      already prefers `m.author.name` when the row has an author
//      pointer, but exported audit projections + non-joined reads still
//      show "reorG agent", so we repair both fields while we're in
//      the row.
//
// Scope: only touches rows that unambiguously came from our own sending
// path — rawData.transport === "ebay_cm" AND rawData.source ===
// "helpdesk_outbound". Doesn't touch inbound rows, doesn't touch rows
// from the Commerce-Message sweep (those already use cm: prefix),
// doesn't touch Trading-API envelopes.
//
// Idempotent: re-runs are no-ops because we skip rows that already have
// the cm: prefix.

import { PrismaClient, Prisma } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "<unknown>";
  console.log(`[backfill] connected to ${host}`);
  if (!host.includes("little-fire")) {
    throw new Error(
      `[backfill] refusing to run — expected little-fire (prod) host, got ${host}`,
    );
  }

  // Pull recent outbound rows written by our own worker. rawData check
  // is on the shape the new + old outbound code both write:
  //   { transport: "ebay_cm", messageId, source: "helpdesk_outbound", jobId }
  const rows = await db.helpdeskMessage.findMany({
    where: {
      direction: "OUTBOUND",
      source: "EBAY_UI",
      rawData: {
        path: ["source"],
        equals: "helpdesk_outbound",
      },
    },
    select: {
      id: true,
      ticketId: true,
      externalId: true,
      ebayMessageId: true,
      authorUserId: true,
      fromName: true,
      rawData: true,
      sentAt: true,
    },
    orderBy: { sentAt: "desc" },
    take: 500,
  });

  console.log(`[backfill] found ${rows.length} candidate rows`);

  let fixed = 0;
  let skipped = 0;
  for (const row of rows) {
    const needsCmPrefix =
      !!row.ebayMessageId &&
      row.externalId !== null &&
      !row.externalId.startsWith("cm:") &&
      !row.externalId.startsWith("outbound:");
    const needsAuthorName =
      row.fromName === "reorG agent" && !!row.authorUserId;

    if (!needsCmPrefix && !needsAuthorName) {
      skipped += 1;
      continue;
    }

    let nextExternalId = row.externalId;
    if (needsCmPrefix && row.ebayMessageId) {
      nextExternalId = `cm:${row.ebayMessageId}`;
      // Belt-and-suspenders: if a cm:<id> row for this ticket already
      // exists (because the CM inbound sweep raced us), we can't create
      // a duplicate externalId on the same ticket. Delete our raw-id
      // row instead so the cm: row becomes the canonical copy.
      const existing = await db.helpdeskMessage.findFirst({
        where: {
          ticketId: row.ticketId,
          externalId: nextExternalId,
        },
        select: { id: true },
      });
      if (existing) {
        await db.helpdeskMessage.delete({ where: { id: row.id } });
        console.log(
          `[backfill] deleted duplicate row ${row.id} (cm:${row.ebayMessageId} already exists as ${existing.id})`,
        );
        fixed += 1;
        continue;
      }
    }

    const patch: Prisma.HelpdeskMessageUpdateInput = {};
    if (nextExternalId !== row.externalId) {
      patch.externalId = nextExternalId;
    }
    if (needsAuthorName && row.authorUserId) {
      const author = await db.user.findUnique({
        where: { id: row.authorUserId },
        select: { name: true, email: true },
      });
      const resolved = author?.name ?? author?.email ?? null;
      if (resolved) patch.fromName = resolved;
    }
    if (Object.keys(patch).length === 0) {
      skipped += 1;
      continue;
    }
    await db.helpdeskMessage.update({ where: { id: row.id }, data: patch });
    fixed += 1;
    console.log(
      `[backfill] updated row ${row.id} ext=${row.externalId} -> ${
        patch.externalId ?? row.externalId
      } fromName=${row.fromName} -> ${patch.fromName ?? row.fromName}`,
    );
  }

  console.log(`[backfill] done: fixed=${fixed} skipped=${skipped}`);

  // Also: nuke orphan digest-envelope STUB rows. The read-time filter
  // in /api/helpdesk/tickets/[id] already hides them, but they bloat
  // the thread query and can still leak via other views (exports,
  // audits), so clean them out.
  const STUB_BODY = "[digest envelope – body stripped to save storage]";
  const stubRows = await db.helpdeskMessage.findMany({
    where: {
      bodyText: STUB_BODY,
      direction: "OUTBOUND",
    },
    select: { id: true, ticketId: true, ebayMessageId: true },
  });
  console.log(`[backfill] found ${stubRows.length} outbound stub envelope rows`);
  let deletedStubs = 0;
  for (const s of stubRows) {
    // Only delete if the ticket has an actual outbound CM row with body
    // so we don't accidentally blow away the last trace of a send.
    const hasRealOutbound = await db.helpdeskMessage.findFirst({
      where: {
        ticketId: s.ticketId,
        direction: "OUTBOUND",
        id: { not: s.id },
        bodyText: { not: STUB_BODY },
      },
      select: { id: true },
    });
    if (!hasRealOutbound) continue;
    await db.helpdeskMessage.delete({ where: { id: s.id } });
    deletedStubs += 1;
  }
  console.log(`[backfill] deleted ${deletedStubs} stub rows`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
