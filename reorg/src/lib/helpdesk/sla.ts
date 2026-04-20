/**
 * Help-desk SLA / response-time computation.
 *
 * eBay's seller response policy buckets every buyer message into a "time to
 * first response" target. We mirror that with three buckets:
 *
 *   GREEN   < 12h business hours from buyer's last message
 *   AMBER   12h <= elapsed < 24h
 *   RED     >= 24h
 *
 * "Business hours" defaults to Mon–Fri 09:00–17:00 in the configured shop
 * timezone (America/New_York unless overridden in Settings). Weekends are
 * skipped entirely. This is intentionally simple in v1 — we do not honor
 * holidays, partial days, or per-store schedules. The function is pure so it
 * can be reused on the server (cron) and the client (timer chip).
 *
 * The "deadline" for first response is `lastBuyerMessageAt + 24h business`.
 * We never tick the clock once `firstResponseAt` is set.
 */

export type SlaBucket = "GREEN" | "AMBER" | "RED" | "MET" | "NA";

export interface SlaConfig {
  /** IANA timezone, e.g. "America/New_York". */
  timezone?: string;
  /** Day-of-week start (0 = Sun, 1 = Mon, …). Default Mon (1). */
  workWeekStart?: number;
  /** Day-of-week end inclusive. Default Fri (5). */
  workWeekEnd?: number;
  /** 24h start hour, 0-23. Default 9. */
  startHour?: number;
  /** 24h end hour, 0-23. Default 17. */
  endHour?: number;
  /** Bucket thresholds in business-hour MILLISECONDS. */
  amberAfterMs?: number;
  redAfterMs?: number;
  /** Total response budget in business-hour ms. Default 24h = 86_400_000. */
  budgetMs?: number;
}

export const DEFAULT_SLA_CONFIG: Required<SlaConfig> = {
  timezone: "America/New_York",
  workWeekStart: 1,
  workWeekEnd: 5,
  startHour: 9,
  endHour: 17,
  amberAfterMs: 12 * 60 * 60 * 1000,
  redAfterMs: 24 * 60 * 60 * 1000,
  budgetMs: 24 * 60 * 60 * 1000,
};

export interface SlaInput {
  /** Set when the buyer sent the most recent message awaiting agent reply. */
  lastBuyerMessageAt: Date | null;
  /** Set once the agent has replied at all in this thread. */
  firstResponseAt: Date | null;
  now?: Date;
}

export interface SlaResult {
  bucket: SlaBucket;
  /** ms of business-hours elapsed since the buyer's last message. */
  elapsedBusinessMs: number;
  /** ms remaining until RED (negative if already red). */
  remainingBusinessMs: number;
  /** Wall-clock ETA when budget will run out. May be far in the future on
   *  weekends; null if no buyer-pending state. */
  dueAt: Date | null;
}

/** Compute SLA bucket for a single ticket. */
export function computeSla(
  input: SlaInput,
  cfg: SlaConfig = {},
): SlaResult {
  const c = { ...DEFAULT_SLA_CONFIG, ...cfg };
  const now = input.now ?? new Date();

  if (!input.lastBuyerMessageAt) {
    return { bucket: "NA", elapsedBusinessMs: 0, remainingBusinessMs: c.budgetMs, dueAt: null };
  }
  // If buyer wrote, then we replied AFTER that message, the SLA is met.
  if (
    input.firstResponseAt &&
    input.firstResponseAt.getTime() >= input.lastBuyerMessageAt.getTime()
  ) {
    return { bucket: "MET", elapsedBusinessMs: 0, remainingBusinessMs: c.budgetMs, dueAt: null };
  }

  const elapsed = businessMillisBetween(input.lastBuyerMessageAt, now, c);
  const remaining = c.budgetMs - elapsed;
  const dueAt = addBusinessMillis(input.lastBuyerMessageAt, c.budgetMs, c);
  let bucket: SlaBucket = "GREEN";
  if (elapsed >= c.redAfterMs) bucket = "RED";
  else if (elapsed >= c.amberAfterMs) bucket = "AMBER";
  return { bucket, elapsedBusinessMs: elapsed, remainingBusinessMs: remaining, dueAt };
}

// ---------------------------------------------------------------------------
// Business-hour math (timezone-aware via Intl).
// ---------------------------------------------------------------------------

interface ResolvedConfig extends Required<SlaConfig> {}

/** True when `d` falls inside business hours (in cfg.timezone). */
function isBusinessTime(d: Date, c: ResolvedConfig): boolean {
  const parts = getTzParts(d, c.timezone);
  if (parts.dow < c.workWeekStart || parts.dow > c.workWeekEnd) return false;
  if (parts.hour < c.startHour) return false;
  if (parts.hour >= c.endHour) return false;
  return true;
}

/**
 * Return (dayOfWeek 0–6, hour 0–23, minute 0–59) for `d` in `tz`.
 * Uses Intl.DateTimeFormat which is available everywhere we ship.
 */
function getTzParts(d: Date, tz: string): {
  dow: number;
  hour: number;
  minute: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(d);
  const wk = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hr = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const min = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // Intl returns "24" for midnight in some browsers; normalize.
  const hour = hr === 24 ? 0 : hr;
  const dowMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return { dow: dowMap[wk] ?? 1, hour, minute: min };
}

/**
 * Sweep from `start` to `end` accumulating only business-hour milliseconds.
 * Implementation note: walks one minute at a time. Cheap enough for the
 * tickets we handle (max ~7 days = ~10k iterations). Could be replaced with a
 * closed-form computation but the per-minute approach handles DST cleanly.
 */
export function businessMillisBetween(
  start: Date,
  end: Date,
  cfg: SlaConfig = {},
): number {
  const c = { ...DEFAULT_SLA_CONFIG, ...cfg };
  if (end.getTime() <= start.getTime()) return 0;
  const STEP_MS = 60_000;
  let acc = 0;
  let cursor = start.getTime();
  // Cap at 14 days to bound runtime.
  const cap = Math.min(end.getTime(), start.getTime() + 14 * 86_400_000);
  while (cursor < cap) {
    if (isBusinessTime(new Date(cursor), c)) acc += STEP_MS;
    cursor += STEP_MS;
  }
  return acc;
}

/**
 * Walk forward from `start` skipping non-business minutes until we have
 * accumulated `targetMs` business-hour milliseconds. Returns the wall-clock
 * Date when that budget elapses.
 */
export function addBusinessMillis(
  start: Date,
  targetMs: number,
  cfg: SlaConfig = {},
): Date {
  const c = { ...DEFAULT_SLA_CONFIG, ...cfg };
  if (targetMs <= 0) return start;
  const STEP_MS = 60_000;
  let acc = 0;
  let cursor = start.getTime();
  // Hard ceiling 30 days to avoid infinite loop in edge cases.
  const ceiling = start.getTime() + 30 * 86_400_000;
  while (acc < targetMs && cursor < ceiling) {
    cursor += STEP_MS;
    if (isBusinessTime(new Date(cursor), c)) acc += STEP_MS;
  }
  return new Date(cursor);
}
