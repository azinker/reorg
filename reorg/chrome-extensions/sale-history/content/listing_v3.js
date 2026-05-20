(function listingScript() {
  const ROOT_ID = "tpp-listing-sold-history-root";
  const BUTTON_ID = "tpp-sold-history-btn-v2";
  const LEGACY_BUTTON_ID = "tpp-sold-history-btn";
  const WARNING_ID = "tpp-sold-history-warning";
  const CONTEXT_MENU_ID = "tpp-sold-history-context-menu";
  const MODAL_OVERLAY_ID = "tpp-sold-history-modal-overlay";
  let clickCaptureBound = false;
  let contextMenuBound = false;

  function handleLegacyRuntimeError(eventOrReason) {
    const message = String(eventOrReason?.message || eventOrReason?.reason || "");
    if (!message.includes("sendMessage")) return false;
    const root = document.getElementById(ROOT_ID);
    if (root) {
      renderWarning(root, "Extension context unavailable. Reload extension.");
    }
    return true;
  }

  window.addEventListener(
    "error",
    (event) => {
      if (handleLegacyRuntimeError(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );

  window.addEventListener("unhandledrejection", (event) => {
    if (handleLegacyRuntimeError(event)) {
      event.preventDefault();
    }
  });

  function unique(arr) {
    return [...new Set(arr)];
  }

  function extractIdFromText(text) {
    if (!text) return null;
    const match = text.match(/\b\d{12}\b/);
    return match ? match[0] : null;
  }

  function collectIdCandidatesFromText(text) {
    if (!text) return [];
    const matches = text.match(/\b\d{12}\b/g);
    return matches ? unique(matches) : [];
  }

  function scoreCandidate(candidate, sourceText) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`.{0,40}${escaped}.{0,40}`, "gi");
    let score = 0;
    let m;
    while ((m = regex.exec(sourceText)) !== null) {
      const ctx = (m[0] || "").toLowerCase();
      if (ctx.includes("item=")) score += 4;
      if (ctx.includes("/itm/")) score += 4;
      if (ctx.includes("purchasehistory")) score += 3;
      if (ctx.includes("canonical")) score += 2;
      if (ctx.includes("og:url")) score += 2;
      score += 1;
    }
    return score;
  }

  function extractItemId() {
    const strategy1 = extractIdFromText(window.location.href);
    if (strategy1) return strategy1;

    const canonicalHref = document
      .querySelector('link[rel="canonical"]')
      ?.getAttribute("href");
    const strategy2a = extractIdFromText(canonicalHref || "");
    if (strategy2a) return strategy2a;

    const ogUrl = document
      .querySelector('meta[property="og:url"]')
      ?.getAttribute("content");
    const strategy2b = extractIdFromText(ogUrl || "");
    if (strategy2b) return strategy2b;

    const sourceText = [
      document.documentElement?.outerHTML || "",
      document.body?.innerText || ""
    ].join("\n");
    const candidates = collectIdCandidatesFromText(sourceText);
    if (!candidates.length) return null;

    const ranked = candidates
      .map((candidate) => ({
        candidate,
        score: scoreCandidate(candidate, sourceText)
      }))
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.candidate || null;
  }

  function findTitleElement() {
    const selectors = [
      "h1.x-item-title__mainTitle",
      "h1.x-item-title__mainTitle span",
      "h1[data-testid='x-item-title-label']",
      "#itemTitle",
      "h1.it-ttl",
      "h1"
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      if ((el.textContent || "").trim().length < 5) continue;
      return el;
    }
    return null;
  }

  function getOrCreateRoot(titleEl) {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;

    root = document.createElement("span");
    root.id = ROOT_ID;
    root.className = "tpp-listing-root";

    if (titleEl && titleEl.parentElement) {
      root.classList.add("tpp-inline");
      titleEl.insertAdjacentElement("afterend", root);
      return root;
    }

    root.classList.add("tpp-fallback");
    const fallbackContainer =
      document.querySelector("main") ||
      document.querySelector("#mainContent") ||
      document.querySelector(".x-item-container__mainContent") ||
      document.body;
    fallbackContainer.insertAdjacentElement("afterbegin", root);
    return root;
  }

  function renderWarning(root, message) {
    if (!root || typeof root.appendChild !== "function") {
      return;
    }
    let warning = document.getElementById(WARNING_ID);
    if (!warning) {
      warning = document.createElement("span");
      warning.id = WARNING_ID;
      warning.className = "tpp-warning";
      root.appendChild(warning);
    }
    warning.textContent = message;
  }

  function clearWarning() {
    const warning = document.getElementById(WARNING_ID);
    if (warning) warning.remove();
  }

  function getRuntimeApi() {
    const extChrome = globalThis.chrome;
    if (!extChrome || !extChrome.runtime || typeof extChrome.runtime.sendMessage !== "function") {
      return null;
    }
    if (!extChrome.runtime.id) {
      return null;
    }
    return extChrome.runtime;
  }

  function createOrUpdateButton(root) {
    if (!root || typeof root.appendChild !== "function") {
      return;
    }

    root
      .querySelectorAll(`#${BUTTON_ID}, #${LEGACY_BUTTON_ID}, .tpp-sold-history-btn`)
      .forEach((el) => el.remove());

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.className = "tpp-sold-history-btn";
    button.textContent = "Sold History";
    root.appendChild(button);
  }

  function buildPurchaseHistoryUrl(itemId, modal) {
    const params = new URLSearchParams({ item: itemId });
    if (modal) params.set("tppModal", "1");
    return `https://www.ebay.com/bin/purchaseHistory?${params.toString()}`;
  }

  function removeContextMenu() {
    document.getElementById(CONTEXT_MENU_ID)?.remove();
  }

  function showSoldHistoryContextMenu(clientX, clientY) {
    removeContextMenu();

    const menu = document.createElement("ul");
    menu.id = CONTEXT_MENU_ID;
    menu.className = "tpp-context-menu";
    menu.setAttribute("role", "menu");

    const item = document.createElement("li");
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = "Open in new tab";
    action.setAttribute("role", "menuitem");
    action.addEventListener("click", () => {
      removeContextMenu();
      openSoldHistoryInAdjacentTab();
    });
    item.appendChild(action);
    menu.appendChild(item);

    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const left = Math.min(clientX, window.innerWidth - rect.width - 8);
    const top = Math.min(clientY, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
  }

  function closeSoldHistoryModal() {
    document.getElementById(MODAL_OVERLAY_ID)?.remove();
    document.body.classList.remove("tpp-modal-open");
  }

  function openSoldHistoryModal() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    const itemId = extractItemId();
    if (!itemId) {
      renderWarning(root, "Item ID not detected");
      return;
    }

    closeSoldHistoryModal();
    clearWarning();

    const overlay = document.createElement("div");
    overlay.id = MODAL_OVERLAY_ID;
    overlay.className = "tpp-modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Sold History");

    const panelEl = document.createElement("div");
    panelEl.className = "tpp-modal-panel";

    const toolbar = document.createElement("div");
    toolbar.className = "tpp-modal-toolbar";

    const title = document.createElement("p");
    title.className = "tpp-modal-title";
    title.textContent = "Sold History";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tpp-modal-close";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeSoldHistoryModal);

    toolbar.append(title, closeBtn);

    const frameWrap = document.createElement("div");
    frameWrap.className = "tpp-modal-frame-wrap";

    const iframe = document.createElement("iframe");
    iframe.className = "tpp-modal-iframe";
    iframe.title = "eBay Sold History";
    iframe.src = buildPurchaseHistoryUrl(itemId, true);

    frameWrap.appendChild(iframe);
    panelEl.append(toolbar, frameWrap);
    overlay.appendChild(panelEl);

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeSoldHistoryModal();
    });

    document.body.appendChild(overlay);
    document.body.classList.add("tpp-modal-open");
    closeBtn.focus();

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        closeSoldHistoryModal();
        window.removeEventListener("keydown", onKeyDown);
      }
    };
    window.addEventListener("keydown", onKeyDown);
  }

  function openSoldHistoryInAdjacentTab() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    try {
      const itemId = extractItemId();
      if (!itemId) {
        renderWarning(root, "Item ID not detected");
        return;
      }

      const runtimeApi = getRuntimeApi();
      const sendMessageFn = runtimeApi?.sendMessage;
      if (typeof sendMessageFn !== "function") {
        renderWarning(root, "Extension context unavailable. Reload extension.");
        return;
      }

      clearWarning();
      sendMessageFn.call(runtimeApi, { type: "OPEN_PURCHASE_HISTORY_TAB", itemId }, (response) => {
        const lastError = globalThis.chrome?.runtime?.lastError;
        if (lastError) {
          renderWarning(root, "Unable to open Sold History");
          return;
        }
        if (!response?.ok) {
          renderWarning(root, "Unable to open Sold History");
        }
      });
    } catch (_err) {
      renderWarning(root, "Unable to open Sold History");
    }
  }

  function handleSoldHistoryClick() {
    openSoldHistoryModal();
  }

  function bindClickCapture() {
    if (clickCaptureBound) return;
    clickCaptureBound = true;
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        if (document.getElementById(CONTEXT_MENU_ID) && !target.closest(`#${CONTEXT_MENU_ID}`)) {
          removeContextMenu();
        }

        const btn = target.closest(
          `#${BUTTON_ID}, #${LEGACY_BUTTON_ID}, .tpp-sold-history-btn`
        );
        if (!btn) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        handleSoldHistoryClick();
      },
      true
    );
  }

  function bindContextMenu() {
    if (contextMenuBound) return;
    contextMenuBound = true;
    document.addEventListener(
      "contextmenu",
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const btn = target.closest(
          `#${BUTTON_ID}, #${LEGACY_BUTTON_ID}, .tpp-sold-history-btn`
        );
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
        showSoldHistoryContextMenu(event.clientX, event.clientY);
      },
      true
    );
  }

  function init() {
    const titleEl = findTitleElement();
    const root = getOrCreateRoot(titleEl);
    createOrUpdateButton(root);
    bindClickCapture();
    bindContextMenu();

    if (!extractItemId()) {
      renderWarning(root, "Item ID not detected");
    } else {
      clearWarning();
    }
  }

  init();

  const observer = new MutationObserver(() => {
    if (!document.getElementById(BUTTON_ID)) {
      init();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
