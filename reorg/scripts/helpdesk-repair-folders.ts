/**
 * One-off repair pass for Help Desk folder state.
 *
 * Why this exists:
 *   The folder-organization logic evolved over many sessions:
 *     - AR-only archiving (`helpdesk-ebay-sync.ts` Rule 2)
 *     - Bounce-out-of-archive on inbound buyer reply
 *     - Unread/Read split via `unreadCount`
 *     - SYSTEM (FROM EBAY) isolation
 *     - eBay-unread → TO_DO + un-archive (new this session)
 *
 *   Existing rows in prod were written BEFORE some of these rules landed,
 *   so their `isArchived` / `status` / `unreadCount` flags may not match
 *   what the current rules would produce. This script re-evaluates every
 *   non-spam ticket against the current rules and prints (or applies) a
 *   minimal set of updates to bring them into compliance.
 *
 * Rules applied:
 *
 *   R1. AR-only archive.
 *       If the ticket has zero INBOUND messages AND at least one
 *       AUTO_RESPONDER message AND is not already archived AND is not
 *       SYSTEM / spam → archive it (isArchived=true, archivedAt=now,
 *       status=RESOLVED).
 *
 *   R2. Bounce-out-of-archive.
 *       If the ticket IS archived AND has at least one INBOUND message
 *       AND is not spam → un-archive (isArchived=false, archivedAt=null,
 *       status=TO_DO) so a buyer reply never stays hidden.
 *
 *   R3. SYSTEM tickets never live in To Do / Waiting / Archive.
 *       If type=SYSTEM and isArchived=true (shouldn't happen but legacy
 *       rows exist) → un-archive. Status defaults to RESOLVED for SYSTEM.
 *
 *   R4. Pre-sales verification (report only, never auto-fixes).
 *       Log any ticket with kind=PRE_SALES or type=PRE_SALES that has a
 *       non-empty ebayOrderNumber — those are actually post-sale in
 *       disguise and the user asked us to confirm the folder is correct.
 *
 * Safety:
 *   - Default is DRY RUN. Pass `--apply` to write.
 *   - Never touches spam tickets (those are intentionally hidden).
 *   - Never calls eBay. This is a local-DB hygiene pass.
 *   - Prints a summary per rule + sample ticket IDs for audit.
 *
 * Usage (from reorg/):
 *   # Dry run (no writes):
 *   npx tsx -r dotenv/config scripts/helpdesk-repair-folders.ts
 *
 *   # Apply fixes:
 *   npx tsx -r dotenv/config scripts/helpdesk-repair-folders.ts --apply
 *
 *   # Scope to a single integration:
 *   npx tsx -r dotenv/config scripts/helpdesk-repair-folders.ts --integration <integrationId>
 */

import {
  HelpdeskMessageDirection,
  HelpdeskMessageSource,
  HelpdeskTicketKind,
  HelpdeskTicketStatus,
  HelpdeskTicketType,
} from "@prisma/client";
import { db } from "@/lib/db";

interface Args {
  apply: boolean;
  integrationId: string | null;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, integrationId: null, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a === "--integration") args.integrationId = (argv[++i] ?? "").trim();
    else if (a === "--limit") args.limit = Number(argv[++i] ?? 0) || 0;
  }
  return args;
}

interface TicketRow {
  id: string;
  integrationLabel: string;
  status: HelpdeskTicketStatus;
  type: HelpdeskTicketType;
  kind: HelpdeskTicketKind;
  isArchived: boolean;
  isSpam: boolean;
  ebayOrderNumber: string | null;
  inboundCount: number;
  arCount: number;
  unreadCount: number;
}

async function loadTickets(args: Args): Promise<TicketRow[]> {
  // Single grouped aggregate instead of N+1 counts per ticket. We fetch the
  // ticket list, then two targeted groupBy rollups over HelpdeskMessage,
  // and join them in-memory. Keeps the full-prod pass well under a minute.
  const tickets = await db.helpdeskTicket.findMany({
    where: {
      isSpam: false,
      ...(args.integrationId ? { integrationId: args.integrationId } : {}),
    },
    select: {
      id: true,
      integration: { select: { label: true } },
      status: true,
      type: true,
      kind: true,
      isArchived: true,
      isSpam: true,
      ebayOrderNumber: true,
      unreadCount: true,
    },
    orderBy: { updatedAt: "desc" },
    ...(args.limit > 0 ? { take: args.limit } : {}),
  });

  const ticketIds = tickets.map((t) => t.id);
  if (ticketIds.length === 0) return [];

  const inboundGroups = await db.helpdeskMessage.groupBy({
    by: ["ticketId"],
    where: {
      ticketId: { in: ticketIds },
      direction: HelpdeskMessageDirection.INBOUND,
    },
    _count: { _all: true },
  });
  const inboundByTicket = new Map<string, number>();
  for (const g of inboundGroups) inboundByTicket.set(g.ticketId, g._count._all);

  const arGroups = await db.helpdeskMessage.groupBy({
    by: ["ticketId"],
    where: {
      ticketId: { in: ticketIds },
      source: HelpdeskMessageSource.AUTO_RESPONDER,
    },
    _count: { _all: true },
  });
  const arByTicket = new Map<string, number>();
  for (const g of arGroups) arByTicket.set(g.ticketId, g._count._all);

  return tickets.map((t) => ({
    id: t.id,
    integrationLabel: t.integration.label,
    status: t.status,
    type: t.type,
    kind: t.kind,
    isArchived: t.isArchived,
    isSpam: t.isSpam,
    ebayOrderNumber: t.ebayOrderNumber,
    inboundCount: inboundByTicket.get(t.id) ?? 0,
    arCount: arByTicket.get(t.id) ?? 0,
    unreadCount: t.unreadCount,
  }));
}

