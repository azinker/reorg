const REORG_BASE_URL = "https://reorg.theperfectpart.net";
const LOOKUP_DEBOUNCE_MS = 450;

const skuInput = document.getElementById("sku");
const quantityInput = document.getElementById("quantity");
const onHand = document.getElementById("onHand");
const beforeQty = document.getElementById("beforeQty");
const changeQty = document.getElementById("changeQty");
const afterQty = document.getElementById("afterQty");
const stockCard = document.getElementById("stockCard");
const statusEl = document.getElementById("status");
const addButton = document.getElementById("add");
const removeButton = document.getElementById("remove");

let lookupTimer = null;
let activeLookup = null;
let activeLookupId = 0;
let lastLoadedSku = "";
let currentQuantity = null;

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function setBusy(isBusy) {
  addButton.disabled = isBusy;
  removeButton.disabled = isBusy;
  skuInput.disabled = isBusy;
  quantityInput.disabled = isBusy;
}

function resetMetrics() {
  beforeQty.textContent = "-";
  changeQty.textContent = "-";
  afterQty.textContent = "-";
  beforeQty.className = "";
  changeQty.className = "";
  afterQty.className = "";
}

function formatQuantity(quantity) {
  const numberValue = Number(quantity);
  return Number.isFinite(numberValue) ? String(numberValue) : "-";
}

function setChange(quantity, action) {
  const numberValue = Number(quantity);
  if (!Number.isFinite(numberValue)) {
    changeQty.textContent = "-";
    changeQty.className = "";
    return;
  }

  const signed = action === "remove" ? -numberValue : numberValue;
  changeQty.textContent = signed > 0 ? `+${signed}` : String(signed);
  changeQty.className = signed < 0 ? "negative" : "positive";
}

function setOnHand(quantity) {
  currentQuantity = Number.isFinite(quantity) ? quantity : null;
  onHand.textContent = Number.isFinite(quantity) ? String(quantity) : "-";
  stockCard.classList.remove("good", "low", "muted");
  if (!Number.isFinite(quantity)) {
    stockCard.classList.add("muted");
  } else if (quantity > 5) {
    stockCard.classList.add("good");
  } else {
    stockCard.classList.add("low");
  }
}

async function apiFetch(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(`${REORG_BASE_URL}${path}`, {
    ...options,
    credentials: "include",
    headers,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(json.error || `Request failed (${response.status})`);
    error.details = json.details;
    throw error;
  }
  return json.data;
}

function resetForSkuEdit() {
  lastLoadedSku = "";
  setOnHand(null);
  resetMetrics();
}

async function lookupQuantity({ force = false } = {}) {
  const sku = skuInput.value.trim();
  if (!sku) {
    if (activeLookup) activeLookup.abort();
    resetForSkuEdit();
    setStatus("Enter a SKU to load current quantity.");
    return;
  }
  if (!force && sku === lastLoadedSku && currentQuantity !== null) return;

  if (activeLookup) activeLookup.abort();
  const controller = new AbortController();
  const lookupId = activeLookupId + 1;
  activeLookupId = lookupId;
  activeLookup = controller;

  setStatus("Loading current quantity...");
  try {
    const data = await apiFetch(`/api/skuvault/quantity?sku=${encodeURIComponent(sku)}`, {
      method: "GET",
      signal: controller.signal,
    });
    if (lookupId !== activeLookupId) return;
    lastLoadedSku = data.sku;
    setOnHand(Number(data.quantityOnHand));
    resetMetrics();
    setStatus(`Current quantity for ${data.sku}: ${data.quantityOnHand}.`, "ok");
  } catch (error) {
    if (error.name === "AbortError") return;
    if (lookupId !== activeLookupId) return;
    resetForSkuEdit();
    setStatus(error.message || "Could not load quantity.", "error");
  } finally {
    if (lookupId === activeLookupId) activeLookup = null;
  }
}

function scheduleLookup() {
  window.clearTimeout(lookupTimer);
  lookupTimer = window.setTimeout(() => {
    lookupQuantity();
  }, LOOKUP_DEBOUNCE_MS);
}

function renderAdjustment(data) {
  const previous = Number(data.previousQuantityOnHand);
  const changed = Number(data.quantityChanged);
  const after = Number(data.quantityOnHand);
  beforeQty.textContent = formatQuantity(previous);
  setChange(changed, data.action);
  afterQty.textContent = formatQuantity(after);
  afterQty.className = "";
  setOnHand(after);
}

async function adjust(action) {
  const sku = skuInput.value.trim();
  const quantity = Number(quantityInput.value);
  if (!sku) {
    setStatus("Enter a SKU first.", "error");
    skuInput.focus();
    return;
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    setStatus("Quantity must be a positive whole number.", "error");
    quantityInput.focus();
    return;
  }

  window.clearTimeout(lookupTimer);
  if (activeLookup) activeLookup.abort();
  activeLookup = null;
  activeLookupId += 1;

  setBusy(true);
  setStatus(`${action === "add" ? "Adding" : "Removing"} ${quantity} for ${sku}...`);
  try {
    const data = await apiFetch("/api/skuvault/adjust", {
      method: "POST",
      body: JSON.stringify({ sku, quantity, action }),
    });
    lastLoadedSku = data.sku;
    renderAdjustment(data);
    setStatus(
      `${action === "add" ? "Added" : "Removed"} ${quantity} for ${data.sku}. Before ${data.previousQuantityOnHand}, after ${data.quantityOnHand}.`,
      "ok",
    );
  } catch (error) {
    lastLoadedSku = "";
    setStatus(error.message || "SkuVault update failed.", "error");
  } finally {
    setBusy(false);
  }
}

skuInput.addEventListener("input", () => {
  resetForSkuEdit();
  scheduleLookup();
});
skuInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    lookupQuantity({ force: true });
  }
});
quantityInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    adjust("add");
  }
});
addButton.addEventListener("click", () => adjust("add"));
removeButton.addEventListener("click", () => adjust("remove"));

skuInput.value = "";
quantityInput.value = "1";
setOnHand(null);
resetMetrics();
skuInput.focus();
