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

  // 1. Global Settings
  console.log("\n=== Global Settings ===");
  await page.goto("https://reorg.theperfectpart.net/help-desk/global-settings");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3000);
  await page.screenshot({
    path: "c:/Users/thepe/OneDrive - theperfectpart.net/Desktop/The Perfect Part reorG/reorg/scripts/pw-global-settings.png",
    fullPage: false,
  });
  const settingsText = await page.textContent("body") ?? "";
  console.log("  Safe Mode ON badge:", settingsText.includes("Safe Mode ON") ? "YES" : "NO");
  console.log("  Contains 'LIVE':", settingsText.includes("LIVE") ? "YES" : "NO");

  // 2. Help Desk
  console.log("\n=== Help Desk ===");
  await page.goto("https://reorg.theperfectpart.net/help-desk");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4000);
  await page.screenshot({
    path: "c:/Users/thepe/OneDrive - theperfectpart.net/Desktop/The Perfect Part reorG/reorg/scripts/pw-helpdesk.png",
    fullPage: false,
  });

  // Extract text for counts
  const hdText = await page.textContent("body") ?? "";
  console.log("  SAFE MODE badge visible:", hdText.includes("SAFE MODE") || hdText.includes("Safe Mode") ? "YES" : "NO");
  console.log("  LIVE badge visible:", /\bLIVE\b/.test(hdText) ? "YES" : "NO");

  // Try to get sidebar numbers
  const sidebar = await page.locator('[class*="sidebar"], aside').first().textContent().catch(() => "");
  const toDoMatch = sidebar?.match(/To\s*Do\s*(\d[\d,]*)/);
  const allMatch = sidebar?.match(/All\s*Tickets\s*(\d[\d,]*)/);
  console.log("  All Tickets:", allMatch?.[1] ?? "(not found)");
  console.log("  To Do:", toDoMatch?.[1] ?? "(not found)");

  await browser.close();
  console.log("\nDone.");
}

main().catch(console.error);
