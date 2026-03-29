/* global chrome */
(function () {
  const FLOAT_ID = "reorg-dashboard-link-float";

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
    const bcHostNorm = (bigcommerceHost || "").replace(/^https?:\/\//, "").split("/")[0];
    if (bcHostNorm && u.hostname === bcHostNorm) {
      const bc = path.match(/\/manage\/products\/edit\/(\d+)/);
      if (bc) {
        return { itemId: bc[1], platform: "BIGCOMMERCE", needsEbayPlatform: false };
      }
    }
    if (!bcHostNorm && u.hostname.endsWith(".mybigcommerce.com")) {
      const bc = path.match(/\/manage\/products\/edit\/(\d+)/);
      if (bc) {
        return { itemId: bc[1], platform: "BIGCOMMERCE", needsEbayPlatform: false };
      }
    }
    return null;
  }

  function injectFloat(parsed, defaultEbayPlatform) {
    if (document.getElementById(FLOAT_ID)) return;

    const wrap = document.createElement("div");
    wrap.id = FLOAT_ID;
    wrap.setAttribute(
      "style",
      [
        "position:fixed",
        "z-index:2147483646",
        "right:16px",
        "bottom:16px",
        "font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
        "box-shadow:0 4px 24px rgba(0,0,0,.25)",
        "border-radius:10px",
        "overflow:hidden",
        "display:flex",
        "flex-direction:column",
        "max-width:min(280px,calc(100vw - 32px))",
      ].join(";"),
    );

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Open in reorG";
    btn.setAttribute(
      "style",
      [
        "margin:0",
        "padding:12px 16px",
        "border:none",
        "cursor:pointer",
        "background:#7c3aed",
        "color:#fff",
        "font-size:14px",
        "font-weight:600",
        "width:100%",
        "text-align:center",
      ].join(";"),
    );

    const sub = document.createElement("div");
    sub.textContent =
      "Item " +
      parsed.itemId +
      (parsed.needsEbayPlatform ? " · " + (defaultEbayPlatform || "TPP_EBAY") : parsed.platform ? " · " + parsed.platform : "");
    sub.setAttribute(
      "style",
      "padding:8px 12px;font-size:11px;background:#18181b;color:#e4e4e7;opacity:.95",
    );

    btn.addEventListener("click", () => {
      const platform = parsed.needsEbayPlatform ? defaultEbayPlatform || "TPP_EBAY" : parsed.platform;
      chrome.runtime.sendMessage({
        type: "OPEN_REORG",
        payload: { itemId: parsed.itemId, platform },
      });
    });

    wrap.appendChild(btn);
    wrap.appendChild(sub);
    document.documentElement.appendChild(wrap);
  }

  chrome.storage.sync.get(
    {
      bigcommerceHost: "",
      defaultEbayPlatform: "TPP_EBAY",
    },
    (s) => {
      const parsed = parseListingUrl(window.location.href, s.bigcommerceHost || "");
      if (!parsed) return;
      injectFloat(parsed, s.defaultEbayPlatform);
    },
  );
})();
