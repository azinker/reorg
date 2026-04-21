/**
 * Help Desk filter rule engine.
 *
 * A `HelpdeskFilter` is a user-defined inbox rule (think Gmail filters): when
 * a message matches a set of conditions, an action is applied to its parent
 * ticket. The same engine is used in two places:
 *
 *   1. **Live**: invoked from the eBay sync after each newly-inserted message
 *      so that incoming mail is sorted automatically.
 *   2. **On-demand**: invoked from `POST /api/helpdesk/filters/:id/run` to
 *      apply the filter retroactively across the existing inbox.
 *
 * The engine never deletes data. The strongest action it can take is moving
 * a ticket to `archived` / `spam` / `resolved` and adding/removing tags or
 * changing the assignee. This keeps the system aligned with reorG's "no
 * deletion" rule (see AGENTS.md).
 *
 * `conditions` and `action` are stored as JSON on the model so that
 * non-engineers can edit filters from the UI without a schema migration.
 */

import { db } from "@/lib/db";
import { BUYER_CANCELLATION_TAG_NAME } from "@/lib/helpdesk/folders";
import {
  HelpdeskTicketStatus,
  type HelpdeskFilter,
  type HelpdeskMessage,
  type HelpdeskTicket,
  type Prisma,
} from "@prisma/client";

// ─── JSON shapes ─────────────────────────────────────────────────────────────

export type FilterField =
  | "subject"
  | "body"
  | "buyer_username"
  | "from_name";

export type FilterOp =
  | "contains"
  | "equals"
  | "starts_with"
  | "ends_with"
  | "regex";

export interface FilterRule {
  field: FilterField;
  op: FilterOp;
  value: string;
  caseSensitive?: boolean;
}

export interface FilterConditions {
  match: "ALL" | "ANY";
  rules: FilterRule[];
}

/**
 * Folder targets a `MOVE_TO_FOLDER` action can route a matching ticket to.
 *
 *   archived         → sets isArchived=true; ticket disappears from every open folder
 *   spam             → sets isSpam=true and status=SPAM
 *   resolved         → sets status=RESOLVED with resolvedAt=now
 *   inbox            → resets isArchived/isSpam (used to undo an earlier filter)
 *   cancel_requests  → routes to the "Cancel Requests" sidebar folder by tagging
 *                      the ticket with `BUYER_CANCELLATION_TAG_NAME`. The
 *                      ticket keeps its current open status (NEW/TO_DO/WAITING)
 *                      so it stays "live", but `buildFolderWhere()` excludes
 *                      it from All Tickets / New / To Do / Waiting / Pre-sales /
 *                      My Tickets / Unassigned / Mentioned. This is the
 *                      user-facing "move to Cancel Requests" choice in the
 *                      THEN dropdown on /help-desk/filters.
 */
export type FilterActionFolder =
  | "archived"
  | "spam"
  | "resolved"
  | "inbox"
  | "cancel_requests";

export interface FilterAction {
  type: "MOVE_TO_FOLDER";
  folder: FilterActionFolder;
  addTagIds?: string[];
  removeTagIds?: string[];
  assignToUserId?: string | null;
}

// ─── Validation helpers ──────────────────────────────────────────────────────

const VALID_FIELDS: ReadonlySet<FilterField> = new Set([
  "subject",
  "body",
  "buyer_username",
  "from_name",
]);
const VALID_OPS: ReadonlySet<FilterOp> = new Set([
  "contains",
  "equals",
  "starts_with",
  "ends_with",
  "regex",
]);
const VALID_FOLDERS: ReadonlySet<FilterActionFolder> = new Set([
  "archived",
  "spam",
  "resolved",
  "inbox",
  "cancel_requests",
]);

/**
 * Parse + validate untrusted JSON into a `FilterConditions`. Throws on
 * malformed input so that API handlers can return 400.
 */
