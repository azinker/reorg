import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  console.log("Logging in...");
  await page.goto("https://reorg.theperfectpart.net/login");
  await page.waitForLoadState("networkidle");
  await page.fill('input[type="email"]', "adam@theperfectpart.net");
  await page.fill('input[type="password"]', "Shachar0492");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  console.log("Navigating to Help Desk...");
  await page.goto("https://reorg.theperfectpart.net/help-desk");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3000);

  const screenshotA = "scripts/verify-sidebar.png";
  await page.screenshot({ path: screenshotA, fullPage: false });
  console.log(`Sidebar screenshot: ${screenshotA}`);

  // Check for Unread / Awaiting Reply text under To Do
  const bodyText = (await page.textContent("body")) ?? "";
  const hasToDo = bodyText.includes("To Do");
  const hasUnreadChild = /unread/i.test(bodyText);
  const hasAwaiting = /awaiting reply/i.test(bodyText);
  console.log(`  "To Do" present:         ${hasToDo}`);
  console.log(`  "Unread" present:        ${hasUnreadChild}`);
  console.log(`  "Awaiting Reply" present: ${hasAwaiting}`);

  // Click the first ticket by locating the "To Do" pill and clicking its row
  console.log("\nOpening first ticket...");
  const toDoPill = page.locator("text=/^To Do$/i").first();
  const count = await toDoPill.count();
  if (count > 0) {
    await toDoPill.click({ timeout: 8000 }).catch((e) => console.log("Pill click failed:", e.message));
    await page.waitForTimeout(2500);
    const ticketText = (await page.textContent("body")) ?? "";
    const hasFolderPill = /\bin\b/i.test(ticketText) && /Unread|Awaiting Reply|From eBay|Resolved|Snoozed|Archived/.test(ticketText);
    console.log(`  Triage bar folder pill visible: ${hasFolderPill}`);
    const screenshotB = "scripts/verify-ticket.png";
    await page.screenshot({ path: screenshotB, fullPage: false });
    console.log(`  Ticket screenshot: ${screenshotB}`);
  } else {
    console.log("  No To Do pill found.");
  }

  await browser.close();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
