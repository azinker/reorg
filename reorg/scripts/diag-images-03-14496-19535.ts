/**
 * Dump every helpdesk message tied to order 03-14496-19535 and inspect:
 *   - bodyText / bodyHtml (looking for inline <img> tags)
 *   - rawData / rawMedia (looking for attachments / media arrays)
 *
 * Goal: figure out why the buyer's image attachments render as an empty
 * bubble in the help desk for this order. Either:
 *   (a) the images live inside the body HTML and our SafeHtml strips them,
 *   (b) they live inside rawMedia under a key our extractor misses, or
 *   (c) they were never persisted at all (eBay returned them out-of-band).
 *
 * Run: powershell scripts/run-with-prod.ps1 -Script scripts/diag-images-03-14496-19535.ts
 */

import { db } from "@/lib/db";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const ORDER_NUMBER = "03-14496-19535";

async function main() {
  // Find every ticket that mentions this order — there may be more than one
  // if the AR-on-pet-grooming and buyer-on-screwdriver tickets haven't been
  // merged yet.
  const tickets = await db.helpdeskTicket.findMany({
    where: { ebayOrderNumber: ORDER_NUMBER },
    select: {
      id: true,
      threadKey: true,
      buyerUserId: true,
      ebayItemId: true,
      ebayOrderNumber: true,
      subject: true,
      isArchived: true,
      status: true,
    },
  });
  console.log(`Found ${tickets.length} ticket(s) for order ${ORDER_NUMBER}:`);
  for (const t of tickets) {
    console.log(
      `  ${t.id} | ${t.threadKey} | buyer=${t.buyerUserId} | item=${t.ebayItemId} | status=${t.status} | archived=${t.isArchived}`,
    );
  }

  if (tickets.length === 0) {
    await db.$disconnect();
    return;
  }

  const ticketIds = tickets.map((t) => t.id);
  const messages = await db.helpdeskMessage.findMany({
    where: { ticketId: { in: ticketIds } },
    orderBy: { sentAt: "asc" },
    select: {
      id: true,
      ticketId: true,
      sentAt: true,
      direction: true,
      source: true,
      isHtml: true,
      subject: true,
      bodyText: true,
      ebayMessageId: true,
      rawData: true,
      rawMedia: true,
    },
  });

  console.log(`\nTotal messages: ${messages.length}`);
  const outDir = join(__dirname, "tmp-bodies", "order-03-14496-19535");
  mkdirSync(outDir, { recursive: true });

  for (const m of messages) {
    const body = m.bodyText ?? "";
    const inlineImg = /<img\b/i.test(body);
    const ebayImgHost = /i\.ebayimg\.com/i.test(body);
    const userAttachHost = /vi\.ebaydesc\.com|airr\.ebay\.com|inappimg/i.test(body);
    const mediaSummary = m.rawMedia ? JSON.stringify(m.rawMedia).slice(0, 400) : "(null)";
    const rawSummary = m.rawData
      ? JSON.stringify(m.rawData).slice(0, 400)
      : "(null)";
    console.log(
      `\n--- ${m.id}  ${m.sentAt.toISOString()}  ${m.direction}  ${m.source}  isHtml=${m.isHtml}`,
    );
    console.log(`  subject: ${m.subject}`);
    console.log(`  bodyLen: ${body.length}  hasImg=${inlineImg}  ebayImgHost=${ebayImgHost}  otherHost=${userAttachHost}`);
    console.log(`  rawMedia: ${mediaSummary}`);
    console.log(`  rawData : ${rawSummary}`);
    const file = join(outDir, `${m.id}.html`);
    writeFileSync(
      file,
      `<!-- ticket=${m.ticketId} dir=${m.direction} source=${m.source} sent=${m.sentAt.toISOString()} -->\n` +
        body,
    );
  }
  console.log(`\nBodies dumped to ${outDir}`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
