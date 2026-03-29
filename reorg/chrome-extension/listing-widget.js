/* global chrome */
(function () {
  const FLOAT_ID = "reorg-dashboard-link-float";

  /** reorG brand: logo crimson + charcoal (see public/logos/reorg-icon.svg); dashboard primary violet family */
  const BRAND = {
    crimson: "#B5282D",
    crimsonHover: "#9f2227",
    surface: "#141416",
    surfaceMuted: "#0c0c0e",
    border: "rgba(181, 40, 45, 0.45)",
    text: "#fafafa",
    textMuted: "#a8a29e",
    accentLine: "rgba(181, 40, 45, 0.25)",
    font: "'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  };

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
        `font-family:${BRAND.font}`,
        `box-shadow:0 10px 40px rgba(0,0,0,.38),0 0 0 1px ${BRAND.accentLine}`,
        "border-radius:12px",
        "overflow:hidden",
        "display:flex",
        "flex-direction:column",
        "max-width:min(300px,calc(100vw - 32px))",
        `border:1px solid ${BRAND.border}`,
        `background:linear-gradient(180deg, ${BRAND.surface} 0%, ${BRAND.surfaceMuted} 100%)`,
      ].join(";"),
    );

    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", "Open this listing in reorG dashboard");
    const titleLine = document.createElement("span");
    titleLine.textContent = "Open in ";
    const brandSpan = document.createElement("span");
    brandSpan.textContent = "reorG";
    brandSpan.setAttribute(
      "style",
      `font-weight:800;color:${BRAND.text};letter-spacing:-0.02em;text-shadow:0 1px 0 rgba(0,0,0,.2)`,
    );
    btn.appendChild(titleLine);
    btn.appendChild(brandSpan);
    btn.setAttribute(
      "style",
      [
        "margin:0",
        "padding:13px 16px 12px",
        "border:none",
        "cursor:pointer",
        `background:linear-gradient(180deg, ${BRAND.crimson} 0%, ${BRAND.crimsonHover} 100%)`,
        `color:${BRAND.text}`,
        "font-size:14px",
        "font-weight:600",
        "width:100%",
        "text-align:center",
        "line-height:1.35",
        `letter-spacing:0.02em`,
      ].join(";"),
    );
    btn.addEventListener("mouseenter", () => {
      btn.style.filter = "brightness(1.06)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.filter = "none";
    });

    const sub = document.createElement("div");
    sub.setAttribute(
      "style",
      [
        "padding:8px 12px 9px",
        "font-size:11px",
        `background:${BRAND.surfaceMuted}`,
        `color:${BRAND.textMuted}`,
        "line-height:1.45",
        `border-top:1px solid ${BRAND.accentLine}`,
      ].join(";"),
    );
    const label = document.createElement("span");
    label.textContent = "Item ";
    label.style.color = BRAND.textMuted;
    const itemIdSpan = document.createElement("span");
    itemIdSpan.textContent = parsed.itemId;
    itemIdSpan.style.color = "#e7e5e4";
    itemIdSpan.style.fontWeight = "500";
    const sep = document.createElement("span");
    sep.textContent = " · ";
    sep.style.color = BRAND.textMuted;
    const platSpan = document.createElement("span");
    platSpan.textContent = parsed.needsEbayPlatform
      ? defaultEbayPlatform || "TPP_EBAY"
      : parsed.platform
        ? parsed.platform
        : "";
    platSpan.style.color = BRAND.crimson;
    platSpan.style.fontWeight = "600";
    sub.appendChild(label);
    sub.appendChild(itemIdSpan);
    sub.appendChild(sep);
    sub.appendChild(platSpan);

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
