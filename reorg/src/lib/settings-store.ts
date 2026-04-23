const STORAGE_KEY = "reorg_settings";
const DB_KEY = "appSettings";

export type Density = "compact" | "comfortable" | "spacious";
export type RowHeight = "compact" | "default" | "expanded";
export type SortColumn = "title" | "sku" | "inventory" | "upc";

export interface AppSettings {
  density: Density;
  timezone: string;
  frozenColumns: boolean;
  searchBar: boolean;
  rowTextSize: number;
  rowHeight: RowHeight;
  showAlternateTitles: boolean;
  defaultSort: SortColumn;
  autoExpandVariations: boolean;
  globalWriteLock: boolean;
  livePushEnabled: boolean;
  helpdeskSafeMode: boolean;
}

const DEFAULTS: AppSettings = {
  density: "comfortable",
  timezone: "America/New_York",
  frozenColumns: true,
  searchBar: true,
  rowTextSize: 12,
  rowHeight: "default",
  showAlternateTitles: true,
  defaultSort: "title",
  autoExpandVariations: false,
  globalWriteLock: false,
  livePushEnabled: false,
  helpdeskSafeMode: true,
};

let cached: AppSettings | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function load(): AppSettings {
  if (cached) return cached;
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cached = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    return cached!;
  } catch {
    return DEFAULTS;
  }
}

function persist(settings: AppSettings) {
  cached = settings;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch { /* quota */ }
  }
  listeners.forEach((fn) => fn());

  fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: DB_KEY, value: settings }),
  }).catch((err) => console.error("[settings] persist failed", err));

  // Keep global_write_lock in sync for server-side safety checks (safety.ts)
  fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "global_write_lock", value: settings.globalWriteLock }),
  }).catch((err) => console.error("[settings] global_write_lock persist failed", err));

  fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "live_push_enabled", value: settings.livePushEnabled }),
  }).catch((err) => console.error("[settings] live_push_enabled persist failed", err));

  fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "helpdesk_safe_mode", value: settings.helpdeskSafeMode }),
  }).catch((err) => console.error("[settings] helpdesk_safe_mode persist failed", err));
}

export function getSettings(): AppSettings {
  return load();
}

export function updateSettings(partial: Partial<AppSettings>) {
  const current = load();
  persist({ ...current, ...partial });
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getDensityPadding(density: Density): { px: string; py: string } {
  switch (density) {
    case "compact": return { px: "px-1.5", py: "py-0.5" };
    case "spacious": return { px: "px-4", py: "py-3" };
    default: return { px: "px-3", py: "py-2" };
  }
}

export function getRowHeightEstimate(rowHeight: RowHeight): number {
  switch (rowHeight) {
    case "compact": return 80;
    case "expanded": return 140;
    default: return 110;
  }
}

export async function hydrateSettings(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const [resApp, resLock, resLivePush, resSafeMode] = await Promise.all([
      fetch(`/api/settings?key=${DB_KEY}`),
      fetch(`/api/settings?key=global_write_lock`),
      fetch(`/api/settings?key=live_push_enabled`),
      fetch(`/api/settings?key=helpdesk_safe_mode`),
    ]);
    let merged: Partial<AppSettings> = { ...DEFAULTS };
    if (resApp.ok) {
      const json = await resApp.json();
      if (json.data != null && typeof json.data === "object") {
        merged = { ...DEFAULTS, ...(json.data as Partial<AppSettings>) };
      }
    }
    if (resLock.ok) {
      const json = await resLock.json();
      if (typeof json.data === "boolean") {
        merged.globalWriteLock = json.data;
      }
    }
    if (resLivePush.ok) {
      const json = await resLivePush.json();
      if (typeof json.data === "boolean") {
        merged.livePushEnabled = json.data;
      }
    }
    if (resSafeMode.ok) {
      const json = await resSafeMode.json();
      if (typeof json.data === "boolean") {
        merged.helpdeskSafeMode = json.data;
      }
    }
    cached = { ...DEFAULTS, ...merged };
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
    }
    listeners.forEach((fn) => fn());
  } catch (err) {
    // "Failed to fetch" / AbortError surface in the console as scary red
    // text but they're benign — they happen when the page navigates while
    // these three /api/settings calls are still in flight (e.g. user logs
    // in and clicks the sidebar before settings have finished hydrating).
    // Settings will hydrate again on the next page load, so silence them.
    const benign =
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof TypeError && /failed to fetch/i.test(err.message));
    if (!benign) {
      console.error("[settings] hydrate failed", err);
    }
  }
}
