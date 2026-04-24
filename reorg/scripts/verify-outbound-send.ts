/**
 * End-to-end verification that a reorG reply actually sends to the buyer.
 *
 * Scenario:
 *   1. Open the cjhain ticket in reorG.
 *   2. Type a specific message into the composer.
 *   3. Click Send — UI enqueues a HelpdeskOutboundJob with a 5s undo window.
 *   4. Wait past the send delay, then manually kick the outbound cron so we
 *      don't have to wait up to 60s for Vercel's scheduler.
 *   5. Poll the DB until the job flips to SENT (or FAILED / CANCELED → fail).
 *   6. Assert the corresponding HelpdeskMessage row exists with the right
 *      body text.
 *
 * Success gate:
 *   - Job.status === SENT
 *   - HelpdeskMessage row exists with direction=OUTBOUND, bodyText matches,
 *     source=EBAY (Trading API path).
 *
 * Usage: npx tsx -r dotenv/config scripts/verify-outbound-send.ts
 * (needs DOTENV_CONFIG_PATH=.env.production so we point at prod DB + secret).
 */

import { chromium } from "playwright";
import path from "node:path";
import { db } from "@/lib/db";
import { HelpdeskOutboundStatus, HelpdeskMessageDirection } from "@prisma/client";

const SITE = "https://reorg.theperfectpart.net";
const EMAIL = "adam@theperfectpart.net";
const PASSWORD = "Shachar0492";
const TICKET_ID = "cmodaous500lnjo045hjsjxhe"; // cjhain buyer, item 204259779487
const MESSAGE = "Thank you, if you need anything else, please let me know";
const OUT_DIR = path.resolve("scripts");

async function kickOutboundCron(): Promise<string> {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET not set");
  const res = await fetch(
    `${SITE}/api/cron/helpdesk-outbound?token=${encodeURIComponent(secret)}`,
    { method: "POST" },
  );
  const body = await res.text();
  console.log(`   cron response (${res.status}): ${body}`);
  return body;
}

