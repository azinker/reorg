const STORAGE_KEY = "reorg_shipping_rates";

export interface ShippingRateEntry {
  weight: string;
  normalizedOz: number;
  cost: number | null;
}

const DEFAULT_TIERS: ShippingRateEntry[] = [
  ...Array.from({ length: 16 }, (_, i) => ({
    weight: `${i + 1}`,
    normalizedOz: i + 1,
    cost: null,
  })),
  ...Array.from({ length: 9 }, (_, i) => ({
    weight: `${i + 2}LBS`,
    normalizedOz: (i + 2) * 16,
    cost: null,
  })),
];

let cachedRates: ShippingRateEntry[] | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function load(): ShippingRateEntry[] {
  if (cachedRates) return cachedRates;
  if (typeof window === "undefined") return DEFAULT_TIERS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cachedRates = raw ? JSON.parse(raw) : DEFAULT_TIERS;
    return cachedRates!;
  } catch {
    return DEFAULT_TIERS;
  }
}

function save(rates: ShippingRateEntry[]) {
  cachedRates = rates;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rates));
    } catch { /* quota */ }
  }
  listeners.forEach((fn) => fn());
}

export function getShippingRates(): ShippingRateEntry[] {
  return load();
}

export function setShippingRates(rates: ShippingRateEntry[]) {
  save(rates);

  const payload = rates.map((r) => ({ weightKey: r.weight, cost: r.cost }));

  fetch("/api/shipping-rates", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rates: payload }),
  }).catch((err) => console.error("[shipping-rates] persist failed", err));
}

export function subscribeShippingRates(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function lookupShippingCost(weightStr: string | null): number | null {
  if (!weightStr) return null;
  const rates = load();

  const normalized = weightStr.trim().toUpperCase();
  let ozValue: number;

  if (normalized.endsWith("LBS")) {
    const lbs = parseFloat(normalized.replace("LBS", ""));
    if (isNaN(lbs)) return null;
    ozValue = lbs * 16;
  } else if (normalized.endsWith("OZ")) {
    ozValue = parseFloat(normalized.replace("OZ", ""));
    if (isNaN(ozValue)) return null;
  } else {
    ozValue = parseFloat(normalized);
    if (isNaN(ozValue)) return null;
  }

  const exact = rates.find((r) => r.normalizedOz === ozValue);
  if (exact && exact.cost != null) return exact.cost;

  return null;
}

export async function hydrateShippingRates(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const res = await fetch("/api/shipping-rates");
    if (!res.ok) return;
    const json = await res.json();
    const dbRates: Array<{ weightKey: string; weightOz: number; cost: number | null }> = json.data;
    if (!Array.isArray(dbRates) || dbRates.length === 0) return;

    const merged: ShippingRateEntry[] = DEFAULT_TIERS.map((tier) => {
      const match = dbRates.find((r) => r.weightKey === tier.weight);
      return match ? { ...tier, cost: match.cost } : tier;
    });

    save(merged);
  } catch (err) {
    console.error("[shipping-rates] hydrate failed", err);
  }
}
