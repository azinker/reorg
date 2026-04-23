import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Login
  console.log("Logging in...");
  await page.goto("https://reorg.theperfectpart.net/login");
  await page.waitForLoadState("networkidle");
  await page.fill('input[type="email"]', "adam@theperfectpart.net");
  await page.fill('input[type="password"]', "Shachar0492");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Navigate to Help Desk
  console.log("Navigating to Help Desk...");
  await page.goto("https://reorg.theperfectpart.net/help-desk");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3000);

  // Get folder counts from sidebar
  console.log("\n=== Folder Counts ===");
  const sidebar = await page.locator("aside, nav, [class*='sidebar']").first();
  
  const folders = [
    "All Tickets", "To Do", "Waiting", "Cancel Requests", "From eBay",
    "Snoozed", "Resolved", "Unassigned", "Mentioned", "Favorites",
    "Spam", "Archived"
  ];

  for (const folder of folders) {
    try {
      const el = page.locator(`text="${folder}"`).first();
      const parent = el.locator("..").first();
      const badge = await parent.locator("[class*='badge'], [class*='count'], span").allTextContents();
      const countText = badge.find(t => /^\d+/.test(t.trim()));
      console.log(`  ${folder}: ${countText ?? "(no count)"}`);
    } catch {
      console.log(`  ${folder}: (not found)`);
    }
  }

  // Take screenshot
  const screenshotPath = "c:/Users/thepe/OneDrive - theperfectpart.net/Desktop/The Perfect Part reorG/reorg/scripts/helpdesk-check.png";
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`\nScreenshot saved: ${screenshotPath}`);

  // Check global settings for safe mode and read sync
  console.log("\nChecking Global Settings...");
  await page.goto("https://reorg.theperfectpart.net/help-desk/global-settings");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3000);

  const settingsScreenshot = "c:/Users/thepe/OneDrive - theperfectpart.net/Desktop/The Perfect Part reorG/reorg/scripts/helpdesk-settings.png";
  await page.screenshot({ path: settingsScreenshot, fullPage: false });
  console.log(`Settings screenshot saved: ${settingsScreenshot}`);

  // Get page text to check toggle states
  const pageText = await page.textContent("body");
  if (pageText?.includes("Safe Mode")) {
    console.log("Safe Mode section found on page");
  }
  if (pageText?.includes("Read/Unread Sync")) {
    console.log("Read Sync section found on page");
  }

  await browser.close();
  console.log("\nDone.");
}

main().catch(console.error);
