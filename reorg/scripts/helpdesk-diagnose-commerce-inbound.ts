/**
 * Diagnose why a specific ticket isn't catching agent replies sent from
 * the eBay web UI (Commerce Message API path).
 *
 * What it checks, in order:
 *   1. Flags snapshot — is effectiveCanSyncReadState even true?
 *   2. Ticket lookup — resolve by id / threadKey / ebayOrderNumber.
 *   3. Ticket state — ebayConversationId, lastBuyerMessageAt,
 *      lastAgentMessageAt, buyerUserId/buyerName.
 *   4. Existing messages — what's already in DB for this ticket.
 *   5. If ebayConversationId is null, try resolveConversationIdForBuyer
 *      (the same path the sweep uses) and report whether it would bind.
 *   6. Call getConversationMessages for the bound (or resolved)
 *      conversationId and diff eBay's list against our DB. Print which
 *      messages would be ingested on the next sweep.
 *   7. Compare eBay's latest conversation `last_modified_date` against
 *      our max(lastBuyer, lastAgent) to show whether the prioritization
 *      selector would flag this ticket as stale.
 *
 * Read-only. Does not mutate DB or call any eBay write endpoint.
 *
 * Usage (from reorg/):
 *   npx tsx -r dotenv/config scripts/helpdesk-diagnose-commerce-inbound.ts \
 *     --ticket 09-14501-65972
 */

import { HelpdeskTicketType, Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { helpdeskFlagsSnapshotAsync } from "@/lib/helpdesk/flags";
import { buildEbayConfig } from "@/lib/services/helpdesk-ebay";
import {
  getConversationMessages,
  getConversations,
  resolveConversationIdForBuyer,
} from "@/lib/services/helpdesk-commerce-message";

interface Args {
  ticket: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ticket: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ticket") {
      args.ticket = (argv[++i] ?? "").trim();
    } else if (!args.ticket && !a.startsWith("--")) {
      args.ticket = a.trim();
    }
  }
  return args;
}

function line(ch = "─", n = 78): string {
  return ch.repeat(n);
}

function header(title: string): void {
  process.stdout.write(`\n${line("═")}\n  ${title}\n${line("═")}\n`);
}

