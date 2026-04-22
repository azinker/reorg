/**
 * Retroactively ingest Auto-Responder sends into the Help Desk.
 *
 * Why
 * ---
 * Until today, the AR worker only wrote to AutoResponderSendLog and let
 * the eBay Sent-folder sync (eventually) ingest the message. eBay's
 * AddMemberMessageAAQToPartner doesn't echo a MessageID, so those
 * messages were never tagged source=AUTO_RESPONDER, never deduped
 * against the live AR send, and — when the Sent poll missed them —
 * never appeared in Help Desk at all.
 *
 * We just shipped `recordAutoResponderHelpdeskMessage()` which writes
 * the AR copy directly into Help Desk on every successful send. This
 * script applies that same logic to every historical AutoResponderSendLog
 * row so old AR sends become visible / archivable retroactively.
 *
 * Behavior on order 03-14496-19535
 * --------------------------------
 * Run with `--order 03-14496-19535 --apply` to retroactively merge
 * the April 11 AR send (pet-hammock item) into the existing canonical
 * ticket for that order. Because the buyer already replied (Apr 22),
 * the archive filter is GUARDED inside the ingest helper and the
 * ticket stays in TO_DO — exactly the "bounced out of archive"
 * behavior the user asked for.
 *
 * Usage
 * -----
 *   pnpm tsx scripts/retroactive-ar-ingest.ts --order 03-14496-19535
 *     # dry-run for one order; prints what WOULD happen
 *
 *   pnpm tsx scripts/retroactive-ar-ingest.ts --order 03-14496-19535 --apply
 *     # actually ingest for that order
 *
 *   pnpm tsx scripts/retroactive-ar-ingest.ts --apply
 *     # ingest for ALL historical AR sends (idempotent — safe to re-run)
 */
import { db } from "@/lib/db";
import { recordAutoResponderHelpdeskMessage } from "@/lib/services/helpdesk-ar-ingest";

interface Args {
  order: string | null;
  apply: boolean;
  limit: number | null;
}

function parseArgs(): Args {
  const args: Args = { order: null, apply: false, limit: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--order") args.order = argv[++i] ?? null;
    else if (a === "--limit") args.limit = Number(argv[++i] ?? "0") || null;
  }
  return args;
}

async function main() {
  const args = parseArgs();
  console.log(
    `\n=== Retroactive AR ingest ===\n` +
      `  order:  ${args.order ?? "(all)"}\n` +
      `  apply:  ${args.apply}\n` +
      `  limit:  ${args.limit ?? "(none)"}\n`,
  );

  const logs = await db.autoResponderSendLog.findMany({
    where: {
      eventType: "SENT",
      status: "sent",
      ...(args.order ? { orderNumber: args.order } : {}),
    },
    orderBy: { sentAt: "asc" },
    take: args.limit ?? undefined,
    select: {
      id: true,
      orderNumber: true,
      ebayBuyerUserId: true,
      ebayItemId: true,
      renderedSubject: true,
      renderedBody: true,
      sentAt: true,
      attemptedAt: true,
      createdAt: true,
      integrationId: true,
      channel: true,
    },
  });

  console.log(`Found ${logs.length} AR send log(s) to process.\n`);

  if (logs.length === 0) {
    await db.$disconnect();
    return;
  }

  // Pre-load integrations referenced by the logs so we don't hit the DB
  // once per row in the inner loop.
  const integrationIds = Array.from(new Set(logs.map((l) => l.integrationId)));
  const integrations = await db.integration.findMany({
    where: { id: { in: integrationIds } },
    select: { id: true, platform: true, label: true },
  });
  const integrationsById = new Map(integrations.map((i) => [i.id, i]));

  // Look up buyer display names from the order rows so the synthesized
  // ticket gets a real "First Last" customer label, not just the eBay
  // username. We do this in batch keyed by orderNumber.
  const orderNumbers = Array.from(
    new Set(logs.map((l) => l.orderNumber).filter((o): o is string => Boolean(o))),
  );
  const orders = await db.marketplaceSaleOrder.findMany({
    where: { externalOrderId: { in: orderNumbers } },
    select: { externalOrderId: true, buyerDisplayLabel: true },
  });
  const buyerNameByOrder = new Map(
    orders.map((o) => [o.externalOrderId, o.buyerDisplayLabel]),
  );

  let created = 0;
  let archived = 0;
  let skipped = 0;
  let errored = 0;

  for (const log of logs) {
    if (!log.orderNumber || !log.ebayBuyerUserId || !log.ebayItemId) {
      console.log(`  - SKIP ${log.id}: missing order/buyer/item`);
      skipped++;
      continue;
    }
    const integration = integrationsById.get(log.integrationId);
    if (!integration) {
      console.log(`  - SKIP ${log.id}: integration ${log.integrationId} gone`);
      skipped++;
      continue;
    }
    const sentAt = log.sentAt ?? log.attemptedAt ?? log.createdAt;

    if (!args.apply) {
      console.log(
        `  - DRY ${log.id}: order=${log.orderNumber} buyer=${log.ebayBuyerUserId} item=${log.ebayItemId} sentAt=${sentAt.toISOString()}`,
      );
      continue;
    }

    try {
      const result = await recordAutoResponderHelpdeskMessage({
        integration,
        orderNumber: log.orderNumber,
        buyerUserId: log.ebayBuyerUserId,
        buyerName: buyerNameByOrder.get(log.orderNumber) ?? null,
        itemId: log.ebayItemId,
        itemTitle: null,
        subject: log.renderedSubject ?? "",
        body: log.renderedBody ?? "",
        sentAt,
        sendLogId: log.id,
      });
      const tag = result.alreadyExisted
        ? "EXISTS"
        : result.ticketCreated
          ? "NEW"
          : "MERGED";
      const filterTag =
        result.appliedFilterIds.length > 0
          ? ` filters=${result.appliedFilterIds.length}`
          : "";
      console.log(
        `  - ${tag} ${log.id}: ticket=${result.ticketId} msg=${result.messageId}${filterTag}`,
      );
      if (result.alreadyExisted) skipped++;
      else created++;
      if (result.appliedFilterIds.length > 0) archived++;
    } catch (err) {
      errored++;
      console.error(
        `  - ERR  ${log.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    `\nDone. created=${created} skipped=${skipped} filtered=${archived} errored=${errored}\n`,
  );

  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
