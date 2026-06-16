/**
 * One-off repair: outbound jobs falsely marked FAILED by the
 * (ticketId, externalId) unique-constraint race.
 *
 * Background: the eBay Commerce Message send succeeded, but the inbound
 * sweep ingested the sent message (cm:<id>) before the worker's own
 * bookkeeping transaction ran. The worker's hard create() then hit the
 * unique constraint, the job was marked FAILED, and the UI shows
 * "Last reply failed" with a Retry button that would DOUBLE-SEND.
 *
 * This script:
 *   1. Finds FAILED jobs whose lastError is the unique-constraint Prisma
 *      error.
 *   2. Verifies a matching OUTBOUND HelpdeskMessage row exists for the
 *      ticket (the sweep's copy) with the same body text.
 *   3. Marks the job SENT (it was), links the message's ebayMessageId,
 *      and stamps agent attribution (authorUserId/fromName) on the
 *      sweep's anonymized message row. Bodies are never touched.
 *
 * Read-only unless --apply is passed.
 * PROD-GUARDED: refuses to run unless DATABASE_URL host contains
 * "little-fire".
 */

import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs";
import * as path from "node:path";

function loadEnvProd(): void {
  const envPath = path.resolve(__dirname, "..", ".env.prod");
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env.prod not found at ${envPath}`);
  }
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  loadEnvProd();

  const dbUrl = process.env.DATABASE_URL ?? "";
  const host = dbUrl.match(/@([^/?]+)/)?.[1] ?? "(unknown)";
  console.log(`Resolved DB host: ${host}`);
  if (!host.includes("little-fire")) {
    throw new Error("Refusing to run: DATABASE_URL host does not contain 'little-fire' (prod guard).");
  }

  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  const failedJobs = await db.helpdeskOutboundJob.findMany({
    where: {
      status: "FAILED",
      lastError: { contains: "Unique constraint failed" },
    },
    include: { ticket: { select: { id: true, subject: true, ebayOrderNumber: true } } },
    orderBy: { createdAt: "desc" },
  });

  console.log(`Found ${failedJobs.length} FAILED job(s) with unique-constraint errors.\n`);

  for (const job of failedJobs) {
    console.log(`Job ${job.id}`);
    console.log(`  ticket: ${job.ticketId} (order ${job.ticket.ebayOrderNumber ?? "?"})`);
    console.log(`  composerMode: ${job.composerMode}, createdAt: ${job.createdAt.toISOString()}`);
    console.log(`  lastError: ${job.lastError?.slice(0, 160)}`);

    // Find the sweep-ingested copy of this exact message. Prefer the
    // canonical `cm:` row (the one the worker's create collided with);
    // fall back to any OUTBOUND copy with the same body.
    const candidates = await db.helpdeskMessage.findMany({
      where: {
        ticketId: job.ticketId,
        direction: "OUTBOUND",
        bodyText: job.bodyText,
        sentAt: { gte: job.createdAt },
      },
      orderBy: { sentAt: "asc" },
    });
    const msg =
      candidates.find((c) => c.externalId?.startsWith("cm:")) ?? candidates[0] ?? null;

    if (!msg) {
      console.log("  -> NO matching OUTBOUND message row found; skipping (manual review needed).\n");
      continue;
    }

    console.log(`  matched message ${msg.id} (externalId=${msg.externalId}, sentAt=${msg.sentAt?.toISOString()}, author=${msg.authorUserId ?? "null"})`);

    if (!apply) {
      console.log("  DRY RUN — would: mark job SENT, stamp attribution on message.\n");
      continue;
    }

    await db.$transaction(async (tx) => {
      // Attribution only — body is never touched. ThreadView joins the
      // author relation for the display name.
      await tx.helpdeskMessage.update({
        where: { id: msg.id },
        data: { authorUserId: job.authorUserId },
      });
      await tx.helpdeskOutboundJob.update({
        where: { id: job.id },
        data: {
          status: "SENT",
          sentAt: msg.sentAt ?? new Date(),
          externalId: msg.ebayMessageId ?? null,
          lastError: null,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: job.authorUserId,
          action: "HELPDESK_OUTBOUND_SENT",
          entityType: "HelpdeskOutboundJob",
          entityId: job.id,
          details: {
            ticketId: job.ticketId,
            repair: "unique_constraint_race_repair",
            messageId: msg.id,
            note: "Job was falsely FAILED by (ticketId, externalId) race; eBay delivered the message. Marked SENT.",
          },
        },
      });
    });
    console.log("  -> APPLIED: job marked SENT, attribution stamped.\n");
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