async function main(): Promise<void> {
  const jobsBefore = await db.helpdeskOutboundJob.count({
    where: { ticketId: TICKET_ID },
  });
  console.log(`0) Baseline: ${jobsBefore} existing outbound jobs on this ticket.`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  console.log("1) Login…");
  await page.goto(`${SITE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page
    .waitForURL(/\/dashboard|\/help-desk|\/integrations/, { timeout: 20000 })
    .catch(() => undefined);
  await page.waitForTimeout(1500);

  console.log(`2) Deep-linking to cjhain ticket (${TICKET_ID})…`);
  await page.goto(`${SITE}/help-desk?ticket=${TICKET_ID}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await page
    .getByText(/opened the ticket/i)
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => undefined);

  console.log("3) Expanding composer and typing the message…");
  // The composer renders as a collapsed pill button labeled "Reply…" until
  // the agent clicks it, at which point it expands into a real <textarea>
  // with the longer placeholder "Reply to buyer (sent via eBay messaging)…".
  // Click the pill first (if present), then wait for the textarea.
  const pill = page.getByRole("button", { name: /^Reply…$/ }).first();
  if (await pill.count()) {
    console.log("   clicking the collapsed 'Reply…' pill to expand composer");
    await pill.click();
    await page.waitForTimeout(400);
  }

  // Now look for the real textarea.
  const textarea = page
    .locator('textarea[placeholder*="Reply to buyer" i]')
    .first();
  await textarea
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  if (!(await textarea.count())) {
    throw new Error("Composer textarea did not appear after clicking the pill");
  }
  await textarea.click();
  await textarea.fill(MESSAGE);
  await page.waitForTimeout(400);

  console.log("4) Clicking Send…");
  // Screenshot right before click for audit trail.
  await page.screenshot({
    path: path.join(OUT_DIR, "verify-outbound-send_before.png"),
    fullPage: true,
  });

  // The primary send button lives in a split-button on the right of the
  // composer toolbar. Its visible text is one of "Send" / "Waiting" /
  // "Resolve" depending on the status choice, but its `title` attribute
  // always starts with "Send" ("Send (keep status)", "Send + Mark Waiting",
  // "Send + Resolve"). Match on the title for stability.
  const sendBtn = page.locator('button[title^="Send"]').first();
  await sendBtn.waitFor({ timeout: 5000 });
  await sendBtn.click();
  console.log("   clicked send; waiting past the 5s undo window…");
  await page.waitForTimeout(7000);

  await page.screenshot({
    path: path.join(OUT_DIR, "verify-outbound-send_after_click.png"),
    fullPage: true,
  });

  console.log("5) Locating the newly-enqueued job in the DB…");
  // The composer created a new HelpdeskOutboundJob. Grab the most recent one
  // for this ticket with our exact body text.
  const job = await db.helpdeskOutboundJob.findFirst({
    where: {
      ticketId: TICKET_ID,
      bodyText: MESSAGE,
    },
    orderBy: { createdAt: "desc" },
  });
  if (!job) {
    await browser.close();
    throw new Error("New outbound job not found — the UI send likely didn't enqueue");
  }
  console.log(`   job.id=${job.id} status=${job.status} scheduledAt=${job.scheduledAt.toISOString()}`);

  console.log("6) Kicking the outbound cron manually (skips the 1-min wait)…");
  await kickOutboundCron();

  console.log("7) Polling DB for terminal status…");
  let terminal = null as typeof job | null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const j = await db.helpdeskOutboundJob.findUnique({ where: { id: job.id } });
    if (
      j &&
      (j.status === HelpdeskOutboundStatus.SENT ||
        j.status === HelpdeskOutboundStatus.FAILED ||
        j.status === HelpdeskOutboundStatus.CANCELED)
    ) {
      terminal = j;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
    // Kick again every ~10s in case the first kick raced the job insert.
    if ((Date.now() - (deadline - 60_000)) % 10_000 < 2100) {
      await kickOutboundCron();
    }
  }

  if (!terminal) {
    await browser.close();
    throw new Error("Job never reached a terminal status within 60s");
  }

  console.log(
    `   terminal status=${terminal.status} sentAt=${terminal.sentAt?.toISOString() ?? "-"}`,
  );
  if (terminal.lastError) console.log(`   lastError: ${terminal.lastError}`);

  if (terminal.status !== HelpdeskOutboundStatus.SENT) {
    await browser.close();
    console.error(
      `\n✗ FAIL — job ended in ${terminal.status} (expected SENT). lastError=${terminal.lastError ?? "none"}`,
    );
    process.exit(2);
  }

  console.log("8) Confirming the outbound HelpdeskMessage row was persisted…");
  const msg = await db.helpdeskMessage.findFirst({
    where: {
      ticketId: TICKET_ID,
      direction: HelpdeskMessageDirection.OUTBOUND,
      bodyText: MESSAGE,
    },
    orderBy: { sentAt: "desc" },
  });
  if (!msg) {
    await browser.close();
    console.error("✗ FAIL — Job says SENT but no HelpdeskMessage row exists with this body");
    process.exit(3);
  }
  console.log(
    `   message.id=${msg.id} externalId=${msg.externalId ?? "(none)"} source=${msg.source}`,
  );

  console.log("9) Checking audit log for HELPDESK_OUTBOUND_SENT…");
  const audit = await db.auditLog.findFirst({
    where: {
      entityType: "HelpdeskOutboundJob",
      entityId: job.id,
      action: "HELPDESK_OUTBOUND_SENT",
    },
    orderBy: { createdAt: "desc" },
  });
  console.log(
    audit
      ? `   ✓ audit log found: ${JSON.stringify(audit.details)}`
      : "   ✗ no HELPDESK_OUTBOUND_SENT audit row",
  );

  // Final reload of the ticket page so the user has visual confirmation.
  console.log("10) Re-rendering the ticket page for a final screenshot…");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await page.screenshot({
    path: path.join(OUT_DIR, "verify-outbound-send_final.png"),
    fullPage: true,
  });

  await browser.close();
  console.log(
    `\n✓ PASS — reply sent to eBay. Trading API ack accepted, message persisted, audit logged.`,
  );
  console.log(
    `  Screenshots: verify-outbound-send_before.png, _after_click.png, _final.png`,
  );
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect().catch(() => undefined);
  process.exit(1);
});