export function parseConditions(input: unknown): FilterConditions {
  if (!input || typeof input !== "object") {
    throw new Error("Filter conditions must be an object");
  }
  const obj = input as Record<string, unknown>;
  const match = obj.match === "ANY" ? "ANY" : "ALL";
  const rulesRaw = Array.isArray(obj.rules) ? obj.rules : null;
  if (!rulesRaw || rulesRaw.length === 0) {
    throw new Error("Filter must contain at least one rule");
  }
  if (rulesRaw.length > 20) {
    throw new Error("Filters may have at most 20 rules");
  }
  const rules: FilterRule[] = rulesRaw.map((r, idx) => {
    if (!r || typeof r !== "object") {
      throw new Error(`Rule ${idx} must be an object`);
    }
    const ro = r as Record<string, unknown>;
    const field = String(ro.field) as FilterField;
    const op = String(ro.op) as FilterOp;
    const value = typeof ro.value === "string" ? ro.value : "";
    if (!VALID_FIELDS.has(field)) throw new Error(`Rule ${idx}: invalid field "${field}"`);
    if (!VALID_OPS.has(op)) throw new Error(`Rule ${idx}: invalid op "${op}"`);
    if (value.length === 0) throw new Error(`Rule ${idx}: value is required`);
    if (value.length > 500) throw new Error(`Rule ${idx}: value too long (max 500)`);
    if (op === "regex") {
      try {
        new RegExp(value);
      } catch {
        throw new Error(`Rule ${idx}: invalid regex`);
      }
    }
    return {
      field,
      op,
      value,
      caseSensitive: Boolean(ro.caseSensitive),
    };
  });
  return { match, rules };
}

export function parseAction(input: unknown): FilterAction {
  if (!input || typeof input !== "object") {
    throw new Error("Filter action must be an object");
  }
  const obj = input as Record<string, unknown>;
  if (obj.type !== "MOVE_TO_FOLDER") {
    throw new Error(`Unsupported action type: ${String(obj.type)}`);
  }
  const folder = String(obj.folder) as FilterActionFolder;
  if (!VALID_FOLDERS.has(folder)) {
    throw new Error(`Invalid action folder: ${folder}`);
  }
  const addTagIds = Array.isArray(obj.addTagIds)
    ? (obj.addTagIds as unknown[]).map(String).filter(Boolean)
    : undefined;
  const removeTagIds = Array.isArray(obj.removeTagIds)
    ? (obj.removeTagIds as unknown[]).map(String).filter(Boolean)
    : undefined;
  const assignToUserId =
    obj.assignToUserId === null
      ? null
      : typeof obj.assignToUserId === "string"
        ? obj.assignToUserId
        : undefined;
  return {
    type: "MOVE_TO_FOLDER",
    folder,
    ...(addTagIds && addTagIds.length > 0 ? { addTagIds } : {}),
    ...(removeTagIds && removeTagIds.length > 0 ? { removeTagIds } : {}),
    ...(assignToUserId !== undefined ? { assignToUserId } : {}),
  };
}

// ─── Matching ────────────────────────────────────────────────────────────────

interface MatchableMessage {
  subject: string | null;
  bodyText: string;
  fromName: string | null;
  fromIdentifier: string | null;
}

interface MatchableTicket {
  buyerUserId: string | null;
  buyerName: string | null;
}

/** Pull the comparand for a single rule out of the message + ticket pair. */
function extractField(
  field: FilterField,
  msg: MatchableMessage,
  ticket: MatchableTicket,
): string {
  switch (field) {
    case "subject":
      return msg.subject ?? "";
    case "body":
      return msg.bodyText ?? "";
    case "buyer_username":
      return ticket.buyerUserId ?? "";
    case "from_name":
      return msg.fromName ?? ticket.buyerName ?? msg.fromIdentifier ?? "";
  }
}

function ruleMatches(
  rule: FilterRule,
  msg: MatchableMessage,
  ticket: MatchableTicket,
): boolean {
  const haystack = extractField(rule.field, msg, ticket);
  const needle = rule.value;
  const cs = rule.caseSensitive === true;
  const hay = cs ? haystack : haystack.toLowerCase();
  const ndl = cs ? needle : needle.toLowerCase();
  switch (rule.op) {
    case "contains":
      return hay.includes(ndl);
    case "equals":
      return hay === ndl;
    case "starts_with":
      return hay.startsWith(ndl);
    case "ends_with":
      return hay.endsWith(ndl);
    case "regex":
      try {
        return new RegExp(needle, cs ? "" : "i").test(haystack);
      } catch {
        return false;
      }
  }
}

