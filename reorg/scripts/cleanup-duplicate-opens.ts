/**
 * One-shot cleanup: collapse HELPDESK_TICKET_OPENED audit rows so the timeline
 * only shows opens that actually represent meaningful agent activity:
 *
 *   - Hard window: only one open per (agent, ticket) per 30-minute slot.
 *   - Activity gate: when the same agent re-opens a ticket they already
 *     opened, only keep the new one if the ticket has changed since
 *     (new buyer/agent message, status flip, assignment, etc., as
 *     reflected by helpdesk_tickets.updatedAt).
 *
 * Safe to re-run; will simply find nothing to delete the second time.
 */
import { db } from "../src/lib/db";

async function main() {
  const rawOpens = await db.auditLog.findMany({
    where: {
      action: "HELPDESK_TICKET_OPENED",
      entityType: "HelpdeskTicket",
    },
    orderBy: [
      { entityId: "asc" },
      { userId: "asc" },
      { createdAt: "asc" },
    ],
    select: { id: true, userId: true, entityId: true, createdAt: true },
  });

  // AuditLog allows nullable entityId/userId for system-emitted rows, but
  // a HELPDESK_TICKET_OPENED row without both is meaningless to dedupe (we
  // can't know which agent or which ticket it belongs to). Filter those
  // out up front so the rest of the pipeline can treat the fields as
  // non-null without sprinkling guards everywhere.
  const opens = rawOpens.filter(
    (o): o is typeof o & { entityId: string; userId: string } =>
      typeof o.entityId === "string" && typeof o.userId === "string",
  );

  // Pull all touched tickets so we can read their updatedAt without
  // hammering the DB once per row.
  const ticketIds = Array.from(new Set(opens.map((o) => o.entityId)));
  const tickets = await db.helpdeskTicket.findMany({
    where: { id: { in: ticketIds } },
    select: { id: true, updatedAt: true },
  });
  const ticketUpdatedAt = new Map(
    tickets.map((t) => [t.id, t.updatedAt] as const),
  );

  const toDelete: string[] = [];
  let lastEntity: string | null = null;
  let lastUser: string | null = null;
  let lastTime: Date | null = null;
  const WINDOW_MS = 30 * 60_000;

  for (const row of opens) {
    const sameKey = row.entityId === lastEntity && row.userId === lastUser;

    if (sameKey && lastTime) {
      const gap = row.createdAt.getTime() - lastTime.getTime();
      if (gap < WINDOW_MS) {
        // Inside the 30-minute hard debounce window — drop.
        toDelete.push(row.id);
        continue;
      }
      // Outside the window: apply the activity gate. If the ticket's
      // updatedAt is older than this row, then between lastTime and now
      // nothing new happened on the ticket, so this open is just the
      // agent revisiting — drop it.
      const tUpdated = ticketUpdatedAt.get(row.entityId);
      if (tUpdated && tUpdated <= lastTime) {
        toDelete.push(row.id);
        continue;
      }
    }

    lastEntity = row.entityId;
    lastUser = row.userId;
    lastTime = row.createdAt;
  }

  console.log(
    `Found ${opens.length} HELPDESK_TICKET_OPENED rows across ${ticketIds.length} tickets; deleting ${toDelete.length} duplicates.`,
  );

  if (toDelete.length > 0) {
    const result = await db.auditLog.deleteMany({
      where: { id: { in: toDelete } },
    });
    console.log(`Deleted ${result.count} rows.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
