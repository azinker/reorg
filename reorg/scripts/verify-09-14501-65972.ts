/**
 * Playwright verification for ticket 09-14501-65972.
 *
 * Flow:
 *   1. Login to https://reorg.theperfectpart.net
 *   2. Trigger "Sync now" (twice, to let Tier C resolve + next-tick ingest)
 *   3. Navigate to the ticket by searching order number
 *   4. Check whether any of the expected Commerce Message agent replies
 *      are now present on the ticket.
 *
 * Expected newly-ingested messages (from the Commerce Message API probe):
 *   - "Of course processing that for you now." — theperfectpart @ 2026-04-21T20:27:51Z
 *   - "Can you send me the partial refund"    — anieto39       @ 2026-04-21T19:55:13Z
 *   - "Plz" / "Partial refund"                — anieto39       @ 2026-04-21T01:15:xxZ
 *   - "I am so sorry to hear this..."         — theperfectpart @ 2026-04-21T00:42:47Z
 *
 * Usage: npx tsx scripts/verify-09-14501-65972.ts
 */

import { chromium } from "playwright";
import path from "node:path";

const SITE = "https://reorg.theperfectpart.net";
const EMAIL = "adam@theperfectpart.net";
const PASSWORD = "Shachar0492";
const ORDER_NUMBER = "09-14501-65972";
const OUT_DIR = path.resolve("scripts");

const EXPECTED_SNIPPETS = [
  "Of course processing that for you now.",
  "Can you send me the partial refund",
  "Partial refund",
  "I am so sorry to hear this",
];

async function clickSyncNow(page: import("playwright").Page): Promise<void> {
  const syncBtn = page.getByRole("button", { name: /sync now/i }).first();
  if (!(await syncBtn.isVisible().catch(() => false))) {
    console.log('  ⚠ "Sync now" button not visible; skipping click.');
    return;
  }
  // Wait until enabled (previous sync may still be running).
  for (let i = 0; i < 90; i++) {
    const disabled = await syncBtn.isDisabled().catch(() => false);
    if (!disabled) break;
    if (i === 0) console.log("  ⋯ Waiting for previous sync to finish…");
    await page.waitForTimeout(2000);
  }
  if (await syncBtn.isDisabled().catch(() => false)) {
    console.log("  ⚠ Sync button still disabled after 3m — skipping.");
    return;
  }
  console.log('  ▶ Clicking "Sync now"…');
  await syncBtn.click();
  await page.waitForTimeout(2000);
  // Wait for it to become disabled (sync started) then enabled again (done).
  let sawDisabled = false;
  for (let i = 0; i < 120; i++) {
    const disabled = await syncBtn.isDisabled().catch(() => false);
    if (disabled) sawDisabled = true;
    if (sawDisabled && !disabled) break;
    await page.waitForTimeout(2000);
  }
  console.log("  ✓ Sync complete.");
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });
  const page = await ctx.newPage();

  // Capture server errors for post-mortem.
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on("response", (resp) => {
    if (resp.status() >= 500) {
      consoleErrors.push(`${resp.status()} ${resp.url()}`);
    }
  });

  console.log("1) Login…");
  await page.goto(`${SITE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page
    .waitForURL(/\/dashboard|\/help-desk|\/integrations/, { timeout: 20000 })
    .catch(() => undefined);
  await page.waitForTimeout(1500);

  console.log("2) Navigating to Help Desk…");
  await page.goto(`${SITE}/help-desk`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  console.log("3) Triggering Sync now (first pass: resolves conversationId)…");
  await clickSyncNow(page);
  await page.waitForTimeout(2000);

  console.log("4) Triggering Sync now (second pass: ingest with bound id)…");
  await clickSyncNow(page);
  await page.waitForTimeout(2000);

  console.log(`5) Searching for order ${ORDER_NUMBER}…`);
  const searchBox = page
    .locator(
      'input[placeholder*="Search" i], input[placeholder*="search" i], input[type="search"]',
    )
    .first();
  if (await searchBox.isVisible().catch(() => false)) {
    await searchBox.click();
    await searchBox.fill(ORDER_NUMBER);
    await page.waitForTimeout(3000);
  } else {
    console.log("  ⚠ Search box not found, falling back to direct URL search.");
    await page.goto(
      `${SITE}/help-desk?q=${encodeURIComponent(ORDER_NUMBER)}`,
      { waitUntil: "networkidle" },
    );
    await page.waitForTimeout(3000);
  }

  await page.screenshot({
    path: path.join(OUT_DIR, "verify-09-results-list.png"),
    fullPage: false,
  });

  console.log(`6) Opening the ticket row containing ${ORDER_NUMBER}…`);
  // Prefer the SHIPPING_QUERY/buyer thread (not the SYSTEM rows).
  // Buyer threadKey pattern: ord:09-14501-65972|buyer:anieto39
  const buyerRow = page
    .locator('tr, [role="row"], a, li')
    .filter({ hasText: ORDER_NUMBER })
    .filter({ hasText: /anieto|Alberto|buyer/i })
    .first();
  let opened = false;
  if (await buyerRow.isVisible().catch(() => false)) {
    await buyerRow.click();
    opened = true;
  } else {
    // Fallback: click any row with the order number.
    const anyRow = page
      .locator('tr, [role="row"], a, li')
      .filter({ hasText: ORDER_NUMBER })
      .first();
    if (await anyRow.isVisible().catch(() => false)) {
      await anyRow.click();
      opened = true;
    }
  }
  if (!opened) {
    console.log("  ✗ No ticket row found containing the order number.");
    await page.screenshot({
      path: path.join(OUT_DIR, "verify-09-no-row.png"),
      fullPage: true,
    });
    await browser.close();
    process.exit(4);
  }
  await page.waitForTimeout(3000);
  await page.screenshot({
    path: path.join(OUT_DIR, "verify-09-ticket-detail.png"),
    fullPage: true,
  });

  console.log("7) Scanning ticket pane for expected Commerce Message bodies…");
  const bodyText = (await page.textContent("body").catch(() => "")) ?? "";
  const hits: Record<string, boolean> = {};
  for (const snip of EXPECTED_SNIPPETS) {
    hits[snip] = bodyText.toLowerCase().includes(snip.toLowerCase());
  }
  console.log("\n  Snippet presence:");
  for (const [snip, found] of Object.entries(hits)) {
    console.log(`    [${found ? "✓" : "✗"}] "${snip}"`);
  }
  const successCount = Object.values(hits).filter(Boolean).length;
  console.log(
    `\n  → ${successCount}/${EXPECTED_SNIPPETS.length} expected snippets present.`,
  );

  if (consoleErrors.length > 0) {
    console.log("\n  5xx / page errors observed:");
    for (const e of consoleErrors.slice(0, 10)) console.log(`    - ${e}`);
  }

  await browser.close();
  process.exit(successCount === 0 ? 5 : 0);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
