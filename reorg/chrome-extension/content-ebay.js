/* global chrome */
(function () {
  const m = window.location.pathname.match(/\/itm\/(\d{5,})/);
  if (!m) return;
  chrome.runtime.sendMessage({
    type: "PAGE_ITEM_DETECTED",
    itemId: m[1],
    source: "ebay",
  });
})();
