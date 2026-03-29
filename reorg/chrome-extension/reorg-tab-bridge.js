/* global chrome */
/**
 * Runs on reorG pages. Receives messages from the background script and dispatches
 * a page-world CustomEvent so the dashboard can scroll without a full navigation.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SCROLL_TO_ITEM_IN_REORG" && message.payload && typeof message.payload.itemId === "string") {
    try {
      const detail = {
        itemId: message.payload.itemId,
        platform: message.payload.platform ?? undefined,
      };
      const script = document.createElement("script");
      script.textContent = `(() => { try { window.dispatchEvent(new CustomEvent("reorg-extension-deep-link", { detail: ${JSON.stringify(detail)} })); } catch (e) {} })();`;
      (document.documentElement || document.head).appendChild(script);
      script.remove();
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return true;
  }
  return false;
});
