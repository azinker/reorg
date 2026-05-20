(function purchaseHistoryScript() {
  const HOST_ID = "tpp-ph-summary-host";
  const MODAL_STYLE_ID = "tpp-ph-modal-style";
  const DAYS_TO_SHOW = 30;
  const MONTHS = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11
  };

  let renderTimer = null;

  function isModalView() {
    if (window.self !== window.top) return true;
    return new URLSearchParams(window.location.search).get("tppModal") === "1";
  }

  function ensureModalPageStyles() {
    if (!isModalView()) return;
    if (document.getElementById(MODAL_STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = MODAL_STYLE_ID;
    style.textContent = `
      header,
      footer,
      #gh,
      #glbfooter,
      .gh-header,
      .global-header,
      .global-footer,
      nav[role="navigation"],
      .breadcrumbs,
      .seo-breadcrumbs-container {
        display: none !important;
      }
      body {
        margin: 0 !important;
        padding: 12px !important;
        background: #ffffff !important;
        overflow-x: hidden !important;
      }
      main,
      #mainContent,
      #mainCont,
      .pagecontainer {
        max-width: none !important;
        width: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      table {
        width: 100% !important;
        max-width: 100% !important;
        table-layout: auto !important;
      }
      #${HOST_ID} {
        margin-top: 0 !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function formatCurrency(value) {
    if (!Number.isFinite(value)) return "N/A";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value);
  }

  function formatDate(date) {
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }

  function parsePrice(text) {
    if (!text) return null;
    const normalized = text.replace(/[^0-9.\-]/g, "");
    if (!normalized) return null;
    const value = Number.parseFloat(normalized);
    return Number.isFinite(value) ? value : null;
  }

  function parseQuantity(text) {
    if (!text) return 0;
    const normalized = text.replace(/[^0-9\-]/g, "");
    const value = Number.parseInt(normalized, 10);
    return Number.isFinite(value) ? value : 0;
  }

  function parsePurchaseDate(text) {
    if (!text) return null;
    const match = text.match(/\b(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\b/);
    if (!match) return null;

    const day = Number.parseInt(match[1], 10);
    const monthIdx = MONTHS[match[2].toLowerCase()];
    const year = Number.parseInt(match[3], 10);

    if (!Number.isInteger(day) || monthIdx === undefined || !Number.isInteger(year)) {
      return null;
    }

    const date = new Date(year, monthIdx, day);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  function findPurchaseHistoryTable() {
    const tables = [...document.querySelectorAll("table")];
    for (const table of tables) {
      const headerCells = [...table.querySelectorAll("tr th, tr td")]
        .slice(0, 18)
        .map((el) => (el.textContent || "").trim().toLowerCase());
      const headerText = headerCells.join(" | ");
      const hasDate = headerText.includes("date of purchase");
      const hasQuantity = headerText.includes("quantity");
      const hasPrice = headerText.includes("buy it now price");
      if (hasDate && hasQuantity && hasPrice) {
        return table;
      }
    }
    return null;
  }

  function mapColumnIndexes(table) {
    const headerRow = [...table.querySelectorAll("tr")].find((tr) => {
      const txt = (tr.textContent || "").toLowerCase();
      return (
        txt.includes("date of purchase") &&
        txt.includes("quantity") &&
        txt.includes("buy it now price")
      );
    });
    if (!headerRow) return null;

    const cells = [...headerRow.querySelectorAll("th, td")];
    const map = {};
    cells.forEach((cell, idx) => {
      const text = (cell.textContent || "").trim().toLowerCase();
      if (text.includes("buy it now price")) map.price = idx;
      if (text === "quantity" || text.includes("quantity")) map.quantity = idx;
      if (text.includes("date of purchase")) map.date = idx;
    });

    if (
      !Number.isInteger(map.price) ||
      !Number.isInteger(map.quantity) ||
      !Number.isInteger(map.date)
    ) {
      return null;
    }

    return { map, headerRow };
  }

  function parseRows(table) {
    const mapped = mapColumnIndexes(table);
    if (!mapped) return [];

    const { map, headerRow } = mapped;
    const allRows = [...table.querySelectorAll("tr")];
    const rows = [];

    for (const tr of allRows) {
      if (tr === headerRow) continue;
      const tds = [...tr.querySelectorAll("td")];
      if (!tds.length) continue;

      const dateText = tds[map.date]?.textContent?.trim() || "";
      const quantityText = tds[map.quantity]?.textContent?.trim() || "";
      const priceText = tds[map.price]?.textContent?.trim() || "";
      const parsedDate = parsePurchaseDate(dateText);
      if (!parsedDate) continue;

      const quantity = Math.max(0, parseQuantity(quantityText));
      const price = parsePrice(priceText);
      const hasValidPrice = Number.isFinite(price);

      rows.push({
        date: parsedDate,
        quantity,
        price: hasValidPrice ? Number(price) : null,
        hasValidPrice
      });
    }

    return rows;
  }

  function startOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function computeLast30Days(rows) {
    if (!rows.length) return null;

    const today = startOfToday();
    const windowStart = addDays(today, -(DAYS_TO_SHOW - 1));
    const windowEndExclusive = addDays(today, 1);
    const rowsInWindow = rows.filter(
      (row) => row.date >= windowStart && row.date < windowEndExclusive
    );
    const pricedRows = rowsInWindow.filter((row) => row.hasValidPrice);
    const totalRevenue = pricedRows.reduce((sum, row) => sum + (row.price || 0), 0);
    const totalUnits = rowsInWindow.reduce((sum, row) => sum + row.quantity, 0);
    const activeSaleDays = new Set(rowsInWindow.map((row) => dateKey(row.date))).size;
    const lastSaleDate = rowsInWindow.length
      ? [...rowsInWindow].sort((a, b) => b.date - a.date)[0].date
      : null;

    return {
      windowStart,
      windowEnd: today,
      salesCount: rowsInWindow.length,
      totalUnits,
      totalRevenue,
      pricedSalesCount: pricedRows.length,
      activeSaleDays,
      lastSaleDate
    };
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;

    host = document.createElement("section");
    host.id = HOST_ID;

    const container =
      document.querySelector("main") ||
      document.querySelector("#mainContent") ||
      document.querySelector("#mainCont") ||
      document.querySelector(".pagecontainer") ||
      document.body;

    container.insertAdjacentElement("afterbegin", host);
    return host;
  }

  function renderPanel(contentHtml, bindHandlers) {
    const host = ensureHost();
    const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
    const modal = isModalView();

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .tpp-wrap {
          font-family: "Segoe UI", Tahoma, Arial, sans-serif;
          display: block;
          margin: ${modal ? "0 0 12px 0" : "14px 0 18px 0"};
          border: 1px solid #d7d7d9;
          border-radius: 12px;
          background: #ffffff;
          box-shadow: 0 8px 24px rgba(17, 17, 17, 0.08);
          overflow: hidden;
          color: #111111;
        }
        .tpp-header {
          background: #111111;
          color: #ffffff;
          padding: 10px 14px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
        }
        .tpp-brand strong {
          color: #bf1e2e;
          letter-spacing: 0.08em;
          font-size: 13px;
          text-transform: uppercase;
        }
        .tpp-brand small {
          display: block;
          color: #c8c8ca;
          font-size: 11px;
          margin-top: 2px;
          letter-spacing: 0.04em;
        }
        .tpp-subtitle {
          color: #ffffff;
          font-size: 12px;
          font-weight: 700;
          white-space: nowrap;
        }
        .tpp-body {
          padding: 14px;
          background: #ffffff;
        }
        .tpp-summary {
          border: 1px solid #ececee;
          border-left: 4px solid #bf1e2e;
          border-radius: 10px;
          padding: 14px;
          background: #fbfbfc;
        }
        .tpp-label {
          margin: 0 0 6px 0;
          color: #404041;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .tpp-sales-count {
          margin: 0;
          color: #111111;
          font-size: 34px;
          font-weight: 800;
          line-height: 1.1;
        }
        .tpp-copy {
          margin: 8px 0 0 0;
          color: #2f3136;
          font-size: 13px;
          line-height: 1.45;
        }
        .tpp-details {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 12px;
        }
        .tpp-chip {
          border: 1px solid #dbe2eb;
          border-radius: 999px;
          background: #f0f3f8;
          color: #2f3136;
          font-size: 12px;
          font-weight: 600;
          padding: 4px 10px;
        }
        .tpp-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-top: 12px;
        }
        .tpp-btn {
          border: none;
          border-radius: 8px;
          padding: 8px 12px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .tpp-btn-refresh {
          background: #111111;
          color: #ffffff;
        }
      </style>
      <div class="tpp-wrap">${contentHtml}</div>
    `;

    bindHandlers(shadow);
  }

  function renderRefreshActions() {
    if (isModalView()) return "";
    return `
        <div class="tpp-actions">
          <button id="tpp-refresh-btn" class="tpp-btn tpp-btn-refresh" type="button">Refresh</button>
        </div>`;
  }

  function renderError(message) {
    const contentHtml = `
      <div class="tpp-header">
        <div class="tpp-brand">
          <strong>THE PERFECT PART</strong>
          <small>THE PERFECT PART INC.</small>
        </div>
        <div class="tpp-subtitle">eBay Sold History</div>
      </div>
      <div class="tpp-body">
        <div class="tpp-summary">
          <p class="tpp-label">Last 30 days</p>
          <p class="tpp-copy">${escapeHtml(message)}</p>
        </div>
        ${renderRefreshActions()}
      </div>
    `;

    renderPanel(contentHtml, (shadow) => {
      const refreshBtn = shadow.getElementById("tpp-refresh-btn");
      if (refreshBtn) refreshBtn.onclick = () => queueRender();
    });
  }

  function renderMetrics(metrics) {
    const saleWord = metrics.salesCount === 1 ? "sale" : "sales";
    const unitWord = metrics.totalUnits === 1 ? "unit" : "units";
    const activeDayWord = metrics.activeSaleDays === 1 ? "day" : "days";
    const pricedSaleWord = metrics.pricedSalesCount === 1 ? "sale" : "sales";
    const pricedCopy =
      metrics.pricedSalesCount > 0
        ? `${formatCurrency(metrics.totalRevenue)} from ${metrics.pricedSalesCount} priced ${pricedSaleWord}.`
        : "No valid prices were found in this date range.";
    const lastSaleCopy = metrics.lastSaleDate
      ? `Last sale in this range: ${formatDate(metrics.lastSaleDate)}.`
      : "No sales were found in this date range.";

    const contentHtml = `
      <div class="tpp-header">
        <div class="tpp-brand">
          <strong>THE PERFECT PART</strong>
          <small>THE PERFECT PART INC.</small>
        </div>
        <div class="tpp-subtitle">eBay Sold History</div>
      </div>
      <div class="tpp-body">
        <div class="tpp-summary">
          <p class="tpp-label">Last 30 days</p>
          <p class="tpp-sales-count">${metrics.salesCount} ${saleWord}</p>
          <p class="tpp-copy">
            From ${formatDate(metrics.windowStart)} through ${formatDate(metrics.windowEnd)}, this listing had
            <strong>${metrics.salesCount}</strong> ${saleWord} totaling
            <strong>${metrics.totalUnits}</strong> ${unitWord}.
          </p>
          <div class="tpp-details">
            <span class="tpp-chip">${metrics.activeSaleDays} active sale ${activeDayWord}</span>
            <span class="tpp-chip">${pricedCopy}</span>
            <span class="tpp-chip">${lastSaleCopy}</span>
          </div>
        </div>
        ${renderRefreshActions()}
      </div>
    `;

    renderPanel(contentHtml, (shadow) => {
      const refreshBtn = shadow.getElementById("tpp-refresh-btn");
      if (refreshBtn) refreshBtn.onclick = () => queueRender();
    });
  }

  function parseAndRender() {
    ensureModalPageStyles();
    const table = findPurchaseHistoryTable();
    if (!table) {
      renderError("Waiting for purchase history table...");
      return;
    }

    const rows = parseRows(table);
    if (!rows.length) {
      renderError("Table found, but no parseable data rows are available yet.");
      return;
    }

    const metrics = computeLast30Days(rows);
    if (!metrics) {
      renderError("Unable to summarize sales from available table data.");
      return;
    }

    renderMetrics(metrics);
  }

  function queueRender() {
    if (renderTimer) window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => {
      parseAndRender();
    }, 120);
  }

  queueRender();

  const observer = new MutationObserver(() => {
    queueRender();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
