/**
 * Diagnose why toggling "mark unread" in the Help Desk UI isn't reflecting
 * on eBay.
 *
 * Why this exists:
 *   The batch API route (POST /api/helpdesk/tickets/batch action=markRead)
 *   gates the eBay mirror on `helpdeskFlagsSnapshotAsync().effectiveCanSyncReadState`
 *   and then delegates to the shared helper `mirrorReadStateToEbay`. When the
 *   mirror "silently fails" there are exactly six places it can go wrong:
 *
 *     1. effectiveCanSyncReadState=false   (safe mode, global write lock,
 *                                           or read-sync toggle off)
 *     2. No INBOUND messages with a non-null ebayMessageId
 *     3. Ticket is SYSTEM (FROM EBAY) and gets filtered out by design
 *     4. Integration disabled / wrong platform
 *     5. buildEbayConfig missing appId / refreshToken
 *     6. reviseMyMessages → ack=Failure from eBay
 *
 *   This script prints every one of those gates so the operator gets a single
 *   definitive answer instead of piecing together Vercel log lines.
 *
 * Safety:
 *   - Default is `--dry-run`: inspect only, do NOT call ReviseMyMessages.
 *   - Pass `--apply` to actually execute the mirror. When applying, the
 *     default direction is isRead=false (the operation the user reported
 *     as broken); pass `--mark-read` to apply the opposite direction.
 *   - The script only ever touches the eBay Read/Unread flag on message rows
 *     we already know about. It does not send messages or modify listings.
 *
 * Usage (from reorg/):
 *   # Inspect a ticket without hitting eBay:
 *   npx tsx -r dotenv/config scripts/helpdesk-diagnose-read-mirror.ts \
 *     --ticket <ticketId or threadKey or eBay order number>
 *
 *   # Actually execute the mark-unread mirror against eBay:
 *   npx tsx -r dotenv/config scripts/helpdesk-diagnose-read-mirror.ts \
 *     --ticket <id> --apply
 *
 *   # Mark-read direction instead of mark-unread:
 *   npx tsx -r dotenv/config scripts/helpdesk-diagnose-read-mirror.ts \
 *     --ticket <id> --apply --mark-read
 */

import {
  HelpdeskMessageDirection,
  HelpdeskTicketType,
  Platform,
} from "@prisma/client";
import { db } from "@/lib/db";
import { helpdeskFlagsSnapshotAsync } from "@/lib/helpdesk/flags";
import { buildEbayConfig } from "@/lib/services/helpdesk-ebay";
import { mirrorReadStateToEbay } from "@/lib/services/helpdesk-read-mirror";