function sub(title: string): void {
  process.stdout.write(`\n── ${title} ──\n`);
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "(none)";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

async function resolveTickets(identifier: string) {
  const byId = await db.helpdeskTicket.findUnique({
    where: { id: identifier },
  });
  if (byId) return [byId];
  const byThread = await db.helpdeskTicket.findMany({
    where: { threadKey: identifier },
    orderBy: { createdAt: "asc" },
  });
  if (byThread.length > 0) return byThread;
  return db.helpdeskTicket.findMany({
    where: { ebayOrderNumber: identifier },
    orderBy: { createdAt: "asc" },
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ticket) {
    process.stderr.write(
      "Error: ticket identifier is required.\n" +
        "Usage: npx tsx -r dotenv/config scripts/helpdesk-diagnose-commerce-inbound.ts " +
        "--ticket <ticketId | threadKey | ebayOrderNumber>\n",
    );
    process.exit(1);
  }

  header(`Commerce-Message inbound diagnostic  (ticket=${args.ticket})`);

  sub("Step 1: helpdeskFlagsSnapshotAsync()");
  const flags = await helpdeskFlagsSnapshotAsync();
  process.stdout.write(
    [
      `  safeMode (effective)       : ${flags.safeMode}`,
      `  enableEbayReadSync         : ${flags.enableEbayReadSync}`,
      `  → effectiveCanSyncReadState: ${flags.effectiveCanSyncReadState}`,
    ].join("\n") + "\n",
  );
  if (!flags.effectiveCanSyncReadState) {
    process.stdout.write(
      "\n  ⚠ Sweep is GATED OFF — the inbound sweep only runs when effectiveCanSyncReadState is true.\n",
    );
  }

  sub("Step 2: Resolve ticket(s)");
  const tickets = await resolveTickets(args.ticket);
  if (tickets.length === 0) {
    process.stdout.write(`  ✗ No ticket matches "${args.ticket}"\n`);
    await db.$disconnect();
    process.exit(2);
  }
  process.stdout.write(`  Found ${tickets.length} ticket(s).\n`);

  for (const ticket of tickets) {
    header(`Ticket ${ticket.id}  (threadKey=${ticket.threadKey})`);

    sub("Step 3: Ticket state");
    process.stdout.write(
      [
        `  integrationId        : ${ticket.integrationId}`,
        `  type                 : ${ticket.type}`,
        `  status               : ${ticket.status}`,
        `  isArchived           : ${ticket.isArchived}`,
        `  isSpam               : ${ticket.isSpam}`,
        `  buyerUserId          : ${fmt(ticket.buyerUserId)}`,
        `  buyerName            : ${fmt(ticket.buyerName)}`,
        `  ebayItemId           : ${fmt(ticket.ebayItemId)}`,
        `  ebayOrderNumber      : ${fmt(ticket.ebayOrderNumber)}`,
        `  ebayConversationId   : ${fmt(ticket.ebayConversationId)}`,
        `  lastBuyerMessageAt   : ${fmt(ticket.lastBuyerMessageAt)}`,
        `  lastAgentMessageAt   : ${fmt(ticket.lastAgentMessageAt)}`,
        `  unreadCount          : ${ticket.unreadCount}`,
      ].join("\n") + "\n",
    );

    sub("Step 4: Messages in DB");
    const dbMessages = await db.helpdeskMessage.findMany({
      where: { ticketId: ticket.id },
      orderBy: { sentAt: "desc" },
      select: {
        id: true,
        direction: true,
        source: true,
        externalId: true,
        ebayMessageId: true,
        fromName: true,
        sentAt: true,
      },
    });
    process.stdout.write(`  ${dbMessages.length} message(s) in DB:\n`);
    for (const m of dbMessages) {
      process.stdout.write(
        `    [${fmt(m.sentAt)}] ${m.direction.padEnd(8)} ` +
          `${(m.source ?? "?").padEnd(14)} ` +
          `extId=${fmt(m.externalId)} ebayMsgId=${fmt(m.ebayMessageId)}\n`,
      );
    }

    // Integration we need to talk to eBay
    if (ticket.type === HelpdeskTicketType.SYSTEM) {
      process.stdout.write(
        "\n  ⓘ SYSTEM ticket — the Commerce Message inbound sweep skips these. Stopping.\n",
      );
      continue;
    }
    const integration = await db.integration.findUnique({
      where: { id: ticket.integrationId },
    });
    if (
      !integration ||
      (integration.platform !== Platform.TPP_EBAY &&
        integration.platform !== Platform.TT_EBAY)
    ) {
      process.stdout.write(
        "\n  ⚠ Integration isn't a TPP/TT eBay store — sweep would not run.\n",
      );
      continue;
    }
    const config = buildEbayConfig(integration);
    if (!config.appId || !config.refreshToken) {
      process.stdout.write(
        "\n  ⚠ Integration is missing appId or refreshToken — sweep would bail.\n",
      );
      continue;
    }

    // Step 5: Determine conversationId
    sub("Step 5: Determine conversationId");
    let conversationId = ticket.ebayConversationId;
    if (!conversationId) {
      process.stdout.write(
        "  ebayConversationId is NULL. Trying resolveConversationIdForBuyer()…\n",
      );
      const buyer = ticket.buyerUserId ?? ticket.buyerName;
      if (!buyer) {
        process.stdout.write(
          "  ✗ Ticket has no buyerUserId or buyerName — sweep can't resolve.\n",
        );
        continue;
      }
      const resolved = await resolveConversationIdForBuyer(
        integration.id,
        config,
        buyer,
      ).catch((err: unknown) => {
        process.stdout.write(
          `  ✗ resolveConversationIdForBuyer threw: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return null;
      });
      if (resolved?.best?.conversationId) {
        conversationId = resolved.best.conversationId;
        process.stdout.write(
          `  ✓ Resolved conversationId = ${conversationId}\n`,
        );
        process.stdout.write(
          `    (${resolved.all?.length ?? 0} candidate(s) for buyer "${buyer}")\n`,
        );
      } else {
        process.stdout.write(
          `  ✗ Resolver returned no conversationId for buyer "${buyer}".\n`,
        );
        continue;
      }
    } else {
      process.stdout.write(`  ebayConversationId = ${conversationId}\n`);
    }

    // Step 6: Check eBay's last_modified_date for this conversation
    sub("Step 6: eBay last_modified_date vs our DB");
    let ebayLastModified: Date | null = null;
    try {
      // Pull just enough pages to find this conversation. We page by
      // modified_date DESC so recently-touched conversations are near
      // the top.
      for (
        let offset = 0;
        offset < 400 && ebayLastModified === null;
        offset += 50
      ) {
        const { conversations, needsReauth } = await getConversations(
          integration.id,
          config,
          {
            conversationType: "FROM_MEMBERS",
            sort: "-last_modified_date",
            limit: 50,
            offset,
          },
        );
        if (needsReauth) {
          process.stdout.write(
            "  ✗ needsReauth — integration's token is missing commerce.message scope.\n",
          );
          break;
        }
        if (conversations.length === 0) break;
        for (const c of conversations) {
          if (c.conversationId === conversationId && c.lastMessageDate) {
            ebayLastModified = new Date(c.lastMessageDate);
            break;
          }
        }
        if (conversations.length < 50) break;
      }
    } catch (err) {
      process.stdout.write(
        `  ✗ getConversations scan threw: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (ebayLastModified) {
      const ourTs = Math.max(
        ticket.lastBuyerMessageAt?.getTime() ?? 0,
        ticket.lastAgentMessageAt?.getTime() ?? 0,
      );
      const delta = ebayLastModified.getTime() - ourTs;
      process.stdout.write(
        [
          `  eBay  last_modified_date : ${ebayLastModified.toISOString()}`,
          `  DB    max(buyer,agent)    : ${
            ourTs > 0 ? new Date(ourTs).toISOString() : "(none)"
          }`,
          `  delta (eBay - DB, ms)    : ${delta}`,
          `  would be flagged STALE?  : ${delta > 60_000 ? "YES" : "no"}`,
        ].join("\n") + "\n",
      );
    } else {
      process.stdout.write(
        "  ⚠ Conversation not found in the top 400 recently-modified FROM_MEMBERS conversations.\n" +
          "    (It may be older than the scan window; the sweep's unread pass wouldn't see it.)\n",
      );
    }

    // Step 7: Fetch messages from eBay and diff against DB
    sub("Step 7: eBay messages vs DB (deduped by cm:<messageId>)");
    if (!conversationId) {
      process.stdout.write("  ✗ No conversationId, cannot fetch messages.\n");
      continue;
    }
    const res = await getConversationMessages(integration.id, config, {
      conversationId,
      limit: 50,
    });
    if (res.needsReauth) {
      process.stdout.write(
        "  ✗ needsReauth — integration's token is missing commerce.message scope.\n",
      );
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      process.stdout.write(
        `  ✗ getConversationMessages returned HTTP ${res.status}\n`,
      );
      continue;
    }
    process.stdout.write(`  eBay returned ${res.messages.length} message(s):\n`);
    const existingExternals = new Set(
      dbMessages.map((m) => m.externalId).filter((x): x is string => !!x),
    );
    let wouldIngest = 0;
    for (const m of res.messages) {
      const ext = `cm:${m.messageId}`;
      const alreadyHave = existingExternals.has(ext);
      if (!alreadyHave) wouldIngest++;
      process.stdout.write(
        `    [${fmt(m.createdDate)}] from=${fmt(m.senderUsername)} ` +
          `→ ${fmt(m.recipientUsername)}  msgId=${m.messageId}  ` +
          `${alreadyHave ? "(already in DB)" : "★ WOULD INGEST"}\n`,
      );
    }
    process.stdout.write(
      `\n  Summary: ${wouldIngest} new message(s) would be ingested on the next sweep run.\n`,
    );
  }

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect().catch(() => undefined);
  process.exit(3);
});
