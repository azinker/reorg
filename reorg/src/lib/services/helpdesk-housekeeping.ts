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

  const unsnoozed = await db.helpdeskTicket.updateMany({
    where: { snoozedUntil: { not: null, lte: now } },
    data: { snoozedUntil: null, snoozedById: null },
  });

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
