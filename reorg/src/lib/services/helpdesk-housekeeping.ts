/**
 * Daily housekeeping for the help desk:
 *   - Auto-archives tickets that have been RESOLVED for >= AUTO_ARCHIVE_DAYS.
 *   - Clears stale `snoozedUntil` values that are in the past (folder filters
 *     already ignore them, but cleaning the column makes admin queries cheap).
 *   - Marks notifications older than 30 days as expired (deletes them).
 *
 * Returns a summary so the cron route can log it. Idempotent — safe to run
 * multiple times per day.
 */

import { db } from "@/lib/db";
import { HelpdeskTicketStatus } from "@prisma/client";
import { deriveStatusOnSnoozeWake } from "@/lib/helpdesk/status-routing";

const AUTO_ARCHIVE_DAYS = 30;
const NOTIFICATION_RETENTION_DAYS = 30;

export interface HousekeepingResult {
  archivedCount: number;
  unsnoozedCount: number;
  prunedNotifications: number;
}

export async function runHelpdeskHousekeeping(): Promise<HousekeepingResult> {
  const now = new Date();
  const archiveCutoff = new Date(
    now.getTime() - AUTO_ARCHIVE_DAYS * 86_400_000,
  );
  const archived = await db.helpdeskTicket.updateMany({
    where: {
      status: HelpdeskTicketStatus.RESOLVED,
      isArchived: false,
      resolvedAt: { not: null, lt: archiveCutoff },
    },
    data: { isArchived: true, archivedAt: now },
  });
  if (archived.count > 0) {
    await db.auditLog.create({
      data: {
        action: "HELPDESK_AUTO_ARCHIVED",
        entityType: "HelpdeskTicket",
        details: {
          count: archived.count,
          cutoff: archiveCutoff.toISOString(),
        },
      },
    });
  }

  // Wake snoozed tickets. We have to promote the status (per the eDesk
  // routing model: snoozed → TO_DO when waking, unless the row is spam or
  // archived in which case we leave the underlying status alone). updateMany
  // can't apply per-row logic so we read the rows first, group by target
  // status, then issue one updateMany per target. Cheap because the count
  // is bounded by however many tickets the agents snoozed.
  const waking = await db.helpdeskTicket.findMany({
    where: { snoozedUntil: { not: null, lte: now } },
    select: { id: true, status: true, isSpam: true, isArchived: true },
  });
  const buckets = new Map<HelpdeskTicketStatus, string[]>();
  for (const t of waking) {
    const next = deriveStatusOnSnoozeWake(t.status, {
      isSpam: t.isSpam,
      isArchived: t.isArchived,
    });
    const list = buckets.get(next) ?? [];
    list.push(t.id);
    buckets.set(next, list);
  }
  let unsnoozedCount = 0;
  for (const [status, ids] of buckets.entries()) {
    const r = await db.helpdeskTicket.updateMany({
      where: { id: { in: ids } },
      data: { snoozedUntil: null, snoozedById: null, status },
    });
    unsnoozedCount += r.count;
  }
  if (unsnoozedCount > 0) {
    await db.auditLog.create({
      data: {
        action: "HELPDESK_AUTO_UNSNOOZED",
        entityType: "HelpdeskTicket",
        details: { count: unsnoozedCount },
      },
    });
  }
  const unsnoozed = { count: unsnoozedCount };

  const notifCutoff = new Date(
    now.getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000,
  );
  const pruned = await db.helpdeskNotification.deleteMany({
    where: { createdAt: { lt: notifCutoff } },
  });

  return {
    archivedCount: archived.count,
    unsnoozedCount: unsnoozed.count,
    prunedNotifications: pruned.count,
  };
}
