const STORAGE_KEY = "reorg_platform_fee_rate";
const DB_KEY = "platformFeeRate";
const DEFAULT_RATE = 0.136;

let cached: number | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function load(): number {
  if (cached != null) return cached;
  if (typeof window === "undefined") return DEFAULT_RATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cached = raw ? Number(JSON.parse(raw)) : DEFAULT_RATE;
    if (isNaN(cached!)) cached = DEFAULT_RATE;
    return cached!;
  } catch {
    return DEFAULT_RATE;
  }
}

function persist(rate: number) {
  cached = rate;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rate));
    } catch { /* quota */ }
  }
  listeners.forEach((fn) => fn());

  fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: DB_KEY, value: rate }),
  }).catch((err) => console.error("[platform-fee] persist failed", err));
}

export function getPlatformFeeRate(): number {
  return load();
}

export function setPlatformFeeRate(rate: number) {
  persist(rate);
}

export function subscribePlatformFeeRate(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function hydratePlatformFeeRate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const res = await fetch(`/api/settings?key=${DB_KEY}`);
    if (!res.ok) return;
    const json = await res.json();
    if (json.data != null && typeof json.data === "number") {
      cached = json.data;
      if (typeof window !== "undefined") {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(json.data));
      }
      listeners.forEach((fn) => fn());
    }
  } catch (err) {
    console.error("[platform-fee] hydrate failed", err);
  }
}
