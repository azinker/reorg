const DEFAULT_TRACKING_URL =
  "https://www.ebay.com/ship/trk/tracking-details?itemid=195730685939&transid=10085110852527";

const storeSelect = document.getElementById("store");
const trackingUrlInput = document.getElementById("trackingUrl");
const downloadButton = document.getElementById("download");
const statusEl = document.getElementById("status");

function setStatus(message, type = "ok") {
  statusEl.textContent = message;
  statusEl.className = type === "error" ? "error" : "";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildCurl(url, cookieLine) {
  return [
    `curl ${shellQuote(url)} \\`,
    `  -H ${shellQuote("accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")} \\`,
    `  -H ${shellQuote("accept-language: en-US,en;q=0.9")} \\`,
    `  -H ${shellQuote(`user-agent: ${navigator.userAgent}`)} \\`,
    `  -b ${shellQuote(cookieLine)}`,
    "",
  ].join("\n");
}

async function getActiveTrackingUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith("https://www.ebay.com/ship/trk/tracking-details")) {
    return tab.url;
  }
  return DEFAULT_TRACKING_URL;
}

async function getEbayCookies() {
  const cookies = await chrome.cookies.getAll({ domain: ".ebay.com" });
  const wwwCookies = await chrome.cookies.getAll({ domain: "www.ebay.com" });
  const byName = new Map();
  for (const cookie of [...cookies, ...wwwCookies]) {
    byName.set(cookie.name, cookie);
  }
  return [...byName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function downloadSessionFile() {
  downloadButton.disabled = true;
  setStatus("Preparing session file...");
  try {
    const url = trackingUrlInput.value.trim() || DEFAULT_TRACKING_URL;
    if (!url.startsWith("https://www.ebay.com/ship/trk/tracking-details")) {
      throw new Error("Open or paste an eBay tracking-details URL first.");
    }
    const cookieLine = await getEbayCookies();
    if (!cookieLine) throw new Error("No eBay cookies found. Log into eBay in this browser first.");

    const store = storeSelect.value === "tt" ? "tt" : "tpp";
    const body = buildCurl(url, cookieLine);
    const blob = new Blob([body], { type: "text/plain" });
    const objectUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url: objectUrl,
      filename: `ebay-${store}-tracking-curl.txt`,
      saveAs: false,
      conflictAction: "overwrite",
    });
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    setStatus(`Downloaded ebay-${store}-tracking-curl.txt`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not create session file.", "error");
  } finally {
    downloadButton.disabled = false;
  }
}

async function init() {
  trackingUrlInput.value = await getActiveTrackingUrl();
  downloadButton.addEventListener("click", () => void downloadSessionFile());
}

void init();