export function evaluateConditions(
  conditions: FilterConditions,
  msg: MatchableMessage,
  ticket: MatchableTicket,
): boolean {
  if (conditions.rules.length === 0) return false;
  if (conditions.match === "ALL") {
    return conditions.rules.every((r) => ruleMatches(r, msg, ticket));
  }
  return conditions.rules.some((r) => ruleMatches(r, msg, ticket));
}

// ─── Application ─────────────────────────────────────────────────────────────

export interface ApplyResult {
  ticketId: string;
  filterId: string;
  filterName: string;
  folder: FilterActionFolder;
  appliedAt: Date;
}

/**
 * Apply a filter's `action` to a single ticket. Idempotent — running twice on
 * an already-archived ticket is a cheap no-op.
 *
 * NOTE: this never deletes anything. "Move to archived" sets `isArchived=true`
 * but keeps the underlying messages intact.
 */
export async function applyFilterAction(
  filter: Pick<HelpdeskFilter, "id" | "name" | "action">,
  ticketId: string,
  triggeredByUserId: string | null,
): Promise<ApplyResult> {
  const action = parseAction(filter.action);

  const data: Prisma.HelpdeskTicketUpdateInput = {};
  switch (action.folder) {
    case "archived":
      data.isArchived = true;
      data.archivedAt = new Date();
      break;
    case "spam":
      data.isSpam = true;
      data.status = HelpdeskTicketStatus.SPAM;
      break;
    case "resolved":
      data.status = HelpdeskTicketStatus.RESOLVED;
      data.resolvedAt = new Date();
      break;
    case "inbox":
      data.isArchived = false;
      data.archivedAt = null;
      data.isSpam = false;
      break;
    case "cancel_requests":
      // Status-neutral: we want the ticket to stay NEW/TO_DO/WAITING so the
      // agent still sees it as "live work" — but `buildFolderWhere()` skips
      // any open ticket carrying the cancellation tag (applied below) so it
      // only appears in the Cancel Requests sidebar folder. We also clear
      // archived/spam in case a previous filter hid the row.
      data.isArchived = false;
      data.archivedAt = null;
      data.isSpam = false;
      break;
  }

  if (action.assignToUserId !== undefined) {
    data.primaryAssignee =
      action.assignToUserId === null
        ? { disconnect: true }
        : { connect: { id: action.assignToUserId } };
  }

  const updated = await db.helpdeskTicket.update({
    where: { id: ticketId },
    data,
    select: { id: true },
  });

  // Build the final list of tag ids to apply. For `cancel_requests` we
  // append the reserved cancellation tag id (lazily upserted on first use so
  // operators don't have to run a seed script). This piggybacks on the
  // existing `addTagIds` machinery so the sync's per-message hot loop only
  // ever touches one createMany call.
  const tagIdsToAdd: string[] = [...(action.addTagIds ?? [])];
  if (action.folder === "cancel_requests") {
    const tag = await db.helpdeskTag.upsert({
      where: { name: BUYER_CANCELLATION_TAG_NAME },
      update: {},
      create: {
        name: BUYER_CANCELLATION_TAG_NAME,
        description:
          "Buyer asked to cancel the order. Routed by a 'Move to Cancel Requests' filter.",
        color: "#ef4444",
      },
      select: { id: true },
    });
    if (!tagIdsToAdd.includes(tag.id)) tagIdsToAdd.push(tag.id);
  }

  // Tag mutations are separate junction-table writes.
  if (tagIdsToAdd.length > 0) {
    await db.helpdeskTicketTag.createMany({
      data: tagIdsToAdd.map((tagId) => ({
        ticketId: updated.id,
        tagId,
        addedById: triggeredByUserId,
      })),
      skipDuplicates: true,
    });
  }
  if (action.removeTagIds && action.removeTagIds.length > 0) {
    await db.helpdeskTicketTag.deleteMany({
      where: {
        ticketId: updated.id,
        tagId: { in: action.removeTagIds },
      },
    });
  }

  return {
    ticketId: updated.id,
    filterId: filter.id,
    filterName: filter.name,
    folder: action.folder,
    appliedAt: new Date(),
  };
}

