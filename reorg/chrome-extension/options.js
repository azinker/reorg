/* global chrome */

const DEFAULTS = {
  reorgBaseUrl: "https://reorg.theperfectpart.net",
  defaultEbayPlatform: "TPP_EBAY",
  bigcommerceHost: "",
};

function normalizeHost(input) {
  const s = (input || "").trim();
  if (!s) return "";
  try {
    if (s.includes("://")) {
      return new URL(s).hostname;
    }
  } catch {
    return s.split("/")[0].split(":")[0];
  }
  return s.split("/")[0].split(":")[0];
}

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  document.getElementById("reorgBaseUrl").value = stored.reorgBaseUrl || DEFAULTS.reorgBaseUrl;
  document.getElementById("defaultEbayPlatform").value = stored.defaultEbayPlatform || DEFAULTS.defaultEbayPlatform;
  document.getElementById("bigcommerceHost").value = stored.bigcommerceHost || "";
}

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const reorgBaseUrl = document.getElementById("reorgBaseUrl").value.trim() || DEFAULTS.reorgBaseUrl;
  const defaultEbayPlatform = document.getElementById("defaultEbayPlatform").value;
  const bigcommerceHost = normalizeHost(document.getElementById("bigcommerceHost").value);

  await chrome.storage.sync.set({
    reorgBaseUrl: reorgBaseUrl.replace(/\/+$/, ""),
    defaultEbayPlatform,
    bigcommerceHost,
  });

  const saved = document.getElementById("saved");
  saved.classList.remove("hidden");
  setTimeout(() => saved.classList.add("hidden"), 2500);
});

load();