interface Update {
  ticketId: string;
  rule: string;
  before: Partial<TicketRow>;
  after: {
    isArchived?: boolean;
    archivedAt?: Date | null;
    status?: HelpdeskTicketStatus;
  };
}

function diagnose(rows: TicketRow[]): {
  updates: Update[];
  presalesWithOrder: TicketRow[];
} {
  const updates: Update[] = [];
  const presalesWithOrder: TicketRow[] = [];

  for (const t of rows) {
    // R3 — SYSTEM tickets in archive = structural bug. Un-archive; SYSTEM
    // tickets belong in "From eBay" which filters on type alone.
    if (t.type === HelpdeskTicketType.SYSTEM && t.isArchived) {
      updates.push({
        ticketId: t.id,
        rule: "R3_system_unarchive",
        before: { isArchived: t.isArchived, status: t.status },
        after: {
          isArchived: false,
          archivedAt: null,
          status: HelpdeskTicketStatus.RESOLVED,
        },
      });
      continue;
    }

    // R2 — Bounce-out-of-archive. If a buyer ever replied, the ticket
    // must not be in Archive regardless of what an old sync wrote.
    if (t.isArchived && t.inboundCount > 0) {
      updates.push({
        ticketId: t.id,
        rule: "R2_bounce_out_of_archive",
        before: { isArchived: t.isArchived, status: t.status },
        after: {
          isArchived: false,
          archivedAt: null,
          status: HelpdeskTicketStatus.TO_DO,
        },
      });
      continue;
    }

    // R1 — AR-only archive. Zero inbound + ≥1 AR outbound = archive.
    if (
      !t.isArchived &&
      t.type !== HelpdeskTicketType.SYSTEM &&
      t.inboundCount === 0 &&
      t.arCount > 0
    ) {
      updates.push({
        ticketId: t.id,
        rule: "R1_ar_only_archive",
        before: { isArchived: t.isArchived, status: t.status },
        after: {
          isArchived: true,
          archivedAt: new Date(),
          status: HelpdeskTicketStatus.RESOLVED,
        },
      });
      continue;
    }

    // R4 — Pre-sales verification: anything currently tagged PRE_SALES but
    // carrying an order number was post-sale all along.
    const isPresales =
      t.kind === HelpdeskTicketKind.PRE_SALES ||
      t.type === HelpdeskTicketType.PRE_SALES;
    if (isPresales && t.ebayOrderNumber) {
      presalesWithOrder.push(t);
    }
  }

  return { updates, presalesWithOrder };
}

async function applyUpdates(updates: Update[]): Promise<void> {
  // Chunk writes so we don't blow the query size limit on big repair runs.
  const CHUNK = 100;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await db.$transaction(
      chunk.map((u) =>
        db.helpdeskTicket.update({
          where: { id: u.ticketId },
          data: u.after,
        }),
      ),
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.apply ? "APPLY" : "DRY-RUN";
  console.info(`[helpdesk-repair] starting ${mode}`, {
    integrationId: args.integrationId,
    limit: args.limit || "all",
  });

  const rows = await loadTickets(args);
  console.info(`[helpdesk-repair] loaded ${rows.length} non-spam tickets`);

  const { updates, presalesWithOrder } = diagnose(rows);

  const byRule = new Map<string, Update[]>();
  for (const u of updates) {
    const list = byRule.get(u.rule) ?? [];
    list.push(u);
    byRule.set(u.rule, list);
  }

  console.info("[helpdesk-repair] proposed updates by rule:");
  for (const [rule, list] of byRule.entries()) {
    console.info(`  ${rule}: ${list.length}`);
    for (const sample of list.slice(0, 5)) {
      console.info(`    - ${sample.ticketId}  before=`, sample.before, " after=", sample.after);
    }
    if (list.length > 5) console.info(`    … and ${list.length - 5} more`);
  }

  if (presalesWithOrder.length > 0) {
    console.warn(
      `[helpdesk-repair] R4 Pre-sales warning: ${presalesWithOrder.length} tickets classified as pre-sales but carry an ebayOrderNumber`,
    );
    for (const t of presalesWithOrder.slice(0, 10)) {
      console.warn(
        `    - ${t.id}  order=${t.ebayOrderNumber}  kind=${t.kind}  type=${t.type}  inbound=${t.inboundCount}`,
      );
    }
    if (presalesWithOrder.length > 10) {
      console.warn(`    … and ${presalesWithOrder.length - 10} more`);
    }
    console.warn(
      "[helpdesk-repair] Pre-sales fix is NOT automated — if the order number is real, the correct path is to re-classify as QUERY (or whatever post-sale category fits).",
    );
  }

  if (!args.apply) {
    console.info("[helpdesk-repair] DRY-RUN complete. Re-run with --apply to write.");
    return;
  }

  if (updates.length === 0) {
    console.info("[helpdesk-repair] Nothing to fix.");
    return;
  }

  await applyUpdates(updates);
  console.info(`[helpdesk-repair] applied ${updates.length} updates`);
}

main()
  .catch((err) => {
    console.error("[helpdesk-repair] failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