// ─── On-demand "Run filter" over the existing inbox ──────────────────────────

export interface RunFilterResult {
  filterId: string;
  filterName: string;
  scanned: number;
  matched: number;
  applied: number;
  examples: { ticketId: string; subject: string | null }[];
}

/**
 * Translate a single rule into a Prisma `where` predicate so the DB can do
 * the heavy lifting. Returns `null` when the rule can't be expressed in SQL
 * (currently only `regex` — Postgres can do regex via `~` but Prisma's QM
 * doesn't expose case-insensitive regex portably across providers, so we
 * fall back to in-memory evaluation for those).
 *
 * Field mapping:
 *   - subject / body / from_name → message-level columns
 *   - buyer_username             → ticket relation
 */
function ruleToPrismaWhere(rule: FilterRule): Prisma.HelpdeskMessageWhereInput | null {
  if (rule.op === "regex") return null;
  const mode: "default" | "insensitive" = rule.caseSensitive ? "default" : "insensitive";

  // Build the string predicate based on the operator. Prisma accepts the
  // same shape (`{ contains, mode }` etc) on every string column.
  const stringFilter: Prisma.StringFilter | Prisma.StringNullableFilter = (() => {
    switch (rule.op) {
      case "contains":
        return { contains: rule.value, mode };
      case "equals":
        return { equals: rule.value, mode };
      case "starts_with":
        return { startsWith: rule.value, mode };
      case "ends_with":
        return { endsWith: rule.value, mode };
    }
  })();

  switch (rule.field) {
    case "subject":
      return { subject: stringFilter as Prisma.StringNullableFilter };
    case "body":
      return { bodyText: stringFilter as Prisma.StringFilter };
    case "buyer_username":
      return {
        ticket: {
          is: { buyerUserId: stringFilter as Prisma.StringNullableFilter },
        },
      };
    case "from_name":
      // from_name resolution is `msg.fromName ?? ticket.buyerName ?? msg.fromIdentifier`,
      // so the SQL prefilter has to OR all three. The in-memory pass below
      // still re-validates with the canonical extractor so this can over-match
      // safely without producing false positives.
      return {
        OR: [
          { fromName: stringFilter as Prisma.StringNullableFilter },
          { fromIdentifier: stringFilter as Prisma.StringNullableFilter },
          { ticket: { is: { buyerName: stringFilter as Prisma.StringNullableFilter } } },
        ],
      };
  }
}

/**
 * Compose a `where` clause that prefilters down to messages the rule set
 * could possibly match. We always require the message to be INBOUND or an
 * OUTBOUND eBay-system notification (`authorUserId IS NULL`) because agent
 * replies must never be archived by a filter.
 *
 * Returns `null` when no rule can be expressed in SQL — the caller then has
 * to scan the full eligible message pool. In practice only `regex` triggers
 * the fallback.
 */
function conditionsToPrismaWhere(
  conditions: FilterConditions,
): Prisma.HelpdeskMessageWhereInput | null {
  const parts: Prisma.HelpdeskMessageWhereInput[] = [];
  for (const r of conditions.rules) {
    const w = ruleToPrismaWhere(r);
    if (w) parts.push(w);
  }
  if (parts.length === 0) return null;

  // ALL → AND, ANY → OR. When `match=ALL` and SOME rules are regex (and so
  // dropped here), the SQL prefilter is over-permissive but the in-memory
  // pass still re-validates the full rule set, so accuracy is preserved.
  const ruleClause: Prisma.HelpdeskMessageWhereInput =
    conditions.match === "ALL" ? { AND: parts } : { OR: parts };

  return {
    AND: [
      {
        OR: [
          { direction: "INBOUND" },
          { direction: "OUTBOUND", authorUserId: null },
        ],
      },
      ruleClause,
    ],
  };
}

