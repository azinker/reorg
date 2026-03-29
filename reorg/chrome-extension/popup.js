/* global chrome */

const DEFAULTS = {
  reorgBaseUrl: "https://reorg.theperfectpart.net",
  defaultEbayPlatform: "TPP_EBAY",
  bigcommerceHost: "",
};

/**
 * @returns {{ itemId: string, platform: string | null, needsEbayPlatform: boolean } | null}
 */
function parseListingUrl(urlString, bigcommerceHost) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return null;
  }

  const path = u.pathname;

  const ebay = path.match(/\/itm\/(\d{5,})/);
  if (ebay) {
    return { itemId: ebay[1], platform: null, needsEbayPlatform: true };
  }

  if (u.hostname === "admin.shopify.com") {
    const shopify = path.match(/\/products\/(\d+)/);
    if (shopify) {
      return { itemId: shopify[1], platform: "SHOPIFY", needsEbayPlatform: false };
    }
  }

  if (bigcommerceHost && u.hostname === bigcommerceHost.replace(/^https?:\/\//, "").split("/")[0]) {
    const bc = path.match(/\/manage\/products\/edit\/(\d+)/);
    if (bc) {
      return { itemId: bc[1], platform: "BIGCOMMERCE", needsEbayPlatform: false };
    }
  }

  if (!bigcommerceHost && u.hostname.endsWith(".mybigcommerce.com")) {
    const bc = path.match(/\/manage\/products\/edit\/(\d+)/);
    if (bc) {
      return { itemId: bc[1], platform: "BIGCOMMERCE", needsEbayPlatform: false };
    }
  }

  return null;
}

function $(id) {
  return document.getElementById(id);
}

async function init() {
  const statusEl = $("status");
  const detailEl = $("detail");
  const openBtn = $("open");
  const hintEl = $("hint");
  const optsLink = $("opts");

  optsLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const settings = await chrome.storage.sync.get(DEFAULTS);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    statusEl.textContent = "No active tab.";
    hintEl.classList.remove("hidden");
    return;
  }

  const parsed = parseListingUrl(tab.url, settings.bigcommerceHost || "");
  if (!parsed) {
    statusEl.textContent = "No listing detected on this page.";
    detailEl.textContent = tab.url;
    detailEl.classList.remove("hidden");
    hintEl.classList.remove("hidden");
    return;
  }

  let platform = parsed.platform;
  if (parsed.needsEbayPlatform) {
    platform = settings.defaultEbayPlatform || "TPP_EBAY";
  }

  statusEl.textContent = "Ready to open in reorG";
  detailEl.textContent = `Item ${parsed.itemId}${platform ? ` · ${platform}` : ""}`;
  detailEl.classList.remove("hidden");
  openBtn.classList.remove("hidden");
  openBtn.disabled = false;

  openBtn.addEventListener("click", () => {
    openBtn.disabled = true;
    chrome.runtime.sendMessage(
      {
        type: "OPEN_REORG",
        payload: { itemId: parsed.itemId, platform },
      },
      () => window.close(),
    );
  });
}

init();
