/* global chrome */

const DEFAULTS = {
  reorgBaseUrl: "https://reorg.theperfectpart.net",
  defaultEbayPlatform: "TPP_EBAY",
  bigcommerceHost: "",
};

function normalizeBase(url) {
  return (url || "").replace(/\/+$/, "");
}

async function getSettings() {
  const sync = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...sync };
}

function isDashboardUrl(fullUrl) {
  try {
    const p = new URL(fullUrl).pathname;
    return p === "/dashboard" || p.startsWith("/dashboard/");
  } catch {
    return false;
  }
}

/**
 * @param {{ itemId: string, platform?: string | null }} params
 */
async function openOrFocusReorg(params) {
  const { reorgBaseUrl } = await getSettings();
  const base = normalizeBase(reorgBaseUrl);
  const allTabs = await chrome.tabs.query({});
  const existing = allTabs.filter((t) => t.url && t.url.startsWith(base));

  const payload = {
    itemId: params.itemId,
    platform: params.platform || null,
  };

  const q = new URLSearchParams();
  q.set("itemId", params.itemId);
  if (params.platform) q.set("platform", params.platform);
  const dashboardWithQuery = `${base}/dashboard?${q.toString()}`;

  if (existing.length > 0) {
    const tab = existing[0];
    const tabUrl = tab.url || "";

    if (tab.id != null && isDashboardUrl(tabUrl)) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "SCROLL_TO_ITEM_IN_REORG",
          payload,
        });
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId != null) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return { ok: true, action: "messaged" };
      } catch {
        /* content script missing or page not ready — fall through to navigation */
      }
    }

    if (tab.id != null) {
      await chrome.tabs.update(tab.id, { url: dashboardWithQuery, active: true });
      if (tab.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return { ok: true, action: "navigated" };
    }
  }

  await chrome.tabs.create({ url: dashboardWithQuery, active: true });
  return { ok: true, action: "created" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OPEN_REORG") {
    openOrFocusReorg(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message?.type === "PAGE_ITEM_DETECTED" && sender.tab?.id) {
    const id = message.itemId;
    const short = id && String(id).length >= 4 ? String(id).slice(-4) : "••••";
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: short });
    chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