/**
 * Execute a filter against every ticket's most recent matchable message. We
 * scan two populations:
 *
 *   1. INBOUND — buyer → us (the obvious case)
 *   2. OUTBOUND with `authorUserId IS NULL` — eBay-system notifications that
 *      eBay sent on our behalf (e.g. "Thank You! Your item has been Shipped",
 *      "Refund issued", "We sent your payout"). These appear as outbound on
 *      the seller's side but no human in our app composed them, so it's safe
 *      for filter rules to match them by subject.
 *
 * We intentionally exclude OUTBOUND with `authorUserId` set — those are real
 * agent replies typed in our composer, and archiving an agent's own reply is
 * rarely what the user wants.
 *
 * Strategy: push the rule set down to Postgres via a Prisma `where`. The
 * earlier implementation pulled the most recent 5000 messages and evaluated
 * in JS, which caused a real production bug — once the user had >5000 recent
 * INBOUND/system messages, AR-trigger sub-messages older than ~3 weeks were
 * invisible to "Run filter", leaving ~1200 matching tickets stuck in the
 * open inbox. Now we paginate over EVERY matching message via cursor so the
 * filter can converge no matter how big the inbox is. Regex rules fall back
 * to a bounded scan because Prisma can't push them down portably.
 */
export async function runFilterOverInbox(
  filterId: string,
  triggeredByUserId: string | null,
): Promise<RunFilterResult> {
  const filter = await db.helpdeskFilter.findUnique({
    where: { id: filterId },
  });
  if (!filter) throw new Error(`Filter not found: ${filterId}`);

  const conditions = parseConditions(filter.conditions);
  const sqlWhere = conditionsToPrismaWhere(conditions);

  type Page = Array<{
    id: string;
    subject: string | null;
    bodyText: string;
    fromName: string | null;
    fromIdentifier: string | null;
    ticket: {
      id: string;
      buyerUserId: string | null;
      buyerName: string | null;
      isArchived: boolean;
      isSpam: boolean;
      status: HelpdeskTicketStatus;
    };
  }>;

  // Cursor-paginate over the candidate pool so we cover the entire inbox.
  // Each page is bounded to PAGE_SIZE for memory safety, and the OUTER cap
  // (HARD_CAP) is high enough to clear any realistic backlog while still
  // protecting against runaway loops.
  const PAGE_SIZE = 1000;
  const HARD_CAP = 200_000;

  const baseWhere: Prisma.HelpdeskMessageWhereInput = sqlWhere ?? {
    OR: [
      { direction: "INBOUND" },
      { direction: "OUTBOUND", authorUserId: null },
    ],
  };

  let scanned = 0;
  let cursor: string | undefined;
  const seen = new Set<string>();
  const matchedTickets: { ticketId: string; subject: string | null }[] = [];

  while (scanned < HARD_CAP) {
    const page: Page = await db.helpdeskMessage.findMany({
      where: baseWhere,
      orderBy: { sentAt: "desc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        subject: true,
        bodyText: true,
        fromName: true,
        fromIdentifier: true,
        ticket: {
          select: {
            id: true,
            buyerUserId: true,
            buyerName: true,
            isArchived: true,
            isSpam: true,
            status: true,
          },
        },
      },
    });
    if (page.length === 0) break;
    scanned += page.length;
    cursor = page[page.length - 1]?.id;

    for (const m of page) {
      if (seen.has(m.ticket.id)) continue;
      // Always re-validate in JS against the FULL rule set. The SQL prefilter
      // is permissive (regex rules dropped, from_name OR'd) so this guards
      // against false positives without paying the cost on already-rejected
      // rows.
      const isMatch = evaluateConditions(
        conditions,
        {
          subject: m.subject,
          bodyText: m.bodyText,
          fromName: m.fromName,
          fromIdentifier: m.fromIdentifier,
        },
        {
          buyerUserId: m.ticket.buyerUserId,
          buyerName: m.ticket.buyerName,
        },
      );
      if (isMatch) {
        seen.add(m.ticket.id);
        matchedTickets.push({ ticketId: m.ticket.id, subject: m.subject });
      }
    }

    if (page.length < PAGE_SIZE) break;
  }

  let applied = 0;
  for (const m of matchedTickets) {
    try {
      await applyFilterAction(filter, m.ticketId, triggeredByUserId);
      applied++;
    } catch (err) {
      console.error(
        `[helpdesk-filter] apply failed for ticket ${m.ticketId}`,
        err,
      );
    }
  }

  // Write back stats so the UI can show "last run X minutes ago — Y hits".
  await db.helpdeskFilter.update({
    where: { id: filter.id },
    data: {
      lastRunAt: new Date(),
      lastRunHits: matchedTickets.length,
      totalHits: { increment: applied },
    },
  });

  return {
    filterId: filter.id,
    filterName: filter.name,
    scanned,
    matched: matchedTickets.length,
    applied,
    examples: matchedTickets.slice(0, 5),
  };
}

