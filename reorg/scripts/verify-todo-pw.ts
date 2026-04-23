import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  console.log("Logging in...");
  await page.goto("https://reorg.theperfectpart.net/login");
  await page.waitForLoadState("networkidle");
  await page.fill('input[type="email"]', "adam@theperfectpart.net");
  await page.fill('input[type="password"]', "Shachar0492");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  console.log("Navigating to Help Desk...");
  await page.goto("https://reorg.theperfectpart.net/help-desk");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4000);

  // Extract sidebar counts
  console.log("\n=== Folder Counts ===");
  const sidebarText = await page.locator("aside, [class*='sidebar']").first().textContent() ?? "";

  const countPatterns = [
    { name: "All Tickets", pattern: /All Tickets\s*(\d[\d,]*)/ },
    { name: "To Do", pattern: /To Do\s*(\d[\d,]*)/ },
  ];

  for (const { name, pattern } of countPatterns) {
    const m = sidebarText.match(pattern);
    console.log(`  ${name}: ${m ? m[1] : "(not found)"}`);
  }

  // Take screenshot
  const path = "c:/Users/thepe/OneDrive - theperfectpart.net/Desktop/The Perfect Part reorG/reorg/scripts/helpdesk-verify.png";
  await page.screenshot({ path, fullPage: false });
  console.log(`\nScreenshot: ${path}`);

  // Check if SAFE MODE badge is showing
  const pageText = await page.textContent("body") ?? "";
  if (pageText.includes("SAFE MODE")) {
    console.log("WARNING: SAFE MODE badge still visible on Help Desk");
  } else {
    console.log("Safe Mode badge not visible (good - it's off)");
  }

  await browser.close();
  console.log("Done.");
}

main().catch(console.error);