interface Args {
  ticket: string;
  apply: boolean;
  markRead: boolean; // default false = "mark unread"
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ticket: "", apply: false, markRead: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ticket") {
      args.ticket = (argv[++i] ?? "").trim();
    } else if (a === "--apply") {
      args.apply = true;
    } else if (a === "--dry-run") {
      args.apply = false;
    } else if (a === "--mark-read") {
      args.markRead = true;
    } else if (a === "--mark-unread") {
      args.markRead = false;
    } else if (!args.ticket && !a.startsWith("--")) {
      // Also accept the identifier as the first positional arg.
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

/**
 * Resolve the user-provided identifier into a HelpdeskTicket. Accepts:
 *   - a raw ticket id (cuid)
 *   - an eBay order number (e.g. "17-14480-10344")
 *   - a threadKey string
 *
 * If multiple tickets match an order number we return them all so the
 * diagnostic covers every ticket that represents that conversation (buyer
 * ticket + system tickets with `sys:` prefixes).
 */
async function resolveTickets(identifier: string) {
  // 1) exact ticket id
  const byId = await db.helpdeskTicket.findUnique({
    where: { id: identifier },
  });
  if (byId) return [byId];

  // 2) threadKey
  const byThread = await db.helpdeskTicket.findMany({
    where: { threadKey: identifier },
    orderBy: { createdAt: "asc" },
  });
  if (byThread.length > 0) return byThread;

  // 3) eBay order number
  const byOrder = await db.helpdeskTicket.findMany({
    where: { ebayOrderNumber: identifier },
    orderBy: { createdAt: "asc" },
  });
  return byOrder;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ticket) {
    process.stderr.write(
      "Error: ticket identifier is required.\n" +
        "Usage: npx tsx -r dotenv/config scripts/helpdesk-diagnose-read-mirror.ts " +
        "--ticket <ticketId | threadKey | ebayOrderNumber> [--apply] [--mark-read]\n",
    );
    process.exit(1);
  }

  header(
    `Help Desk → eBay read-sync diagnostic  (apply=${args.apply} isRead=${args.markRead})`,
  );
  process.stdout.write(`identifier: ${args.ticket}\n`);

  // ── Step 1: Flags snapshot ───────────────────────────────────────────
  sub("Step 1: helpdeskFlagsSnapshotAsync()");
  const flags = await helpdeskFlagsSnapshotAsync();
  process.stdout.write(
    [
      `  envSafeMode               : ${flags.envSafeMode}`,
      `  safeMode (effective)      : ${flags.safeMode}`,
      `  globalWriteLock           : ${flags.globalWriteLock}`,
      `  enableEbayReadSync        : ${flags.enableEbayReadSync}`,
      `  enableEbaySend            : ${flags.enableEbaySend}`,
      `  enableResendExternal      : ${flags.enableResendExternal}`,
      `  → effectiveCanSyncReadState: ${flags.effectiveCanSyncReadState}`,
    ].join("\n") + "\n",
  );
  if (!flags.effectiveCanSyncReadState) {
    const reasons: string[] = [];
    if (flags.safeMode)
      reasons.push(
        `safeMode=true (envSafeMode=${flags.envSafeMode}, globalWriteLock=${flags.globalWriteLock})`,
      );
    if (!flags.enableEbayReadSync) reasons.push("enableEbayReadSync=false");
    process.stdout.write(
      `\n  ⚠ BLOCKED: effectiveCanSyncReadState is false. Reasons: ${reasons.join("; ")}\n`,
    );
  }

  // ── Step 2: Resolve tickets ──────────────────────────────────────────
  sub("Step 2: Resolve ticket(s)");
  const tickets = await resolveTickets(args.ticket);
  if (tickets.length === 0) {
    process.stdout.write(
      `  ✗ No ticket found matching id / threadKey / ebayOrderNumber = "${args.ticket}"\n` +
        `    Either the ingest didn't land yet, or the identifier is wrong.\n`,
    );
    await db.$disconnect();
    process.exit(2);
  }
  for (const t of tickets) {
    process.stdout.write(
      [
        `  • id=${t.id}`,
        `    threadKey=${t.threadKey}`,
        `    type=${t.type} status=${t.status} kind=${t.kind}`,
        `    integrationId=${t.integrationId} ebayOrderNumber=${t.ebayOrderNumber ?? "—"}`,
        `    unreadCount=${t.unreadCount} subject="${(t.subject ?? "").slice(0, 80)}"`,
      ].join("\n") + "\n",
    );
  }
  const systemTickets = tickets.filter(
    (t) => t.type === HelpdeskTicketType.SYSTEM,
  );
  if (systemTickets.length > 0) {
    process.stdout.write(
      `  ⚠ ${systemTickets.length} ticket(s) are type=SYSTEM. The mirror will` +
        ` filter these out by design (we never push read-state on FROM EBAY tickets).\n`,
    );
  }

  // ── Step 3: Inspect eligible messages per ticket ─────────────────────
  sub("Step 3: Eligible INBOUND messages with ebayMessageId");
  const ticketIds = tickets.map((t) => t.id);
  const messages = await db.helpdeskMessage.findMany({
    where: {
      ticketId: { in: ticketIds },
      direction: HelpdeskMessageDirection.INBOUND,
    },
    select: {
      id: true,
      ticketId: true,
      ebayMessageId: true,
      externalId: true,
      fromName: true,
      fromIdentifier: true,
      createdAt: true,
      sentAt: true,
      ticket: { select: { type: true, threadKey: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const eligibleAll = messages.filter(
    (m) =>
      m.ebayMessageId &&
      m.ticket.type !== HelpdeskTicketType.SYSTEM,
  );
  process.stdout.write(
    `  total INBOUND msgs=${messages.length}, with ebayMessageId=${messages.filter((m) => m.ebayMessageId).length}, ` +
      `eligible for mirror=${eligibleAll.length}\n`,
  );
  const withoutId = messages.filter((m) => !m.ebayMessageId);
  if (withoutId.length > 0) {
    process.stdout.write(
      `  ⚠ ${withoutId.length} INBOUND message(s) have NO ebayMessageId — they cannot be mirrored.\n` +
        `    (Shown: first 3 of ${withoutId.length})\n`,
    );
    for (const m of withoutId.slice(0, 3)) {
      process.stdout.write(
        `      - msgId=${m.id} from=${m.fromName ?? m.fromIdentifier ?? "?"} ` +
          `externalId=${m.externalId ?? "—"} at=${m.sentAt.toISOString()}\n`,
      );
    }
  }
  if (eligibleAll.length > 0) {
    process.stdout.write(`  First 5 eligible:\n`);
    for (const m of eligibleAll.slice(0, 5)) {
      process.stdout.write(
        `      - ticketId=${m.ticketId} ebayMessageId=${m.ebayMessageId} ` +
          `from=${m.fromName ?? "?"} at=${m.sentAt.toISOString()}\n`,
      );
    }
  }

  // ── Step 4: Per-integration credentials check ────────────────────────
  sub("Step 4: Integration credentials");
  const integrationIds = [...new Set(tickets.map((t) => t.integrationId))];
  const integrations = await db.integration.findMany({
    where: { id: { in: integrationIds } },
  });
  for (const integ of integrations) {
    const config = buildEbayConfig(integ);
    const platformSupported =
      integ.platform === Platform.TPP_EBAY ||
      integ.platform === Platform.TT_EBAY;
    process.stdout.write(
      [
        `  • ${integ.label} [${integ.platform}] enabled=${integ.enabled}`,
        `    platformSupported=${platformSupported}`,
        `    hasAppId=${Boolean(config.appId)} hasRefreshToken=${Boolean(config.refreshToken)}`,
      ].join("\n") + "\n",
    );
  }

  // ── Step 5: Dry-run or apply mirror ──────────────────────────────────
  sub(
    args.apply
      ? `Step 5: APPLY mirror (isRead=${args.markRead})`
      : "Step 5: Dry-run (no eBay API calls)",
  );
  if (!args.apply) {
    process.stdout.write(
      `  skipped. Re-run with --apply to execute mirrorReadStateToEbay().\n`,
    );
    await db.$disconnect();
    return;
  }

  if (!flags.effectiveCanSyncReadState) {
    process.stdout.write(
      `  ✗ refusing to apply: effectiveCanSyncReadState=false.\n` +
        `    Flip the gates listed in Step 1 and re-run.\n`,
    );
    await db.$disconnect();
    process.exit(3);
  }

  const result = await mirrorReadStateToEbay(ticketIds, args.markRead);
  process.stdout.write(
    [
      `  attempted       : ${result.attempted}`,
      `  succeeded       : ${result.succeeded}`,
      `  failed          : ${result.failed}`,
      `  skippedReason   : ${result.skippedReason ?? "—"}`,
      `  errors          : ${result.errors.length === 0 ? "—" : ""}`,
    ].join("\n") + "\n",
  );
  for (const err of result.errors) {
    process.stdout.write(`      ! ${err}\n`);
  }
  for (const row of result.perIntegration) {
    process.stdout.write(
      `  → ${row.integrationLabel} [${row.platform}] msgs=${row.messageCount} ` +
        `ok=${row.succeeded} fail=${row.failed}` +
        (row.errors.length ? ` errors=${row.errors.join(" | ")}` : "") +
        "\n",
    );
  }

  // Verdict
  sub("Verdict");
  if (result.succeeded > 0 && result.failed === 0) {
    process.stdout.write(
      `  ✓ All ${result.succeeded} eBay message(s) flipped to isRead=${args.markRead}.\n` +
        `    Refresh eBay (My Messages) — the state should match.\n`,
    );
  } else if (result.succeeded === 0 && result.skippedReason) {
    process.stdout.write(
      `  ⚠ Mirror skipped: ${result.skippedReason}.\n` +
        `    This matches what the batch route would do on a real UI click.\n`,
    );
  } else if (result.failed > 0) {
    process.stdout.write(
      `  ✗ ReviseMyMessages reported failures. Most common cause is eBay rejecting\n` +
        `    the MessageID (wrong format or not owned by this account).\n`,
    );
  }

  await db.$disconnect();
}

main().catch(async (err) => {
  process.stderr.write(
    `\nDiagnostic crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
