chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "OPEN_PURCHASE_HISTORY_TAB") {
    return;
  }

  const itemId = typeof message.itemId === "string" ? message.itemId.trim() : "";
  if (!/^\d{12}$/.test(itemId)) {
    sendResponse({ ok: false, error: "Invalid item ID." });
    return;
  }

  const url = `https://www.ebay.com/bin/purchaseHistory?item=${itemId}`;
  const createOptions = { url, active: true };
  if (typeof sender?.tab?.index === "number") {
    createOptions.index = sender.tab.index + 1;
  }

  chrome.tabs.create(createOptions, () => {
    const runtimeError = chrome.runtime.lastError;
    if (runtimeError) {
      sendResponse({ ok: false, error: runtimeError.message });
      return;
    }
    sendResponse({ ok: true });
  });

  return true;
});
