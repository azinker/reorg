/* global chrome */
(function () {
  const m = window.location.pathname.match(/\/products\/(\d+)/);
  if (!m) return;
  chrome.runtime.sendMessage({
    type: "PAGE_ITEM_DETECTED",
    itemId: m[1],
    source: "shopify",
  });
})();
