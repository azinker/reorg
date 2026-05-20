const REORG_BASE_URL = "https://reorg.theperfectpart.net";

const skuInput = document.getElementById("sku");
const quantityInput = document.getElementById("quantity");
const onHand = document.getElementById("onHand");
const stockCard = document.getElementById("stockCard");
const statusEl = document.getElementById("status");
const addButton = document.getElementById("add");
const removeButton = document.getElementById("remove");

let lookupTimer = null;
let activeLookup = null;
let lastLookupSku = "";

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

function setOnHand(quantity) {
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
  const response = await fetch(`${REORG_BASE_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error || `Request failed (${response.status})`);
  }
  return json.data;
}

async function lookupQuantity() {
  const sku = skuInput.value.trim();
  if (!sku) {
    setOnHand(null);
    setStatus("Enter a SKU to load current quantity.");
    return;
  }
  if (sku === lastLookupSku) return;
  lastLookupSku = sku;

  if (activeLookup) activeLookup.abort();
  const controller = new AbortController();
  activeLookup = controller;

  setStatus("Loading current quantity...");
  try {
    const data = await apiFetch(`/api/skuvault/quantity?sku=${encodeURIComponent(sku)}`, {
      method: "GET",
      signal: controller.signal,
      headers: {},
    });
    setOnHand(Number(data.quantityOnHand));
    setStatus(`Current stock loaded for ${data.sku}.`, "ok");
    chrome.storage.local.set({ lastSku: sku }).catch(() => {});
  } catch (error) {
    if (error.name === "AbortError") return;
    setOnHand(null);
    setStatus(error.message || "Could not load quantity.", "error");
  }
}

function scheduleLookup() {
  window.clearTimeout(lookupTimer);
  lookupTimer = window.setTimeout(() => {
    lookupQuantity();
  }, 900);
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

  setBusy(true);
  setStatus(`${action === "add" ? "Adding" : "Removing"} ${quantity}...`);
  try {
    const data = await apiFetch("/api/skuvault/adjust", {
      method: "POST",
      body: JSON.stringify({ sku, quantity, action }),
    });
    setOnHand(Number(data.quantityOnHand));
    setStatus(
      `${action === "add" ? "Added" : "Removed"} ${quantity}. On hand is now ${data.quantityOnHand}.`,
      "ok",
    );
    chrome.storage.local.set({ lastSku: sku }).catch(() => {});
  } catch (error) {
    lastLookupSku = "";
    setStatus(error.message || "SkuVault update failed.", "error");
  } finally {
    setBusy(false);
  }
}

skuInput.addEventListener("input", scheduleLookup);
skuInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    lookupQuantity();
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

chrome.storage.local.get(["lastSku"]).then((result) => {
  if (typeof result.lastSku === "string" && result.lastSku.trim()) {
    skuInput.value = result.lastSku.trim();
    setStatus("Press Enter or edit the SKU to load current quantity.");
    skuInput.focus();
  } else {
    skuInput.focus();
  }
}).catch(() => skuInput.focus());