// ─── Retroactive auto-resolve ────────────────────────────────────────────────

export interface AutoResolveResult {
  scanned: number;
  resolved: number;
}

/**
 * Walk every open ticket and mark it RESOLVED when the most recent message is
 * outbound. Used once after the initial 180-day backfill to catch the case
 * where an agent already replied on eBay before reorG existed — those threads
 * shouldn't show up in the "needs attention" inbox.
 *
 * Idempotent: tickets that are already RESOLVED, SPAM, or archived are skipped.
 */
export async function autoResolveAlreadyAnswered(): Promise<AutoResolveResult> {
  const openTickets = await db.helpdeskTicket.findMany({
    where: {
      status: { in: [HelpdeskTicketStatus.NEW, HelpdeskTicketStatus.TO_DO, HelpdeskTicketStatus.WAITING] },
      isArchived: false,
      isSpam: false,
      lastAgentMessageAt: { not: null },
    },
    select: {
      id: true,
      lastAgentMessageAt: true,
      lastBuyerMessageAt: true,
    },
  });

  let resolved = 0;
  for (const t of openTickets) {
    const agent = t.lastAgentMessageAt?.getTime() ?? 0;
    const buyer = t.lastBuyerMessageAt?.getTime() ?? 0;
    if (agent <= buyer) continue;
    await db.helpdeskTicket.update({
      where: { id: t.id },
      data: {
        status: HelpdeskTicketStatus.RESOLVED,
        resolvedAt: t.lastAgentMessageAt ?? new Date(),
        unreadCount: 0,
      },
    });
    resolved++;
  }

  return { scanned: openTickets.length, resolved };
}

// ─── Live evaluation hook (invoked from sync) ────────────────────────────────

/**
 * Evaluate every enabled filter against a freshly-inserted message. Returns
 * the filters that matched (in `sortOrder`) so the caller can decide whether
 * to apply them. Pass an already-loaded array of filters to avoid hammering
 * the DB during a busy sync tick.
 */
export function pickMatchingFilters(
  filters: HelpdeskFilter[],
  message: Pick<HelpdeskMessage, "subject" | "bodyText" | "fromName" | "fromIdentifier">,
  ticket: Pick<HelpdeskTicket, "buyerUserId" | "buyerName">,
): HelpdeskFilter[] {
  const out: HelpdeskFilter[] = [];
  for (const f of filters) {
    if (!f.enabled) continue;
    let conds: FilterConditions;
    try {
      conds = parseConditions(f.conditions);
    } catch {
      continue;
    }
    if (
      evaluateConditions(
        conds,
        {
          subject: message.subject,
          bodyText: message.bodyText,
          fromName: message.fromName,
          fromIdentifier: message.fromIdentifier,
        },
        {
          buyerUserId: ticket.buyerUserId,
          buyerName: ticket.buyerName,
        },
      )
    ) {
      out.push(f);
    }
  }
  return out;
}
